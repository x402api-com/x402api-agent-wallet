import { describe, expect, it } from "vitest";
import type { PaymentRequirement } from "../src/protocol/http.js";

import {
  buildBuyerFundedSolanaPayment,
  buildBuyerFundedSolanaUsdtTransaction,
  buildSolanaUsdtTransaction,
  createSolanaUsdtLabPayment,
  decodeSolanaBase58,
  encodeSolanaBase58,
  InjectedSolanaWalletTransport,
  RawSolanaVersionedTransaction,
  SOLANA_MAINNET_NETWORK,
  SOLANA_SPONSORED_PROFILE,
  SOLANA_USDT_BUYER_FUNDED_PROFILE,
  SOLANA_USDC_MAINNET_MINT,
  SOLANA_USDT_MAINNET_MINT,
  solanaAssociatedTokenAddress,
} from "../src/index.js";

function address(byte: number): string {
  return encodeSolanaBase58(new Uint8Array(32).fill(byte));
}

function containsBytes(value: Uint8Array, expected: Uint8Array): boolean {
  for (let index = 0; index <= value.length - expected.length; index += 1) {
    if (expected.every((byte, offset) => value[index + offset] === byte)) {
      return true;
    }
  }
  return false;
}

function requirement(): PaymentRequirement {
  return {
    scheme: "exact",
    network: SOLANA_MAINNET_NETWORK,
    amount: "100000",
    asset: SOLANA_USDT_MAINNET_MINT,
    payTo: address(3),
    maxTimeoutSeconds: 90,
    extra: {
      feePayer: address(2),
      payloadProfile: SOLANA_SPONSORED_PROFILE,
      memo: "k1h:018f4c76-8f9a-7d3a-8e0b-123456789abc",
    },
  };
}

function buyerFundedRequirement(
  asset = SOLANA_USDT_MAINNET_MINT,
): PaymentRequirement {
  return {
    scheme: "exact",
    network: SOLANA_MAINNET_NETWORK,
    amount: "100000",
    asset,
    payTo: address(3),
    maxTimeoutSeconds: 90,
    extra: {
      payloadProfile: SOLANA_USDT_BUYER_FUNDED_PROFILE,
      memo: "k1h:018f4c76-8f9a-7d3a-8e0b-123456789abc",
    },
  };
}

