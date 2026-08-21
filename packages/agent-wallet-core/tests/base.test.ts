import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type { PaymentRequirement } from "../src/protocol/http.js";

import {
  BASE_MAINNET_CHAIN_ID,
  BASE_MAINNET_NETWORK,
  BASE_USDC_BUYER_FUNDED_PROFILE,
  BASE_USDC_SPONSORED_PROFILE,
  BASE_USDC_MAINNET_CONTRACT,
  buildBaseUsdcAuthorization,
  buildBaseUsdcEip1559TransactionRequest,
  encodeBaseUsdcTransferWithAuthorization,
  verifyBuyerSignedBaseUsdcTransaction,
} from "../src/index.js";

type BaseVector = {
  challengeDigest: string;
  nowSeconds: number;
  payer: string;
  recipient: string;
  amount: string;
  authorizationSignature: string;
  calldata: string;
  signedTransaction: string;
};

const vector = JSON.parse(
  readFileSync(
    new URL("./fixtures/base-usdc-buyer-funded.json", import.meta.url),
    "utf8",
  ),
) as BaseVector;

function requirement(): PaymentRequirement {
  return {
    scheme: "exact",
    network: BASE_MAINNET_NETWORK,
    amount: vector.amount,
    asset: BASE_USDC_MAINNET_CONTRACT,
    payTo: vector.recipient,
    maxTimeoutSeconds: 180,
    extra: {
      assetTransferMethod: "eip3009",
      name: "USD Coin",
      version: "2",
      payloadProfile: BASE_USDC_BUYER_FUNDED_PROFILE,
    },
  };
}

const transactionPolicy = {
  nonce: 7n,
  gasLimit: 150_000n,
  maxFeePerGas: 2_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
};

describe("Base issuer-native USDC buyer-funded conformance", () => {
  it("builds the same issuer authorization without a buyer gas transaction", () => {
    const accepted = requirement();
    accepted.extra.payloadProfile = BASE_USDC_SPONSORED_PROFILE;
    const material = buildBaseUsdcAuthorization({
      accepted,
      payer: vector.payer,
      nowSeconds: vector.nowSeconds,
      challengeDigest: vector.challengeDigest,
    });
    expect(material.authorization.from).toBe(vector.payer);
    expect(material.authorization.nonce).toBe(`0x${"55".repeat(32)}`);
  });

  it("matches the backend EIP-712, ABI, and signed EIP-1559 vector", () => {
    expect(BASE_MAINNET_CHAIN_ID).toBe(8453);
    const { authorization, typedData } = buildBaseUsdcAuthorization({
      accepted: requirement(),
      payer: vector.payer,
      nowSeconds: vector.nowSeconds,
      challengeDigest: vector.challengeDigest,
    });
    expect(authorization).toEqual({
      from: vector.payer,
      to: vector.recipient,
      value: vector.amount,
      validAfter: String(vector.nowSeconds - 1),
      validBefore: String(vector.nowSeconds + 180),
      nonce: `0x${"55".repeat(32)}`,
    });
    expect(typedData.domain).toEqual({
      name: "USD Coin",
      version: "2",
      chainId: 8453,
      verifyingContract: BASE_USDC_MAINNET_CONTRACT,
    });

    const data = encodeBaseUsdcTransferWithAuthorization({
      authorization,
      signature: vector.authorizationSignature,
    });
    expect(data).toBe(vector.calldata);
    const request = buildBaseUsdcEip1559TransactionRequest({
      accepted: requirement(),
      payer: vector.payer,
      data,
      policy: transactionPolicy,
    });
    expect(request).toMatchObject({
      type: "0x2",
      chainId: "0x2105",
      from: vector.payer,
      to: BASE_USDC_MAINNET_CONTRACT,
      value: "0x0",
      nonce: "0x7",
      gas: "0x249f0",
      maxFeePerGas: "0x1e8480",
      maxPriorityFeePerGas: "0xf4240",
      accessList: [],
    });
    expect(() =>
      verifyBuyerSignedBaseUsdcTransaction({
        signedTransaction: vector.signedTransaction,
        request,
      }),
    ).not.toThrow();
  });

  it("rejects wrong profiles, unbound digests, high-s authorizations, and unsafe fees", () => {
    const wrongProfile = requirement();
    wrongProfile.extra.payloadProfile = "unprofiled";
    expect(() =>
      buildBaseUsdcAuthorization({
        accepted: wrongProfile,
        payer: vector.payer,
        nowSeconds: vector.nowSeconds,
        challengeDigest: vector.challengeDigest,
      }),
    ).toThrow("buyer-funded issuer-native Base USDC");

    expect(() =>
      buildBaseUsdcAuthorization({
        accepted: requirement(),
        payer: vector.payer,
        nowSeconds: vector.nowSeconds,
        challengeDigest: `sha256:${"AA".repeat(32)}`,
      }),
    ).toThrow("challenge digest");

    const material = buildBaseUsdcAuthorization({
      accepted: requirement(),
      payer: vector.payer,
      nowSeconds: vector.nowSeconds,
      challengeDigest: vector.challengeDigest,
    });
    const highS =
      `${vector.authorizationSignature.slice(0, 66)}${"ff".repeat(32)}` +
      vector.authorizationSignature.slice(130);
    expect(() =>
      encodeBaseUsdcTransferWithAuthorization({
        authorization: material.authorization,
        signature: highS,
      }),
    ).toThrow("canonical low-s");

    expect(() =>
      buildBaseUsdcEip1559TransactionRequest({
        accepted: requirement(),
        payer: vector.payer,
        data: vector.calldata,
        policy: {
          ...transactionPolicy,
          maxPriorityFeePerGas: transactionPolicy.maxFeePerGas + 1n,
        },
      }),
    ).toThrow("outside the client ceiling");
  });

  it("detects any wallet mutation to a frozen transaction field", () => {
    const request = buildBaseUsdcEip1559TransactionRequest({
      accepted: requirement(),
      payer: vector.payer,
      data: vector.calldata,
      policy: transactionPolicy,
    });
    const mutatedDestination = vector.signedTransaction.replace(
      BASE_USDC_MAINNET_CONTRACT.slice(2).toLowerCase(),
      `93${BASE_USDC_MAINNET_CONTRACT.slice(4).toLowerCase()}`,
    );
    expect(() =>
      verifyBuyerSignedBaseUsdcTransaction({
        signedTransaction: mutatedDestination,
        request,
      }),
    ).toThrow("changed the frozen");

    expect(() =>
      verifyBuyerSignedBaseUsdcTransaction({
        signedTransaction: vector.signedTransaction.toUpperCase(),
        request,
      }),
    ).toThrow("canonical signed");
  });
});
