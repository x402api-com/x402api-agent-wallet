import { AgentWalletError, type AgentWalletErrorCode } from "../errors.js";
import {
  decodePaymentResponseHeader,
  type PaymentResponse,
} from "../protocol/http.js";
import { AttemptStore, type AttemptState } from "./attempt-store.js";
import { loadRequestEnvelope } from "./contracts.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,127}$/;
const RETRYABLE_SPONSORSHIP_ERRORS = new Set<AgentWalletErrorCode>([
  "gas_sponsorship_unavailable",
  "gas_treasury_below_floor",
  "tenant_gas_credit_insufficient",
  "sponsor_signature_unavailable",
]);
const TERMINAL_SPONSORSHIP_ERRORS = new Set<AgentWalletErrorCode>([
  "sponsorship_reservation_expired",
  "sponsored_payload_invalid",
]);

export type SubmissionResult = {
  version: 1;
  attemptId: string;
  state: Extract<AttemptState, "settled" | "fulfilled">;
  httpStatus: number;
  responseDigest: string;
  responseEvidencePath: string;
  responseBodyPath?: string;
  transaction?: string;
  network?: string;
};

async function boundedResponseBody(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(contentLength) ||
      BigInt(contentLength) > BigInt(MAX_RESPONSE_BYTES))
  ) {
    await response.body?.cancel();
    throw new AgentWalletError(
      "settlement_outcome_unknown",
      "paid response exceeds the supported size bound",
      { retryable: true },
    );
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AgentWalletError(
          "settlement_outcome_unknown",
          "paid response exceeds the supported size bound",
          { retryable: true },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function responseErrorCode(body: Uint8Array): string | undefined {
  if (body.byteLength === 0) return undefined;
  try {
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    ) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return undefined;
    const error = (parsed as Record<string, unknown>).error;
    if (typeof error !== "object" || error === null || Array.isArray(error))
      return undefined;
    const code = (error as Record<string, unknown>).code;
    return typeof code === "string" && ERROR_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (value === null || !/^(?:0|[1-9][0-9]{0,5})$/.test(value))
    return undefined;
  return Number(value);
}

function sponsorshipCode(
  value: string | undefined,
): AgentWalletErrorCode | undefined {
  if (value === undefined) return undefined;
  const codes: AgentWalletErrorCode[] = [
    ...RETRYABLE_SPONSORSHIP_ERRORS,
    ...TERMINAL_SPONSORSHIP_ERRORS,
  ];
  return codes.find((code) => code === value);
}

export async function submitAuthorizedPayment(options: {
  attemptsDirectory: string;
  attemptId: string;
  requestEnvelopePath: string;
  fetchImplementation?: typeof fetch;
  now?: Date;
  timeoutMilliseconds?: number;
}): Promise<SubmissionResult> {
  const store = new AttemptStore(options.attemptsDirectory);
  const snapshot = await store.get(options.attemptId);
  const artifact = await store.readArtifact(options.attemptId);
  const loaded = await loadRequestEnvelope(options.requestEnvelopePath);
  if (
    loaded.requestDigest !== snapshot.requestDigest ||
    artifact.requestDigest !== snapshot.requestDigest
  ) {
    throw new AgentWalletError(
      "request_binding_mismatch",
      "request envelope does not match the authorized payment attempt",
    );
  }
  const now = options.now ?? new Date();
  const timeoutMilliseconds = options.timeoutMilliseconds ?? 30_000;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > 60_000
  ) {
    throw new AgentWalletError(
      "invalid_input",
      "payment submission timeout must be between 1000 and 60000 milliseconds",
    );
  }
  const submission = await store.beginSubmission(snapshot.attemptId);
  const record = submission.record;
  try {
    if (
      record.state === "authorized" &&
      Date.parse(artifact.expiresAt) <= now.getTime()
    ) {
      await store.updateState(record.attemptId, "terminal_failed");
      throw new AgentWalletError(
        "sponsorship_reservation_expired",
        "the authorized sponsorship reservation expired before submission",
      );
    }
    const ambiguousState = record.state === "settled" ? "settled" : "pending";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMilliseconds);
    let response: Response;
    try {
      response = await (options.fetchImplementation ?? fetch)(
        loaded.envelope.url,
        {
          method: loaded.envelope.method,
          headers: {
            Accept: "application/json",
            "Content-Type": loaded.envelope.contentType,
            "PAYMENT-SIGNATURE": artifact.paymentSignature,
          },
          ...(loaded.envelope.method === "GET"
            ? {}
            : { body: Buffer.from(loaded.body) }),
          cache: "no-store",
          redirect: "manual",
          signal: controller.signal,
        },
      );
    } catch (error) {
      await store.updateState(record.attemptId, ambiguousState);
      throw new AgentWalletError(
        "settlement_outcome_unknown",
        "payment submission failed after the exact attempt entered submitting state",
        {
          retryable: true,
          details: {
            attemptId: record.attemptId,
            action: "retry_exact_payment_request",
          },
          cause: error,
        },
      );
    } finally {
      clearTimeout(timeout);
    }

    let responseBody: Uint8Array;
    try {
      responseBody = await boundedResponseBody(response);
    } catch (error) {
      await store.updateState(record.attemptId, ambiguousState);
      throw error;
    }
    const encodedPaymentResponse =
      response.headers.get("payment-response") ?? undefined;
    let paymentResponse: PaymentResponse | undefined;
    if (encodedPaymentResponse !== undefined) {
      try {
        paymentResponse = decodePaymentResponseHeader(encodedPaymentResponse);
      } catch (error) {
        const updated = await store.recordSubmission({
          attemptId: record.attemptId,
          state: ambiguousState,
          httpStatus: response.status,
          responseBody,
          paymentResponse: encodedPaymentResponse,
          errorCode: "request_binding_mismatch",
        });
        throw new AgentWalletError(
          "request_binding_mismatch",
          "merchant returned a malformed PAYMENT-RESPONSE",
          {
            details: {
              attemptId: record.attemptId,
              responseEvidencePath: updated.lastResponseEvidencePath,
            },
            cause: error,
          },
        );
      }
    }
    const errorCode =
      paymentResponse?.errorReason ?? responseErrorCode(responseBody);
    const common = {
      attemptId: record.attemptId,
      httpStatus: response.status,
      responseBody,
      ...(encodedPaymentResponse === undefined
        ? {}
        : { paymentResponse: encodedPaymentResponse }),
      ...(errorCode === undefined ? {} : { errorCode }),
    };

    if (
      response.status >= 200 &&
      response.status < 300 &&
      response.status !== 202 &&
      paymentResponse?.success === true
    ) {
      const updated = await store.recordSubmission({
        ...common,
        state: "fulfilled",
      });
      return {
        version: 1,
        attemptId: record.attemptId,
        state: "fulfilled",
        httpStatus: response.status,
        responseDigest: updated.lastResponseDigest!,
        responseEvidencePath: updated.lastResponseEvidencePath!,
        ...(updated.lastResponseBodyPath === undefined
          ? {}
          : { responseBodyPath: updated.lastResponseBodyPath }),
        ...(paymentResponse.transaction.length === 0
          ? {}
          : { transaction: paymentResponse.transaction }),
        ...(paymentResponse.network.length === 0
          ? {}
          : { network: paymentResponse.network }),
      };
    }

    if (paymentResponse?.success === true) {
      const updated = await store.recordSubmission({
        ...common,
        state: "settled",
      });
      throw new AgentWalletError(
        "settlement_outcome_unknown",
        "payment settled but fulfillment requires reconciliation",
        {
          retryable: true,
          details: {
            attemptId: record.attemptId,
            httpStatus: response.status,
            responseEvidencePath: updated.lastResponseEvidencePath,
            responseBodyPath: updated.lastResponseBodyPath,
            action: "reconcile_existing_attempt",
          },
        },
      );
    }

    if (response.status === 402) {
      if (record.state === "settled") {
        const updated = await store.recordSubmission({
          ...common,
          state: "settled",
        });
        throw new AgentWalletError(
          "settlement_outcome_unknown",
          "a previously settled payment returned a conflicting replay response",
          {
            details: {
              attemptId: record.attemptId,
              httpStatus: response.status,
              responseEvidencePath: updated.lastResponseEvidencePath,
            },
          },
        );
      }
      if (["submitting", "pending"].includes(record.state)) {
        const updated = await store.recordSubmission({
          ...common,
          state: "pending",
        });
        throw new AgentWalletError(
          "settlement_outcome_unknown",
          "a prior ambiguous submission prevents treating this replay rejection as terminal",
          {
            details: {
              attemptId: record.attemptId,
              httpStatus: response.status,
              responseEvidencePath: updated.lastResponseEvidencePath,
              action: "reconcile_existing_attempt",
            },
          },
        );
      }
      const sponsorError = sponsorshipCode(errorCode);
      const terminal =
        sponsorError !== undefined &&
        TERMINAL_SPONSORSHIP_ERRORS.has(sponsorError);
      const updated = await store.recordSubmission({
        ...common,
        state:
          terminal || sponsorError === undefined
            ? "terminal_failed"
            : "authorized",
      });
      if (sponsorError !== undefined) {
        throw new AgentWalletError(
          sponsorError,
          `payment sponsorship was rejected: ${sponsorError}`,
          {
            retryable: RETRYABLE_SPONSORSHIP_ERRORS.has(sponsorError),
            details: {
              attemptId: record.attemptId,
              httpStatus: response.status,
              responseEvidencePath: updated.lastResponseEvidencePath,
            },
          },
        );
      }
      throw new AgentWalletError(
        "unsupported_payment_profile",
        "merchant definitively rejected the authorized payment",
        {
          details: {
            attemptId: record.attemptId,
            httpStatus: response.status,
            responseEvidencePath: updated.lastResponseEvidencePath,
            errorCode,
          },
        },
      );
    }

    const updated = await store.recordSubmission({
      ...common,
      state: ambiguousState,
    });
    throw new AgentWalletError(
      "settlement_outcome_unknown",
      "payment or fulfillment outcome is not terminal; retry the exact attempt",
      {
        retryable: true,
        details: {
          attemptId: record.attemptId,
          httpStatus: response.status,
          responseEvidencePath: updated.lastResponseEvidencePath,
          responseBodyPath: updated.lastResponseBodyPath,
          retryAfterSeconds: retryAfterSeconds(response),
          action: "retry_exact_payment_request",
        },
      },
    );
  } finally {
    await submission.release();
  }
}
