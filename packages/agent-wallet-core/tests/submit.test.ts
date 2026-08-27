import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttemptStore,
  encodePaymentRequiredHeader,
  loadRequestEnvelope,
  submitAuthorizedPayment,
  type PaymentRequired,
  type PaymentResponse,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

function paymentResponse(value: PaymentResponse): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function fixture(expiresAt = "2026-08-22T20:05:00.000Z") {
  const root = await mkdtemp(join(tmpdir(), "x402api-submit-test-"));
  roots.push(root);
  await chmod(root, 0o700);
  const attemptsDirectory = join(root, "attempts");
  const artifactPath = join(root, "artifacts", "payment.json");
  const requestEnvelopePath = join(root, "request.json");
  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    resource: { url: "https://merchant.example/paid" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "100000",
        asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        payTo: "0x1111111111111111111111111111111111111111",
        maxTimeoutSeconds: 180,
        extra: {
          assetTransferMethod: "eip3009",
          name: "USD Coin",
          version: "2",
          payloadProfile: "com.x402api.x402.base-usdc-eip3009-sponsored.v1",
        },
      },
    ],
  };
  await writeFile(
    requestEnvelopePath,
    `${JSON.stringify({
      version: 1,
      method: "POST",
      url: paymentRequired.resource.url,
      contentType: "application/json",
      bodyBase64: Buffer.from('{"sku":"report"}').toString("base64"),
      paymentRequired: encodePaymentRequiredHeader(paymentRequired),
      challengeDigest: `sha256:${"6".repeat(64)}`,
    })}\n`,
    { mode: 0o600 },
  );
  const loaded = await loadRequestEnvelope(requestEnvelopePath);
  const store = new AttemptStore(attemptsDirectory);
  const { record, artifact } = await store.persistAuthorized({
    requestDigest: loaded.requestDigest,
    challengeDigest: loaded.envelope.challengeDigest,
    selectedRequirementDigest: `sha256:${"7".repeat(64)}`,
    buyerPaymentIdentifier: "buyer-payment-0001",
    wallet: "buyer",
    network: "eip155:8453",
    payerAddress: "0x2222222222222222222222222222222222222222",
    paymentSignature: Buffer.from('{"signed":true}').toString("base64"),
    artifactPath,
    expiresAt,
  });
  return {
    root,
    attemptsDirectory,
    artifactPath,
    requestEnvelopePath,
    store,
    record,
    artifact,
  };
}

