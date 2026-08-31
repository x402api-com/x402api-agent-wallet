import { randomUUID } from "node:crypto";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

import { AgentWalletError } from "../errors.js";
import {
  atomicWritePrivate,
  ensurePrivateDirectory,
  readPrivateFile,
} from "../storage/private-files.js";
import { digestBytes, type PaymentArtifact } from "./contracts.js";

export type AttemptState =
  | "authorized"
  | "submitting"
  | "pending"
  | "settled"
  | "fulfilled"
  | "terminal_failed"
  | "abandoned_local";

export type AttemptRecord = {
  version: 1;
  attemptId: string;
  requestDigest: string;
  challengeDigest: string;
  selectedRequirementDigest: string;
  buyerPaymentIdentifier: string;
  paymentArtifactDigest: string;
  artifactPath: string;
  wallet: string;
  network: string;
  state: AttemptState;
  createdAt: string;
  updatedAt: string;
  lastHttpStatus?: number;
  lastResponseDigest?: string;
  lastResponseEvidencePath?: string;
  lastResponseBodyPath?: string;
  lastPaymentResponseDigest?: string;
  lastErrorCode?: string;
  lastPaymentId?: string;
};

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{16,128}$/;
const STATES = new Set<AttemptState>([
  "authorized",
  "submitting",
  "pending",
  "settled",
  "fulfilled",
  "terminal_failed",
  "abandoned_local",
]);

function parseRecord(value: unknown): AttemptRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentWalletError(
      "payment_artifact_corrupt",
      "attempt record is malformed",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "version",
    "attemptId",
    "requestDigest",
    "challengeDigest",
    "selectedRequirementDigest",
    "buyerPaymentIdentifier",
    "paymentArtifactDigest",
    "artifactPath",
    "wallet",
    "network",
    "state",
    "createdAt",
    "updatedAt",
    "lastHttpStatus",
    "lastResponseDigest",
    "lastResponseEvidencePath",
    "lastResponseBodyPath",
    "lastPaymentResponseDigest",
    "lastErrorCode",
    "lastPaymentId",
  ];
  if (
    Object.keys(record).some((key) => !keys.includes(key)) ||
    record.version !== 1 ||
    typeof record.attemptId !== "string" ||
    typeof record.requestDigest !== "string" ||
    !SHA256.test(record.requestDigest) ||
    typeof record.challengeDigest !== "string" ||
    !SHA256.test(record.challengeDigest) ||
    typeof record.selectedRequirementDigest !== "string" ||
    !SHA256.test(record.selectedRequirementDigest) ||
    typeof record.buyerPaymentIdentifier !== "string" ||
    !IDENTIFIER.test(record.buyerPaymentIdentifier) ||
    typeof record.paymentArtifactDigest !== "string" ||
    !SHA256.test(record.paymentArtifactDigest) ||
    typeof record.artifactPath !== "string" ||
    !record.artifactPath.startsWith("/") ||
    typeof record.wallet !== "string" ||
    typeof record.network !== "string" ||
    typeof record.state !== "string" ||
    !STATES.has(record.state as AttemptState) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt)) ||
    typeof record.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(record.updatedAt)) ||
    (record.lastHttpStatus !== undefined &&
      (!Number.isSafeInteger(record.lastHttpStatus) ||
        (record.lastHttpStatus as number) < 100 ||
        (record.lastHttpStatus as number) > 599)) ||
    (record.lastResponseDigest !== undefined &&
      (typeof record.lastResponseDigest !== "string" ||
        !SHA256.test(record.lastResponseDigest))) ||
    (record.lastResponseEvidencePath !== undefined &&
      (typeof record.lastResponseEvidencePath !== "string" ||
        !record.lastResponseEvidencePath.startsWith("/"))) ||
    (record.lastResponseBodyPath !== undefined &&
      (typeof record.lastResponseBodyPath !== "string" ||
        !record.lastResponseBodyPath.startsWith("/"))) ||
    (record.lastPaymentResponseDigest !== undefined &&
      (typeof record.lastPaymentResponseDigest !== "string" ||
        !SHA256.test(record.lastPaymentResponseDigest))) ||
    (record.lastErrorCode !== undefined &&
      (typeof record.lastErrorCode !== "string" ||
        record.lastErrorCode.length < 1 ||
        record.lastErrorCode.length > 128)) ||
    (record.lastPaymentId !== undefined &&
      (typeof record.lastPaymentId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          record.lastPaymentId,
        )))
  ) {
    throw new AgentWalletError(
      "payment_artifact_corrupt",
      "attempt record failed validation",
    );
  }
  return record as AttemptRecord;
}

