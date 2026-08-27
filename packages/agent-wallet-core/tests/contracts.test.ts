import { describe, expect, it } from "vitest";

import {
  AgentWalletError,
  digestJson,
  encodePaymentRequiredHeader,
  parseRequestEnvelope,
  type PaymentRequired,
} from "../src/index.js";

const resourceUrl = "https://merchant.example/v1/report";
const paymentRequired: PaymentRequired = {
  x402Version: 2,
  resource: { url: resourceUrl, mimeType: "application/json" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "1000000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 180,
      extra: {
        assetTransferMethod: "eip3009",
        payloadProfile: "com.k1hub.x402.base-usdc-eip3009-buyer-funded.v1",
      },
    },
  ],
};

function envelope() {
  return {
    version: 1,
    method: "POST",
    url: resourceUrl,
    contentType: "application/json",
    bodyBase64: Buffer.from('{"report":"q2"}', "utf8").toString("base64"),
    paymentRequired: encodePaymentRequiredHeader(paymentRequired),
    challengeDigest: digestJson(paymentRequired as never),
    merchantReference: "order_123",
  } as const;
}

describe("request envelope contract", () => {
  it("binds exact request bytes and the decoded payment resource", () => {
    const parsed = parseRequestEnvelope(envelope());
    expect(new TextDecoder().decode(parsed.body)).toBe('{"report":"q2"}');
    expect(parsed.paymentRequired).toEqual(paymentRequired);
    expect(parsed.requestDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("rejects unknown fields and request-resource mismatches", () => {
    expect(() => parseRequestEnvelope({ ...envelope(), authorization: "secret" }))
      .toThrowError(AgentWalletError);
    expect(() =>
      parseRequestEnvelope({ ...envelope(), challengeHandle: "charge_123" }),
    ).toThrow(/unknown fields/);
    expect(() =>
      parseRequestEnvelope({ ...envelope(), url: "https://merchant.example/v1/other" }),
    ).toThrow(/resource does not match/);
  });

  it("rejects credentialed URLs and non-canonical base64", () => {
    expect(() =>
      parseRequestEnvelope({ ...envelope(), url: "https://user:pass@merchant.example/v1/report" }),
    ).toThrow(/credential-free/);
    expect(() => parseRequestEnvelope({ ...envelope(), bodyBase64: "ZE==" })).toThrow(
      /canonical base64/,
    );
  });
});
