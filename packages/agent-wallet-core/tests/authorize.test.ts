import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizePayment,
  canonicalJson,
  createWallet,
  decodePaymentSignature,
  digestJson,
  encodePaymentRequiredHeader,
  encodeSolanaBase58,
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_MAINNET_NETWORK,
  SOLANA_SPONSORED_PROFILE,
  SOLANA_USDT_BUYER_FUNDED_PROFILE,
  SOLANA_USDC_MAINNET_MINT,
  type JsonObject,
  type PaymentRequired,
  type PaymentRequirement,
} from "../src/index.js";

const roots: string[] = [];
const now = new Date("2026-08-22T20:00:00.000Z");

afterEach(async () => {
  vi.unstubAllGlobals();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function address(byte: number): string {
  return encodeSolanaBase58(new Uint8Array(32).fill(byte));
}

function sponsoredRequirement(): PaymentRequirement {
  return {
    scheme: "exact",
    network: SOLANA_MAINNET_NETWORK,
    amount: "100000",
    asset: SOLANA_USDC_MAINNET_MINT,
    payTo: address(3),
    maxTimeoutSeconds: 180,
    extra: {
      feePayer: address(2),
      payloadProfile: SOLANA_SPONSORED_PROFILE,
      memo: "k1h:018f4c76-8f9a-7d3a-8e0b-123456789abc",
    },
  };
}

function externalRecipient(requirement: PaymentRequirement): JsonObject {
  const recipientDescriptor: JsonObject = {
    type: "com.k1hub.external-receiving-address.v1",
    tenantId: "018f4c76-8f9a-7d3a-8e0b-123456789abc",
    network: requirement.network,
    address: requirement.payTo,
    controlChallengeDigest: `sha256:${"4".repeat(64)}`,
  };
  return {
    version: 1,
    recipients: [
      {
        network: requirement.network,
        asset: requirement.asset,
        payTo: requirement.payTo,
        recipientDescriptorDigest: digestJson(recipientDescriptor),
        recipientDescriptor,
      },
    ],
  };
}

function challenge(
  requirement: PaymentRequirement,
  expiresAt = "2026-08-22T20:02:00.000Z",
): PaymentRequired {
  const sponsorshipKeys = [
    "version",
    "mode",
    "requirements",
    "buyerNativeFeeRequired",
    "billingParty",
    "maximumReservationEvidenceDigest",
    "expiresAt",
    "finalChargePolicy",
  ];
  return {
    x402Version: 2,
    resource: { url: "https://merchant.example/paid" },
    accepts: [requirement],
    extensions: {
      "payment-identifier": { info: { required: true } },
      "com.k1hub.challenge-binding": {
        info: {
          version: 1,
          challengeId: "018f4c76-8f9a-7d3a-8e0b-123456789abc",
        },
      },
      "com.k1hub.external-recipient": {
        info: externalRecipient(requirement),
      },
      "com.x402api.gas-sponsorship": {
        info: {
          version: 1,
          mode: "facilitator_pays",
          requirements: [
            {
              network: requirement.network,
              asset: requirement.asset,
              payloadProfile: requirement.extra.payloadProfile!,
            },
          ],
          buyerNativeFeeRequired: false,
          billingParty: "platform_treasury",
          maximumReservationEvidenceDigest: `sha256:${"5".repeat(64)}`,
          expiresAt,
          finalChargePolicy: "platform_treasury_actual_cost",
        },
        schema: {
          $id: "urn:com:x402api:gas-sponsorship:v1",
          type: "object",
          additionalProperties: false,
          required: sponsorshipKeys,
        },
      },
    },
  };
}

async function fixture(paymentRequired: PaymentRequired) {
  const root = await mkdtemp(join(tmpdir(), "x402api-authorize-test-"));
  roots.push(root);
  await chmod(root, 0o700);
  const walletsDirectory = join(root, "wallets");
  const attemptsDirectory = join(root, "attempts");
  const artifactPath = join(root, "artifacts", "payment.json");
  const requestEnvelopePath = join(root, "request.json");
  const passphrase = "correct horse battery staple";
  await createWallet({
    walletsDirectory,
    name: "buyer",
    network: SOLANA_MAINNET_NETWORK,
    passphrase,
    maximumPaymentAtomic: "200000",
  });
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
      merchantReference: "order-123",
    })}\n`,
    { mode: 0o600 },
  );
  return {
    root,
    walletsDirectory,
    attemptsDirectory,
    artifactPath,
    requestEnvelopePath,
    passphrase,
  };
}

function mockSolanaRpc(): string[] {
  const methods: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { method: string };
      methods.push(request.method);
      const result =
        request.method === "getGenesisHash"
          ? SOLANA_MAINNET_GENESIS_HASH
          : request.method === "getBalance"
            ? { value: 0 }
            : request.method === "getTokenAccountsByOwner"
              ? {
                  value: [
                    {
                      account: {
                        data: {
                          parsed: {
                            info: { tokenAmount: { amount: "1000000" } },
                          },
                        },
                      },
                    },
                  ],
                }
              : request.method === "getLatestBlockhash"
                ? { value: { blockhash: address(4) } }
                : null;
      return Response.json({ jsonrpc: "2.0", id: 1, result });
    }),
  );
  return methods;
}

describe("sponsored launch authorization orchestration", () => {
  it("authorizes Solana USDC without requiring SOL and persists one exact artifact", async () => {
    const paymentRequired = challenge(sponsoredRequirement());
    const state = await fixture(paymentRequired);
    const methods = mockSolanaRpc();

    const result = await authorizePayment({
      ...state,
      wallet: "buyer",
      rpc: { solana: "https://rpc.example" },
      now,
    });

    expect(result).toMatchObject({
      wallet: "buyer",
      network: SOLANA_MAINNET_NETWORK,
      asset: SOLANA_USDC_MAINNET_MINT,
      amountAtomic: "100000",
      state: "authorized",
    });
    expect(methods).toEqual([
      "getGenesisHash",
      "getBalance",
      "getTokenAccountsByOwner",
      "getGenesisHash",
      "getLatestBlockhash",
    ]);
    const artifact = JSON.parse(await readFile(state.artifactPath, "utf8")) as {
      paymentSignature: string;
      expiresAt: string;
    };
    expect(artifact.expiresAt).toBe("2026-08-22T20:02:00.000Z");
    const payment = decodePaymentSignature(artifact.paymentSignature);
    expect(canonicalJson(payment.accepted as unknown as JsonObject)).toBe(
      canonicalJson(paymentRequired.accepts[0] as unknown as JsonObject),
    );
    const transaction = Buffer.from(
      String(payment.payload.transaction),
      "base64",
    );
    expect(transaction[0]).toBe(2);
    expect(transaction.subarray(1, 65)).toEqual(Buffer.alloc(64));
    expect(transaction.subarray(65, 129)).not.toEqual(Buffer.alloc(64));
  });

  it("rejects an expired sponsorship before balance or signing RPC access", async () => {
    const state = await fixture(
      challenge(sponsoredRequirement(), "2026-08-22T19:59:59.000Z"),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      authorizePayment({
        ...state,
        wallet: "buyer",
        rpc: { solana: "https://rpc.example" },
        now,
      }),
    ).rejects.toMatchObject({ code: "sponsorship_reservation_expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the matched legacy tenant-credit policy during rollout", async () => {
    const paymentRequired = challenge(sponsoredRequirement());
    const sponsorship = paymentRequired.extensions![
      "com.x402api.gas-sponsorship"
    ]!.info;
    sponsorship.billingParty = "tenant_service_credit";
    sponsorship.finalChargePolicy =
      "canonical_actual_gas_capped_by_reservation";
    const state = await fixture(paymentRequired);
    mockSolanaRpc();

    await expect(
      authorizePayment({
        ...state,
        wallet: "buyer",
        rpc: { solana: "https://rpc.example" },
        now,
      }),
    ).resolves.toMatchObject({ state: "authorized" });
  });

  it("rejects a mixed sponsorship billing policy", async () => {
    const paymentRequired = challenge(sponsoredRequirement());
    paymentRequired.extensions!["com.x402api.gas-sponsorship"]!.info
      .finalChargePolicy = "canonical_actual_gas_capped_by_reservation";
    const state = await fixture(paymentRequired);

    await expect(
      authorizePayment({
        ...state,
        wallet: "buyer",
        rpc: { solana: "https://rpc.example" },
        now,
      }),
    ).rejects.toThrow("PAYMENT-REQUIRED could not be decoded strictly");
  });

  it("does not fall back to a buyer-funded Solana profile", async () => {
    const requirement = sponsoredRequirement();
    requirement.extra = {
      payloadProfile: SOLANA_USDT_BUYER_FUNDED_PROFILE,
      memo: "k1h:018f4c76-8f9a-7d3a-8e0b-123456789abc",
    };
    const paymentRequired = challenge(sponsoredRequirement());
    paymentRequired.accepts = [requirement];
    delete paymentRequired.extensions!["com.x402api.gas-sponsorship"];
    const state = await fixture(paymentRequired);

    await expect(
      authorizePayment({
        ...state,
        wallet: "buyer",
        rpc: { solana: "https://rpc.example" },
        now,
      }),
    ).rejects.toMatchObject({ code: "unsupported_profile" });
  });
});