describe("Solana USDt exact transaction builder", () => {
  it.each([
    ["USDC", SOLANA_USDC_MAINNET_MINT],
    ["USDT", SOLANA_USDT_MAINNET_MINT],
  ])("builds the exact issuer-native %s mint", async (_symbol, mint) => {
    const { message, transaction } = await buildBuyerFundedSolanaPayment({
      accepted: buyerFundedRequirement(mint),
      payer: address(1),
      recentBlockhash: address(4),
    });

    expect(transaction.slice(65)).toEqual(message);
    expect(transaction.length).toBeLessThanOrEqual(1_232);
    expect(containsBytes(message, decodeSolanaBase58(mint))).toBe(true);
  });

  it("rejects an unadmitted Solana mint", async () => {
    await expect(
      buildBuyerFundedSolanaPayment({
        accepted: buyerFundedRequirement(address(9)),
        payer: address(1),
        recentBlockhash: address(4),
      }),
    ).rejects.toThrow("issuer-native Solana USDC or USDT");
  });

  it("builds the V1 one-signature buyer-fee-payer exact profile", async () => {
    const accepted = buyerFundedRequirement();
    const payer = address(1);
    const { message, transaction } =
      await buildBuyerFundedSolanaUsdtTransaction({
        accepted,
        payer,
        recentBlockhash: address(4),
      });

    expect(transaction[0]).toBe(1);
    expect(transaction.slice(1, 65)).toEqual(new Uint8Array(64));
    expect(transaction.slice(65)).toEqual(message);
    expect(message.slice(0, 4)).toEqual(Uint8Array.of(0x80, 1, 0, 4));
    expect(message[4]).toBe(7);
    expect(message.slice(5, 37)).toEqual(decodeSolanaBase58(payer));
    expect(transaction.length).toBeLessThanOrEqual(1_232);
  });

  it("requires the exact buyer-funded profile and buyer-funded role separation", async () => {
    const accepted = buyerFundedRequirement();
    accepted.extra.feePayer = address(2);
    await expect(
      buildBuyerFundedSolanaUsdtTransaction({
        accepted,
        payer: address(1),
        recentBlockhash: address(4),
      }),
    ).rejects.toThrow("buyer-funded issuer-native");

    delete accepted.extra.feePayer;
    await expect(
      buildBuyerFundedSolanaUsdtTransaction({
        accepted,
        payer: accepted.payTo,
        recentBlockhash: address(4),
      }),
    ).rejects.toThrow("must be distinct");
  });

  it("lets an injected wallet fill exactly the only buyer signature slot", async () => {
    const accepted = buyerFundedRequirement();
    const payerKeys = (await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const payer = encodeSolanaBase58(
      new Uint8Array(await crypto.subtle.exportKey("raw", payerKeys.publicKey)),
    );
    const { transaction, message } =
      await buildBuyerFundedSolanaUsdtTransaction({
        accepted,
        payer,
        recentBlockhash: address(4),
      });
    const wallet = new InjectedSolanaWalletTransport({
      async connect() {
        return { publicKey: { toString: () => payer } };
      },
      async signTransaction(candidate: RawSolanaVersionedTransaction) {
        expect(candidate.signatures).toHaveLength(1);
        expect(candidate.signatures[0]).toEqual(new Uint8Array(64));
        candidate.signatures[0] = new Uint8Array(
          await crypto.subtle.sign(
            "Ed25519",
            payerKeys.privateKey,
            candidate.message.serialize().slice().buffer as ArrayBuffer,
          ),
        );
        return candidate;
      },
    });
    await wallet.connect(SOLANA_MAINNET_NETWORK);
    const signedBase64 = await wallet.signTransaction({
      network: SOLANA_MAINNET_NETWORK,
      transactionBase64: btoa(String.fromCharCode(...transaction)),
    });
    const signed = Uint8Array.from(atob(signedBase64), (character) =>
      character.charCodeAt(0),
    );
    expect(signed[0]).toBe(1);
    expect(signed.slice(1, 65)).not.toEqual(new Uint8Array(64));
    expect(signed.slice(65)).toEqual(message);
  });

  it("uses canonical 32-byte base58 and derives the standard token account", async () => {
    const system = "11111111111111111111111111111111";
    expect(encodeSolanaBase58(decodeSolanaBase58(system))).toBe(system);
    await expect(
      solanaAssociatedTokenAddress({
        owner: system,
        mint: SOLANA_USDT_MAINNET_MINT,
      }),
    ).resolves.toBe("8rnaGxt5r69eGeZw8geGVcQnJaRBDJQQGd1qd8PZQZVM");
  });

  it("builds a partial static v0 transaction with two blank signature slots", async () => {
    const recentBlockhash = address(4);
    const { message, transaction } = await buildSolanaUsdtTransaction({
      accepted: requirement(),
      payer: address(1),
      recentBlockhash,
    });

    expect(transaction[0]).toBe(2);
    expect(transaction.slice(1, 129)).toEqual(new Uint8Array(128));
    expect(transaction.slice(129)).toEqual(message);
    expect(message.slice(0, 4)).toEqual(Uint8Array.of(0x80, 2, 1, 4));
    expect(transaction.length).toBeLessThanOrEqual(1_232);
  });

  it("supports sponsored issuer-native Solana USDC", async () => {
    const accepted = requirement();
    accepted.asset = SOLANA_USDC_MAINNET_MINT;
    const { message, transaction } = await buildSolanaUsdtTransaction({
      accepted,
      payer: address(1),
      recentBlockhash: address(4),
    });
    expect(transaction[0]).toBe(2);
    expect(transaction.slice(129)).toEqual(message);
    expect(containsBytes(message, decodeSolanaBase58(SOLANA_USDC_MAINNET_MINT))).toBe(true);
  });

  it("rejects untrusted assets, malformed memos, collisions, and excessive fees", async () => {
    const accepted = requirement();
    accepted.extra.memo = "unbound";
    await expect(
      buildSolanaUsdtTransaction({
        accepted,
        payer: address(1),
        recentBlockhash: address(4),
      }),
    ).rejects.toThrow("sponsored native Solana USDC or USDT");

    accepted.extra.memo = "k1h:018f4c76-8f9a-7d3a-8e0b-123456789abc";
    await expect(
      buildSolanaUsdtTransaction({
        accepted,
        payer: accepted.payTo,
        recentBlockhash: address(4),
      }),
    ).rejects.toThrow("must be distinct");
    await expect(
      buildSolanaUsdtTransaction({
        accepted,
        payer: address(1),
        recentBlockhash: address(4),
        computeUnitPriceMicroLamports: 1_000_001,
      }),
    ).rejects.toThrow("outside the client ceiling");
  });
});

describe("Solana wallet signing boundary", () => {
  it("preserves the sponsor slot and frozen message while filling only the payer signature", async () => {
    const accepted = requirement();
    const payer = address(1);
    const wallet = new InjectedSolanaWalletTransport({
      async connect() {
        return { publicKey: { toString: () => payer } };
      },
      async signTransaction(transaction: RawSolanaVersionedTransaction) {
        expect(transaction.signatures[0]).toEqual(new Uint8Array(64));
        expect(transaction.signatures[1]).toEqual(new Uint8Array(64));
        transaction.signatures[1] = new Uint8Array(64).fill(9);
        return transaction;
      },
    });
    const paymentRequired = {
      x402Version: 2 as const,
      resource: { url: "https://merchant.example/paid" },
      accepts: [accepted],
      extensions: {
        "payment-identifier": { info: { required: true } },
      },
    };

    const payment = await createSolanaUsdtLabPayment({
      rpc: { latestBlockhash: async () => address(4) },
      wallet,
      paymentRequired,
      accepted,
      buyerPaymentIdentifier: "buyer-payment-0001",
      admission: {
        kind: "tenant-sponsored-solana-payment-lab-v1",
        payer,
        recipient: accepted.payTo,
        asset: SOLANA_USDT_MAINNET_MINT,
        amountAtomic: accepted.amount,
        resourceUrl: paymentRequired.resource.url,
        expiresAt: "2027-01-01T00:00:00Z",
      },
      now: new Date("2026-07-27T00:00:00Z"),
    });

    const transaction = Uint8Array.from(
      atob(String(payment.payload.transaction)),
      (character) => character.charCodeAt(0),
    );
    expect(transaction.slice(1, 65)).toEqual(new Uint8Array(64));
    expect(transaction.slice(65, 129)).toEqual(new Uint8Array(64).fill(9));
  });

  it("rejects a wallet that mutates the frozen message", async () => {
    const accepted = requirement();
    const payer = address(1);
    const wallet = new InjectedSolanaWalletTransport({
      async connect() {
        return { publicKey: { toString: () => payer } };
      },
      async signTransaction(transaction: RawSolanaVersionedTransaction) {
        const changedMessage = transaction.message.serialize();
        const last = changedMessage.length - 1;
        changedMessage[last] = changedMessage[last]! ^ 1;
        return new RawSolanaVersionedTransaction(changedMessage, [
          new Uint8Array(64),
          new Uint8Array(64).fill(7),
        ]);
      },
    });
    const paymentRequired = {
      x402Version: 2 as const,
      resource: { url: "https://merchant.example/paid" },
      accepts: [accepted],
      extensions: {
        "payment-identifier": { info: { required: true } },
      },
    };

    await expect(
      createSolanaUsdtLabPayment({
        rpc: { latestBlockhash: async () => address(4) },
        wallet,
        paymentRequired,
        accepted,
        buyerPaymentIdentifier: "buyer-payment-0001",
        admission: {
          kind: "tenant-sponsored-solana-payment-lab-v1",
          payer,
          recipient: accepted.payTo,
          asset: SOLANA_USDT_MAINNET_MINT,
          amountAtomic: accepted.amount,
          resourceUrl: paymentRequired.resource.url,
          expiresAt: "2027-01-01T00:00:00Z",
        },
        now: new Date("2026-07-27T00:00:00Z"),
      }),
    ).rejects.toThrow("frozen Solana message");
  });
});