describe("exact paid request submission", () => {
  it("submits the frozen request once and stores fulfilled output privately", async () => {
    const state = await fixture();
    const responseHeader = paymentResponse({
      success: true,
      transaction: "0xabc",
      network: "eip155:8453",
    });
    const fetchImplementation = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://merchant.example/paid");
        expect(init).toMatchObject({
          method: "POST",
          cache: "no-store",
          redirect: "manual",
        });
        expect(new Headers(init?.headers).get("PAYMENT-SIGNATURE")).toBe(
          state.artifact.paymentSignature,
        );
        expect(Buffer.from(init?.body as Buffer).toString("utf8")).toBe(
          '{"sku":"report"}',
        );
        return new Response('{"download":"ready"}', {
          status: 200,
          headers: { "PAYMENT-RESPONSE": responseHeader },
        });
      },
    );

    const result = await submitAuthorizedPayment({
      attemptsDirectory: state.attemptsDirectory,
      attemptId: state.record.attemptId,
      requestEnvelopePath: state.requestEnvelopePath,
      fetchImplementation,
      now: new Date("2026-08-22T20:01:00.000Z"),
    });

    expect(result).toMatchObject({
      state: "fulfilled",
      httpStatus: 200,
      transaction: "0xabc",
      network: "eip155:8453",
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(await readFile(result.responseBodyPath!, "utf8")).toBe(
      '{"download":"ready"}',
    );
    expect((await state.store.get(state.record.attemptId)).state).toBe(
      "fulfilled",
    );
  });

  it("preserves a pending attempt and reuses the exact signature", async () => {
    const state = await fixture();
    const seenSignatures: string[] = [];
    const fetchImplementation = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async (_url, init) => {
        seenSignatures.push(
          new Headers(init?.headers).get("PAYMENT-SIGNATURE")!,
        );
        return new Response('{"status":"payment_pending"}', {
          status: 202,
          headers: {
            "PAYMENT-RESPONSE": paymentResponse({
              success: false,
              errorReason: "settlement_pending",
              transaction: "0xabc",
              network: "eip155:8453",
            }),
            "Retry-After": "2",
          },
        });
      })
      .mockImplementationOnce(async (_url, init) => {
        seenSignatures.push(
          new Headers(init?.headers).get("PAYMENT-SIGNATURE")!,
        );
        return new Response('{"download":"ready"}', {
          status: 200,
          headers: {
            "PAYMENT-RESPONSE": paymentResponse({
              success: true,
              transaction: "0xabc",
              network: "eip155:8453",
            }),
          },
        });
      });

    await expect(
      submitAuthorizedPayment({
        attemptsDirectory: state.attemptsDirectory,
        attemptId: state.record.attemptId,
        requestEnvelopePath: state.requestEnvelopePath,
        fetchImplementation,
        now: new Date("2026-08-22T20:01:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "settlement_outcome_unknown",
      retryable: true,
    });
    expect((await state.store.get(state.record.attemptId)).state).toBe(
      "pending",
    );

    await expect(
      submitAuthorizedPayment({
        attemptsDirectory: state.attemptsDirectory,
        attemptId: state.record.attemptId,
        requestEnvelopePath: state.requestEnvelopePath,
        fetchImplementation,
        now: new Date("2026-08-22T20:01:03.000Z"),
      }),
    ).resolves.toMatchObject({ state: "fulfilled" });
    expect(seenSignatures).toEqual([
      state.artifact.paymentSignature,
      state.artifact.paymentSignature,
    ]);
  });

  it("routes retryable gas-treasury rejection without creating a new attempt", async () => {
    const state = await fixture();
    const fetchImplementation = vi.fn(async () =>
      Response.json(
        {
          error: {
            code: "gas_treasury_below_floor",
            detail: "temporarily unavailable",
          },
        },
        { status: 402 },
      ),
    );

    await expect(
      submitAuthorizedPayment({
        attemptsDirectory: state.attemptsDirectory,
        attemptId: state.record.attemptId,
        requestEnvelopePath: state.requestEnvelopePath,
        fetchImplementation,
        now: new Date("2026-08-22T20:01:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "gas_treasury_below_floor",
      retryable: true,
    });
    const record = await state.store.get(state.record.attemptId);
    expect(record).toMatchObject({
      attemptId: state.record.attemptId,
      state: "authorized",
      lastHttpStatus: 402,
      lastErrorCode: "gas_treasury_below_floor",
    });
  });

  it.each([
    "sponsorship_allowance_unavailable",
    "sponsorship_payment_cap_exceeded",
    "sponsorship_payment_allowance_exhausted",
    "sponsorship_volume_allowance_exhausted",
    "sponsorship_gas_budget_exhausted",
  ] as const)("terminalizes tenant allowance rejection %s", async (code) => {
    const state = await fixture();

    await expect(
      submitAuthorizedPayment({
        attemptsDirectory: state.attemptsDirectory,
        attemptId: state.record.attemptId,
        requestEnvelopePath: state.requestEnvelopePath,
        fetchImplementation: async () =>
          Response.json({ error: { code } }, { status: 402 }),
        now: new Date("2026-08-22T20:01:00.000Z"),
      }),
    ).rejects.toMatchObject({ code, retryable: false });
    expect(await state.store.get(state.record.attemptId)).toMatchObject({
      state: "terminal_failed",
      lastErrorCode: code,
    });
  });

  it("terminalizes an expired authorization before network submission", async () => {
    const state = await fixture("2026-08-22T20:00:30.000Z");
    const fetchImplementation = vi.fn();

    await expect(
      submitAuthorizedPayment({
        attemptsDirectory: state.attemptsDirectory,
        attemptId: state.record.attemptId,
        requestEnvelopePath: state.requestEnvelopePath,
        fetchImplementation,
        now: new Date("2026-08-22T20:01:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "sponsorship_reservation_expired" });
    expect(fetchImplementation).not.toHaveBeenCalled();
    expect((await state.store.get(state.record.attemptId)).state).toBe(
      "terminal_failed",
    );
  });

  it("treats a transport failure as ambiguous and keeps the exact attempt", async () => {
    const state = await fixture();
    const fetchImplementation = vi.fn(async () => {
      throw new Error("connection reset");
    });

    await expect(
      submitAuthorizedPayment({
        attemptsDirectory: state.attemptsDirectory,
        attemptId: state.record.attemptId,
        requestEnvelopePath: state.requestEnvelopePath,
        fetchImplementation,
        now: new Date("2026-08-22T20:01:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "settlement_outcome_unknown",
      retryable: true,
    });
    expect((await state.store.get(state.record.attemptId)).state).toBe(
      "pending",
    );
  });

  it("never downgrades a settled attempt when fulfillment reconciliation fails", async () => {
    const state = await fixture();
    await state.store.updateState(state.record.attemptId, "settled");
    const fetchImplementation = vi.fn(async () => {
      throw new Error("connection reset");
    });

    await expect(
      submitAuthorizedPayment({
        attemptsDirectory: state.attemptsDirectory,
        attemptId: state.record.attemptId,
        requestEnvelopePath: state.requestEnvelopePath,
        fetchImplementation,
        now: new Date("2026-08-22T20:01:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "settlement_outcome_unknown",
      retryable: true,
    });
    expect((await state.store.get(state.record.attemptId)).state).toBe(
      "settled",
    );
  });

  it("does not terminalize a prior ambiguous submission from a later 402", async () => {
    const state = await fixture();
    await state.store.updateState(state.record.attemptId, "pending");

    await expect(
      submitAuthorizedPayment({
        attemptsDirectory: state.attemptsDirectory,
        attemptId: state.record.attemptId,
        requestEnvelopePath: state.requestEnvelopePath,
        fetchImplementation: async () =>
          Response.json(
            { error: { code: "sponsorship_reservation_expired" } },
            { status: 402 },
          ),
        now: new Date("2026-08-22T20:01:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "settlement_outcome_unknown" });
    expect((await state.store.get(state.record.attemptId)).state).toBe(
      "pending",
    );
  });

  it("records settlement evidence even when fulfillment lookup returns 503", async () => {
    const state = await fixture();

    await expect(
      submitAuthorizedPayment({
        attemptsDirectory: state.attemptsDirectory,
        attemptId: state.record.attemptId,
        requestEnvelopePath: state.requestEnvelopePath,
        fetchImplementation: async () =>
          Response.json(
            { error: { code: "fulfillment_lookup_unavailable" } },
            {
              status: 503,
              headers: {
                "PAYMENT-RESPONSE": paymentResponse({
                  success: true,
                  transaction: "0xabc",
                  network: "eip155:8453",
                }),
              },
            },
          ),
        now: new Date("2026-08-22T20:01:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "settlement_outcome_unknown",
      retryable: true,
    });
    expect((await state.store.get(state.record.attemptId)).state).toBe(
      "settled",
    );
  });

  it("serializes concurrent submissions for the same exact attempt", async () => {
    const state = await fixture();
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    let requestStarted!: () => void;
    const requestGate = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const fetchImplementation = vi.fn(async () => {
      requestStarted();
      await responseGate;
      return new Response('{"download":"ready"}', {
        status: 200,
        headers: {
          "PAYMENT-RESPONSE": paymentResponse({
            success: true,
            transaction: "0xabc",
            network: "eip155:8453",
          }),
        },
      });
    });
    const first = submitAuthorizedPayment({
      attemptsDirectory: state.attemptsDirectory,
      attemptId: state.record.attemptId,
      requestEnvelopePath: state.requestEnvelopePath,
      fetchImplementation,
      now: new Date("2026-08-22T20:01:00.000Z"),
    });
    await requestGate;

    await expect(
      submitAuthorizedPayment({
        attemptsDirectory: state.attemptsDirectory,
        attemptId: state.record.attemptId,
        requestEnvelopePath: state.requestEnvelopePath,
        fetchImplementation,
        now: new Date("2026-08-22T20:01:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "attempt_already_exists",
      retryable: true,
    });
    releaseResponse();
    await expect(first).resolves.toMatchObject({ state: "fulfilled" });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });
});
