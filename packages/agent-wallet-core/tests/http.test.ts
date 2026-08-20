import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  createPaymentPayload,
  decodePaymentRequiredHeader,
  decodePaymentSignature,
  encodePaymentRequiredHeader,
  encodePaymentSignature,
  type PaymentRequired,
} from "../src/index.js";

const required: PaymentRequired = {
  x402Version: 2,
  resource: {
    url: "https://tenant.test/report",
    description: "Report",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:137",
      amount: "1000000",
      asset: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      payTo: "0x1111111111111111111111111111111111111111",
      maxTimeoutSeconds: 180,
      extra: { assetTransferMethod: "eip3009", name: "USD Coin", version: "2" },
    },
  ],
  extensions: {
    "payment-identifier": {
      info: { required: true },
      schema: {
        type: "object",
        properties: {
          required: { type: "boolean" },
          id: { type: "string" },
        },
      },
    },
    "com.k1hub.challenge-binding": {
      info: {
        version: 1,
        challengeId: "019f99e4-3371-7252-9d0a-eac7d4822520",
      },
      schema: {
        type: "object",
        required: ["version", "challengeId"],
      },
    },
  },
};

describe("x402 HTTP codec", () => {
  it("round trips strict PAYMENT-REQUIRED canonical base64", () => {
    const header = encodePaymentRequiredHeader(required);
    expect(decodePaymentRequiredHeader(header)).toEqual(required);
    expect(() => decodePaymentRequiredHeader(`${header}\n`)).toThrow(/base64/);
  });

  it("rejects encoded headers over 64 KiB", () => {
    const oversized = structuredClone(required);
    oversized.resource.description = "x".repeat(64 * 1024);
    expect(() => encodePaymentRequiredHeader(oversized)).toThrow(/maximum size/);
    expect(() =>
      decodePaymentRequiredHeader("A".repeat(64 * 1024 + 1)),
    ).toThrow(/base64|maximum size/);
  });

  it("echoes server info and adds only the buyer identifier", () => {
    const payload = createPaymentPayload({
      paymentRequired: required,
      accepted: required.accepts[0]!,
      schemePayload: { signature: "test" },
      paymentIdentifier: "buyer_0123456789abcdef",
    });
    expect(
      payload.extensions["com.k1hub.challenge-binding"]?.info.challengeId,
    ).toBe("019f99e4-3371-7252-9d0a-eac7d4822520");
    expect(payload.extensions["payment-identifier"]?.info).toEqual({
      required: true,
      id: "buyer_0123456789abcdef",
    });
    expect(payload.extensions["payment-identifier"]?.schema).toEqual(
      required.extensions?.["payment-identifier"]?.schema,
    );
    const encoded = encodePaymentSignature(payload);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(decodePaymentSignature(encoded)).toEqual(payload);
  });

  it("rejects noncanonical and structurally ambiguous payment signatures", () => {
    const payload = createPaymentPayload({
      paymentRequired: required,
      accepted: required.accepts[0]!,
      schemePayload: { signature: "test" },
      paymentIdentifier: "buyer_0123456789abcdef",
    });
    expect(() => decodePaymentSignature("ZE==")).toThrow(/base64/);
    expect(() =>
      decodePaymentSignature(
        Buffer.from(
          JSON.stringify({ ...payload, unexpected: true }),
          "utf8",
        ).toString("base64"),
      ),
    ).toThrow(/unknown fields/);
    expect(() =>
      decodePaymentSignature(
        Buffer.from(
          JSON.stringify({
            ...payload,
            extensions: {
              ...payload.extensions,
              "payment-identifier": {
                ...payload.extensions["payment-identifier"],
                unexpected: true,
              },
            },
          }),
          "utf8",
        ).toString("base64"),
      ),
    ).toThrow(/extension/);
  });

  it("accepts the current v2 resource and extension wire shape", () => {
    const current = {
      ...required,
      error: "PAYMENT-SIGNATURE header is required",
      resource: {
        url: required.resource.url,
        serviceName: "Tenant API",
        tags: ["reports", "paid"],
        iconUrl: "https://tenant.test/icon.png",
      },
    } satisfies PaymentRequired;

    expect(
      decodePaymentRequiredHeader(
        Buffer.from(JSON.stringify(current), "utf8").toString("base64"),
      ),
    ).toEqual(current);
  });

  it("rejects non-CAIP-2 network identifiers", () => {
    const malformed = structuredClone(required);
    malformed.accepts[0]!.network = "polygon";

    expect(() =>
      decodePaymentRequiredHeader(
        Buffer.from(JSON.stringify(malformed), "utf8").toString("base64"),
      ),
    ).toThrow(/requirement/);
  });

  it("uses cross-runtime canonical sorted JSON", () => {
    expect(canonicalJson({ z: 1, a: ["é", true] })).toBe(
      '{"a":["é",true],"z":1}',
    );
  });
});