function parseArtifact(value: unknown): PaymentArtifact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentWalletError(
      "payment_artifact_corrupt",
      "payment artifact is malformed",
    );
  }
  const artifact = value as Record<string, unknown>;
  const keys = [
    "version",
    "attemptId",
    "requestDigest",
    "buyerPaymentIdentifier",
    "wallet",
    "payerAddress",
    "selectedRequirementDigest",
    "paymentSignature",
    "createdAt",
    "expiresAt",
  ];
  if (
    Object.keys(artifact).some((key) => !keys.includes(key)) ||
    artifact.version !== 1 ||
    typeof artifact.attemptId !== "string" ||
    typeof artifact.requestDigest !== "string" ||
    !SHA256.test(artifact.requestDigest) ||
    typeof artifact.buyerPaymentIdentifier !== "string" ||
    !IDENTIFIER.test(artifact.buyerPaymentIdentifier) ||
    typeof artifact.wallet !== "string" ||
    typeof artifact.payerAddress !== "string" ||
    typeof artifact.selectedRequirementDigest !== "string" ||
    !SHA256.test(artifact.selectedRequirementDigest) ||
    typeof artifact.paymentSignature !== "string" ||
    artifact.paymentSignature.length < 1 ||
    artifact.paymentSignature.length > 512 * 1024 ||
    typeof artifact.createdAt !== "string" ||
    !Number.isFinite(Date.parse(artifact.createdAt)) ||
    typeof artifact.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(artifact.expiresAt))
  ) {
    throw new AgentWalletError(
      "payment_artifact_corrupt",
      "payment artifact failed validation",
    );
  }
  return artifact as PaymentArtifact;
}

