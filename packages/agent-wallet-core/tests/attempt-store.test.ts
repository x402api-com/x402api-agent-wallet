import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttemptStore } from "../src/index.js";

const roots: string[] = [];
const digest = (byte: string) => `sha256:${byte.repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable payment attempt store", () => {
  it("persists one artifact for a request and detects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-attempt-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const store = new AttemptStore(join(root, "attempts"));
    const artifactPath = join(root, "artifacts", "payment.json");
    const saved = await store.persistAuthorized({
      requestDigest: digest("1"),
      challengeDigest: digest("2"),
      selectedRequirementDigest: digest("3"),
      buyerPaymentIdentifier: "buyer_0123456789abcdef",
      wallet: "primary",
      network: "eip155:8453",
      payerAddress: "0x1111111111111111111111111111111111111111",
      paymentSignature: "signed-payload",
      artifactPath,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(await store.findByRequestDigest(digest("1"))).toEqual(saved.record);
    expect((await store.readArtifact(saved.record.attemptId)).paymentSignature).toBe(
      "signed-payload",
    );
    await expect(
      store.persistAuthorized({
        requestDigest: digest("1"),
        challengeDigest: digest("2"),
        selectedRequirementDigest: digest("3"),
        buyerPaymentIdentifier: "buyer_fedcba9876543210",
        wallet: "primary",
        network: "eip155:8453",
        payerAddress: "0x1111111111111111111111111111111111111111",
        paymentSignature: "different-payload",
        artifactPath: join(root, "artifacts", "other.json"),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "attempt_already_exists" });

    const original = await readFile(artifactPath, "utf8");
    await writeFile(artifactPath, original.replace("signed-payload", "tampered-payload"), {
      mode: 0o600,
    });
    await expect(store.readArtifact(saved.record.attemptId)).rejects.toMatchObject({
      code: "payment_artifact_corrupt",
    });
  });

  it("tracks terminal state and active attempts independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-attempt-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const store = new AttemptStore(join(root, "attempts"));
    const saved = await store.persistAuthorized({
      requestDigest: digest("a"),
      challengeDigest: digest("b"),
      selectedRequirementDigest: digest("c"),
      buyerPaymentIdentifier: "buyer_0123456789abcdef",
      wallet: "primary",
      network: "tron:mainnet",
      payerAddress: "TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV",
      paymentSignature: "signed-payload",
      artifactPath: join(root, "artifacts", "payment.json"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await store.activeForWallet("primary")).toHaveLength(1);
    await store.updateState(saved.record.attemptId, "fulfilled");
    expect(await store.activeForWallet("primary")).toHaveLength(0);
  });

  it("persists monotonic settlement evidence without changing the v1 attempt record", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-attempt-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const attemptsDirectory = join(root, "attempts");
    const store = new AttemptStore(attemptsDirectory);
    const saved = await store.persistAuthorized({
      requestDigest: digest("4"),
      challengeDigest: digest("5"),
      selectedRequirementDigest: digest("6"),
      buyerPaymentIdentifier: "buyer_0123456789abcdef",
      wallet: "primary",
      network: "eip155:8453",
      payerAddress: "0x1111111111111111111111111111111111111111",
      paymentSignature: "signed-payload",
      artifactPath: join(root, "artifacts", "payment.json"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const paymentId = "01a069c8-77b9-75c7-946b-1858db8b8249";
    const transaction = `0x${"ab".repeat(32)}`;
    await store.recordSubmission({
      attemptId: saved.record.attemptId,
      state: "settled",
      httpStatus: 202,
      responseBody: new TextEncoder().encode('{"status":"payment_confirmed"}'),
      paymentId,
      settlement: {
        version: 1,
        paymentId,
        state: "confirmed",
        confirmed: true,
        finalized: false,
        transaction,
        network: "eip155:8453",
      },
    });

    const restarted = new AttemptStore(attemptsDirectory);
    expect(await restarted.getSettlement(saved.record.attemptId)).toMatchObject({
      version: 1,
      paymentId,
      state: "confirmed",
      confirmed: true,
      finalized: false,
      transaction,
      network: "eip155:8453",
    });
    const rawRecord = JSON.parse(
      await readFile(
        join(attemptsDirectory, "records", `${saved.record.attemptId}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(rawRecord.version).toBe(1);
    expect(rawRecord).not.toHaveProperty("settlement");

    await restarted.recordSubmission({
      attemptId: saved.record.attemptId,
      state: "fulfilled",
      httpStatus: 200,
      responseBody: new TextEncoder().encode('{"status":"ready"}'),
      paymentId,
      settlement: {
        version: 1,
        paymentId,
        state: "finalized",
        confirmed: true,
        finalized: true,
        transaction,
        network: "eip155:8453",
      },
    });
    expect(await restarted.getSettlement(saved.record.attemptId)).toMatchObject({
      state: "finalized",
      confirmed: true,
      finalized: true,
    });
    await expect(
      restarted.recordSubmission({
        attemptId: saved.record.attemptId,
        state: "fulfilled",
        httpStatus: 200,
        responseBody: new Uint8Array(),
        settlement: {
          version: 1,
          paymentId,
          state: "confirmed",
          confirmed: true,
          finalized: false,
          transaction,
          network: "eip155:8453",
        },
      }),
    ).rejects.toMatchObject({ code: "request_binding_mismatch" });
  });

  it("allows only explicit reconciliation after confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-attempt-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const store = new AttemptStore(join(root, "attempts"));
    const saved = await store.persistAuthorized({
      requestDigest: digest("7"),
      challengeDigest: digest("8"),
      selectedRequirementDigest: digest("9"),
      buyerPaymentIdentifier: "buyer_0123456789abcdef",
      wallet: "primary",
      network: "eip155:8453",
      payerAddress: "0x1111111111111111111111111111111111111111",
      paymentSignature: "signed-payload",
      artifactPath: join(root, "artifacts", "payment.json"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await store.recordSubmission({
      attemptId: saved.record.attemptId,
      state: "pending",
      httpStatus: 202,
      responseBody: new Uint8Array(),
      settlement: {
        version: 1,
        state: "confirmed",
        confirmed: true,
        finalized: false,
        transaction: `0x${"ab".repeat(32)}`,
        network: "eip155:8453",
      },
    });
    expect((await store.get(saved.record.attemptId)).state).toBe("pending");

    await expect(store.beginSubmission(saved.record.attemptId)).rejects.toMatchObject({
      code: "attempt_ambiguous",
      details: { action: "reconcile_existing_attempt" },
    });
    await expect(
      store.beginSubmission(
        saved.record.attemptId,
        "unexpected-mode" as "reconcile",
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
    });
    const reconciliation = await store.beginSubmission(
      saved.record.attemptId,
      "reconcile",
    );
    expect(reconciliation.record.state).toBe("settled");
    await reconciliation.release();
  });

  it("rejects malformed or contradictory settlement evidence before writing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-attempt-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const store = new AttemptStore(join(root, "attempts"));
    const saved = await store.persistAuthorized({
      requestDigest: digest("d"),
      challengeDigest: digest("e"),
      selectedRequirementDigest: digest("f"),
      buyerPaymentIdentifier: "buyer_0123456789abcdef",
      wallet: "primary",
      network: "eip155:8453",
      payerAddress: "0x1111111111111111111111111111111111111111",
      paymentSignature: "signed-payload",
      artifactPath: join(root, "artifacts", "payment.json"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const paymentId = "01a069c8-77b9-75c7-946b-1858db8b8249";
    const otherPaymentId = "01a069c8-77b9-75c7-946b-1858db8b8250";
    const validSettlement = {
      version: 1 as const,
      paymentId,
      state: "confirmed" as const,
      confirmed: true,
      finalized: false,
      transaction: `0x${"ab".repeat(32)}`,
      network: "eip155:8453",
    };

    await expect(
      store.recordSubmission({
        attemptId: saved.record.attemptId,
        state: "settled",
        httpStatus: 202,
        responseBody: new Uint8Array(),
        paymentId,
        settlement: { ...validSettlement, paymentId: otherPaymentId },
      }),
    ).rejects.toMatchObject({ code: "request_binding_mismatch" });
    await expect(
      store.recordSubmission({
        attemptId: saved.record.attemptId,
        state: "settled",
        httpStatus: 202,
        responseBody: new Uint8Array(),
        paymentId,
        settlement: { ...validSettlement, network: "solana:mainnet" },
      }),
    ).rejects.toMatchObject({ code: "request_binding_mismatch" });
    await expect(
      store.recordSubmission({
        attemptId: saved.record.attemptId,
        state: "settled",
        httpStatus: 202,
        responseBody: new Uint8Array(),
        paymentId,
        settlement: { ...validSettlement, transaction: "bad transaction" },
      }),
    ).rejects.toMatchObject({ code: "request_binding_mismatch" });

    expect(await store.getSettlement(saved.record.attemptId)).toBeNull();
    expect(await store.get(saved.record.attemptId)).not.toHaveProperty(
      "lastResponseEvidencePath",
    );
  });

  it("treats durable sidecars as authoritative when the base record is stale", async () => {
    for (const state of ["reorged", "reverted"] as const) {
      const root = await mkdtemp(join(tmpdir(), "x402api-attempt-test-"));
      await chmod(root, 0o700);
      roots.push(root);
      const attemptsDirectory = join(root, "attempts");
      const store = new AttemptStore(attemptsDirectory);
      const saved = await store.persistAuthorized({
        requestDigest: digest(state === "reorged" ? "1" : "2"),
        challengeDigest: digest(state === "reorged" ? "3" : "4"),
        selectedRequirementDigest: digest(state === "reorged" ? "5" : "6"),
        buyerPaymentIdentifier: `buyer_${state}_0123456789`,
        wallet: "primary",
        network: "eip155:8453",
        payerAddress: "0x1111111111111111111111111111111111111111",
        paymentSignature: "signed-payload",
        artifactPath: join(root, "artifacts", `${state}.json`),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await writeFile(
        join(attemptsDirectory, "settlements", `${saved.record.attemptId}.json`),
        `${JSON.stringify({
          version: 1,
          state,
          confirmed: false,
          finalized: false,
          transaction: `0x${"ab".repeat(32)}`,
          network: "eip155:8453",
          updatedAt: new Date().toISOString(),
        })}\n`,
        { mode: 0o600 },
      );

      await expect(store.beginSubmission(saved.record.attemptId)).rejects.toMatchObject({
        code: "settlement_invalidated",
        retryable: false,
        details: { action: "merchant_compensation_required" },
      });
      await expect(
        store.beginSubmission(saved.record.attemptId, "reconcile"),
      ).rejects.toMatchObject({ code: "settlement_invalidated" });
      await expect(store.abandon(saved.record.attemptId)).rejects.toMatchObject({
        code: "settlement_invalidated",
      });
      expect((await store.get(saved.record.attemptId)).state).toBe("authorized");
    }
  });

  it("cannot abandon a confirmed sidecar when the base record is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-attempt-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const attemptsDirectory = join(root, "attempts");
    const store = new AttemptStore(attemptsDirectory);
    const saved = await store.persistAuthorized({
      requestDigest: digest("7"),
      challengeDigest: digest("8"),
      selectedRequirementDigest: digest("9"),
      buyerPaymentIdentifier: "buyer_confirmed_0123456789",
      wallet: "primary",
      network: "solana:mainnet",
      payerAddress: "7YpE3MH6KztUcEhDki9kugF7a5mDPywcQ2K9tT2sXv3A",
      paymentSignature: "signed-payload",
      artifactPath: join(root, "artifacts", "confirmed.json"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await writeFile(
      join(attemptsDirectory, "settlements", `${saved.record.attemptId}.json`),
      `${JSON.stringify({
        version: 1,
        state: "confirmed",
        confirmed: true,
        finalized: false,
        transaction: "5HueCGU8rMjxEXxiPuD5BDuRaNfQZ4xWZgB8XyL6uR9p",
        network: "solana:mainnet",
        updatedAt: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );

    await expect(store.abandon(saved.record.attemptId)).rejects.toMatchObject({
      code: "attempt_ambiguous",
      details: { action: "reconcile_existing_attempt" },
    });
    expect((await store.get(saved.record.attemptId)).state).toBe("authorized");
  });
});