export class AttemptStore {
  readonly root: string;
  readonly records: string;
  readonly indexes: string;
  readonly locks: string;
  readonly responses: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.records = join(this.root, "records");
    this.indexes = join(this.root, "request-index");
    this.locks = join(this.root, "locks");
    this.responses = join(this.root, "responses");
  }

  async initialize(): Promise<void> {
    await Promise.all([
      ensurePrivateDirectory(this.records),
      ensurePrivateDirectory(this.indexes),
      ensurePrivateDirectory(this.locks),
      ensurePrivateDirectory(this.responses),
    ]);
  }

  private digestName(digest: string): string {
    if (!SHA256.test(digest)) {
      throw new AgentWalletError(
        "invalid_input",
        "request digest is malformed",
      );
    }
    return digest.slice("sha256:".length);
  }

  private async acquire(requestDigest: string): Promise<() => Promise<void>> {
    await this.initialize();
    const path = join(this.locks, `${this.digestName(requestDigest)}.lock`);
    const create = async () => {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      );
      await handle.sync();
      await handle.close();
    };
    try {
      await create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new AgentWalletError(
          "wallet_storage_unsafe",
          "attempt lock is unsafe",
        );
      }
      if (Date.now() - stat.mtimeMs <= 120_000) {
        throw new AgentWalletError(
          "attempt_already_exists",
          "another payment operation is already active for this request",
          { retryable: true },
        );
      }
      await unlink(path);
      await create();
    }
    return async () => unlink(path).catch(() => undefined);
  }

  async findByRequestDigest(
    requestDigest: string,
  ): Promise<AttemptRecord | null> {
    await this.initialize();
    const indexPath = join(
      this.indexes,
      `${this.digestName(requestDigest)}.json`,
    );
    let index: unknown;
    try {
      index = JSON.parse((await readPrivateFile(indexPath)).toString("utf8"));
    } catch (error) {
      if (
        error instanceof AgentWalletError &&
        error.code === "wallet_not_found"
      )
        return null;
      throw new AgentWalletError(
        "payment_artifact_corrupt",
        "attempt index is corrupt",
        {
          cause: error,
        },
      );
    }
    if (
      typeof index !== "object" ||
      index === null ||
      Array.isArray(index) ||
      Object.keys(index).sort().join(",") !== "attemptId,version" ||
      (index as Record<string, unknown>).version !== 1 ||
      typeof (index as Record<string, unknown>).attemptId !== "string"
    ) {
      throw new AgentWalletError(
        "payment_artifact_corrupt",
        "attempt index failed validation",
      );
    }
    return this.get((index as { attemptId: string }).attemptId);
  }

  async persistAuthorized(options: {
    requestDigest: string;
    challengeDigest: string;
    selectedRequirementDigest: string;
    buyerPaymentIdentifier: string;
    wallet: string;
    network: string;
    payerAddress: string;
    paymentSignature: string;
    artifactPath: string;
    expiresAt: string;
  }): Promise<{ record: AttemptRecord; artifact: PaymentArtifact }> {
    const release = await this.acquire(options.requestDigest);
    try {
      const existing = await this.findByRequestDigest(options.requestDigest);
      if (
        existing !== null &&
        !["terminal_failed", "abandoned_local"].includes(existing.state)
      ) {
        throw new AgentWalletError(
          "attempt_already_exists",
          "a live payment attempt already exists for this exact request",
          { details: { attemptId: existing.attemptId, state: existing.state } },
        );
      }
      const attemptId = randomUUID();
      const createdAt = new Date().toISOString();
      const artifact: PaymentArtifact = {
        version: 1,
        attemptId,
        requestDigest: options.requestDigest,
        buyerPaymentIdentifier: options.buyerPaymentIdentifier,
        wallet: options.wallet,
        payerAddress: options.payerAddress,
        selectedRequirementDigest: options.selectedRequirementDigest,
        paymentSignature: options.paymentSignature,
        createdAt,
        expiresAt: options.expiresAt,
      };
      const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
      const artifactPath = resolve(options.artifactPath);
      await atomicWritePrivate(artifactPath, artifactText, {
        existsCode: "attempt_already_exists",
      });
      const record: AttemptRecord = {
        version: 1,
        attemptId,
        requestDigest: options.requestDigest,
        challengeDigest: options.challengeDigest,
        selectedRequirementDigest: options.selectedRequirementDigest,
        buyerPaymentIdentifier: options.buyerPaymentIdentifier,
        paymentArtifactDigest: digestBytes(artifactText),
        artifactPath,
        wallet: options.wallet,
        network: options.network,
        state: "authorized",
        createdAt,
        updatedAt: createdAt,
      };
      await atomicWritePrivate(
        join(this.records, `${attemptId}.json`),
        `${JSON.stringify(record, null, 2)}\n`,
      );
      await atomicWritePrivate(
        join(this.indexes, `${this.digestName(options.requestDigest)}.json`),
        `${JSON.stringify({ version: 1, attemptId }, null, 2)}\n`,
        { overwrite: existing !== null, existsCode: "attempt_already_exists" },
      );
      return { record, artifact };
    } finally {
      await release();
    }
  }

  async get(attemptId: string): Promise<AttemptRecord> {
    if (!/^[0-9a-f-]{36}$/.test(attemptId)) {
      throw new AgentWalletError("invalid_input", "attempt ID is malformed");
    }
    try {
      return parseRecord(
        JSON.parse(
          (
            await readPrivateFile(join(this.records, `${attemptId}.json`))
          ).toString("utf8"),
        ),
      );
    } catch (error) {
      if (
        error instanceof AgentWalletError &&
        error.code === "wallet_not_found"
      ) {
        throw new AgentWalletError(
          "attempt_not_found",
          `attempt not found: ${attemptId}`,
        );
      }
      throw error;
    }
  }

  async readArtifact(attemptId: string): Promise<PaymentArtifact> {
    const record = await this.get(attemptId);
    const bytes = await readPrivateFile(record.artifactPath, 1024 * 1024);
    if (digestBytes(bytes) !== record.paymentArtifactDigest) {
      throw new AgentWalletError(
        "payment_artifact_corrupt",
        "payment artifact digest does not match",
      );
    }
    const artifact = parseArtifact(JSON.parse(bytes.toString("utf8")));
    if (
      artifact.attemptId !== record.attemptId ||
      artifact.requestDigest !== record.requestDigest ||
      artifact.selectedRequirementDigest !== record.selectedRequirementDigest
    ) {
      throw new AgentWalletError(
        "payment_artifact_corrupt",
        "payment artifact does not match attempt",
      );
    }
    return artifact;
  }

  async copyArtifact(attemptId: string, output: string): Promise<string> {
    const record = await this.get(attemptId);
    await this.readArtifact(attemptId);
    await atomicWritePrivate(
      resolve(output),
      await readPrivateFile(record.artifactPath, 1024 * 1024),
    );
    return resolve(output);
  }

  async updateState(
    attemptId: string,
    state: AttemptState,
  ): Promise<AttemptRecord> {
    if (!STATES.has(state)) {
      throw new AgentWalletError("invalid_input", "attempt state is invalid");
    }
    const record = await this.get(attemptId);
    const updated: AttemptRecord = {
      ...record,
      state,
      updatedAt: new Date().toISOString(),
    };
    await atomicWritePrivate(
      join(this.records, `${attemptId}.json`),
      `${JSON.stringify(updated, null, 2)}\n`,
      { overwrite: true },
    );
    return updated;
  }

  async beginSubmission(attemptId: string): Promise<{
    record: AttemptRecord;
    release: () => Promise<void>;
  }> {
    const snapshot = await this.get(attemptId);
    const release = await this.acquire(snapshot.requestDigest);
    try {
      const record = await this.get(attemptId);
      if (
        ["fulfilled", "terminal_failed", "abandoned_local"].includes(
          record.state,
        )
      ) {
        throw new AgentWalletError(
          "invalid_input",
          `cannot submit an attempt in ${record.state}`,
        );
      }
      if (record.state !== "settled") {
        await this.updateState(attemptId, "submitting");
      }
      return { record, release };
    } catch (error) {
      await release();
      throw error;
    }
  }

  async abandon(attemptId: string): Promise<AttemptRecord> {
    const snapshot = await this.get(attemptId);
    const release = await this.acquire(snapshot.requestDigest);
    try {
      const current = await this.get(attemptId);
      if (["settled", "fulfilled", "terminal_failed"].includes(current.state)) {
        throw new AgentWalletError(
          "invalid_input",
          `cannot abandon attempt in ${current.state}`,
        );
      }
      return this.updateState(attemptId, "abandoned_local");
    } finally {
      await release();
    }
  }

  async recordSubmission(options: {
    attemptId: string;
    state: Extract<
      AttemptState,
      "authorized" | "pending" | "settled" | "fulfilled" | "terminal_failed"
    >;
    httpStatus: number;
    responseBody: Uint8Array;
    paymentResponse?: string;
    errorCode?: string;
    paymentId?: string;
  }): Promise<AttemptRecord> {
    if (
      !Number.isSafeInteger(options.httpStatus) ||
      options.httpStatus < 100 ||
      options.httpStatus > 599
    ) {
      throw new AgentWalletError("invalid_input", "HTTP status is invalid");
    }
    if (
      options.paymentId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        options.paymentId,
      )
    ) {
      throw new AgentWalletError("invalid_input", "payment ID is invalid");
    }
    await this.initialize();
    const current = await this.get(options.attemptId);
    if (
      current.lastPaymentId !== undefined &&
      options.paymentId !== undefined &&
      current.lastPaymentId !== options.paymentId
    ) {
      throw new AgentWalletError(
        "request_binding_mismatch",
        "merchant changed the durable payment ID for an exact payment attempt",
      );
    }
    const responseId = randomUUID();
    const responseDigest = digestBytes(options.responseBody);
    const responseBodyPath =
      options.responseBody.byteLength === 0
        ? undefined
        : join(this.responses, `${options.attemptId}.${responseId}.body`);
    if (responseBodyPath !== undefined) {
      await atomicWritePrivate(responseBodyPath, options.responseBody);
    }
    const paymentResponseDigest =
      options.paymentResponse === undefined
        ? undefined
        : digestBytes(options.paymentResponse);
    const evidencePath = join(
      this.responses,
      `${options.attemptId}.${responseId}.json`,
    );
    await atomicWritePrivate(
      evidencePath,
      `${JSON.stringify(
        {
          version: 1,
          attemptId: options.attemptId,
          observedAt: new Date().toISOString(),
          httpStatus: options.httpStatus,
          responseDigest,
          responseBodyPath: responseBodyPath ?? null,
          paymentResponse: options.paymentResponse ?? null,
          paymentResponseDigest: paymentResponseDigest ?? null,
          errorCode: options.errorCode ?? null,
          paymentId: options.paymentId ?? null,
          state: options.state,
        },
        null,
        2,
      )}\n`,
    );
    const updated: AttemptRecord = {
      ...current,
      state: options.state,
      updatedAt: new Date().toISOString(),
      lastHttpStatus: options.httpStatus,
      lastResponseDigest: responseDigest,
      lastResponseEvidencePath: evidencePath,
    };
    delete updated.lastResponseBodyPath;
    delete updated.lastPaymentResponseDigest;
    delete updated.lastErrorCode;
    if (responseBodyPath !== undefined) {
      updated.lastResponseBodyPath = responseBodyPath;
    }
    if (paymentResponseDigest !== undefined) {
      updated.lastPaymentResponseDigest = paymentResponseDigest;
    }
    if (options.errorCode !== undefined) {
      updated.lastErrorCode = options.errorCode;
    }
    if (options.paymentId !== undefined) {
      updated.lastPaymentId = options.paymentId;
    }
    await atomicWritePrivate(
      join(this.records, `${options.attemptId}.json`),
      `${JSON.stringify(updated, null, 2)}\n`,
      { overwrite: true },
    );
    return updated;
  }

  async activeForWallet(wallet: string): Promise<AttemptRecord[]> {
    await this.initialize();
    const files = (await readdir(this.records)).filter((file) =>
      file.endsWith(".json"),
    );
    const records = await Promise.all(
      files.map(async (file) =>
        parseRecord(
          JSON.parse(
            (await readPrivateFile(join(this.records, file))).toString("utf8"),
          ),
        ),
      ),
    );
    return records.filter(
      (record) =>
        record.wallet === wallet &&
        !["fulfilled", "terminal_failed", "abandoned_local"].includes(
          record.state,
        ),
    );
  }
}
