import { describe, expect, it } from "vitest";

import {
  createTronUsdtLabPayment,
  createTronUsdtPayment,
  TRON_MAINNET_CHAIN_ID,
  TronWalletAdapterProvider,
  type TronTransactionBuilder,
  type TronWalletAdapterLike,
} from "../src/index.js";

import {
  buildTronPaymentTrustFixture,
  TRON_PAYER,
  TRON_PAYMENT_NOW_MS,
  TRON_SIGNATURE,
  TRON_TRANSACTION,
} from "./fixtures/tron-payment.js";
import {
  StandardProviderAdapterFixture,
  WalletConnectAdapterFixture,
} from "./fixtures/tron-wallet-adapters.js";

type FixtureFactory = () => TronWalletAdapterLike & {
  address: string | null;
  connected?: boolean;
  account: string;
  calls: string[];
  networkValue: {
    networkType: "Mainnet" | "Shasta" | "Nile" | "Unknown";
    chainId: string;
  };
  signingBehavior: "signed" | "reject" | "mutate" | "offline";
};

const adapters: [string, FixtureFactory][] = [
  ["standard injected provider", () => new StandardProviderAdapterFixture()],
  ["WalletConnect-style adapter", () => new WalletConnectAdapterFixture()],
];

function vectorBuilder(onBuild?: () => void): TronTransactionBuilder {
  return {
    buildTransfer: async (args) => {
      onBuild?.();
      expect(args).toEqual({
        ownerAddress: TRON_PAYER,
        tokenContract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", // pragma: allowlist secret
        recipient: "TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV", // pragma: allowlist secret
        amountAtomic: "1000000",
        challengeCommitment: `sha256:${"00".repeat(32)}`,
        maxTimeoutSeconds: 180,
      });
      return {
        ...TRON_TRANSACTION,
        walletDocument: structuredClone(TRON_TRANSACTION),
      };
    },
  };
}

async function createPayment(options: {
  adapter: TronWalletAdapterLike;
  onBuild?: () => void;
}) {
  const trust = await buildTronPaymentTrustFixture();
  return createTronUsdtPayment({
    builder: vectorBuilder(options.onBuild),
    provider: new TronWalletAdapterProvider(options.adapter),
    paymentRequired: trust.paymentRequired,
    accepted: trust.accepted,
    buyerPaymentIdentifier: "buyer-payment-id-tron-0001",
    trustedAssetContracts: [trust.accepted.asset],
    maxFeeLimitSun: 100_000_000,
    nowMs: TRON_PAYMENT_NOW_MS,
  });
}

async function createLabPayment(options: {
  adapter: TronWalletAdapterLike;
  onBuild?: () => void;
  mutateAdmission?: (
    admission: Parameters<typeof createTronUsdtLabPayment>[0]["admission"],
  ) => void;
}) {
  const trust = await buildTronPaymentTrustFixture();
  const admission: Parameters<
    typeof createTronUsdtLabPayment
  >[0]["admission"] = {
    kind: "self-funded-tron-payment-lab-v1",
    payer: TRON_PAYER,
    recipient: trust.accepted.payTo,
    asset: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", // pragma: allowlist secret
    amountAtomic: trust.accepted.amount,
    resourceUrl: trust.paymentRequired.resource.url,
    expiresAt: new Date(TRON_PAYMENT_NOW_MS + 3_600_000).toISOString(),
    maxFeeLimitSun: 100_000_000,
  };
  options.mutateAdmission?.(admission);
  return createTronUsdtLabPayment({
    builder: vectorBuilder(options.onBuild),
    provider: new TronWalletAdapterProvider(options.adapter),
    paymentRequired: trust.paymentRequired,
    accepted: trust.accepted,
    buyerPaymentIdentifier: "buyer-payment-id-tron-lab-0001",
    admission,
    nowMs: TRON_PAYMENT_NOW_MS,
  });
}

describe("TRON wallet provider conformance", () => {
  it("rejects a trusted-but-non-USDT TRON contract before wallet access", async () => {
    const trust = await buildTronPaymentTrustFixture();
    const accepted = structuredClone(trust.accepted);
    accepted.asset = "TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj"; // pragma: allowlist secret
    const paymentRequired = structuredClone(trust.paymentRequired);
    paymentRequired.accepts = [accepted];
    const recipients = paymentRequired.extensions?.[
      "com.k1hub.external-recipient"
    ]?.info.recipients as { asset: string }[];
    recipients[0]!.asset = accepted.asset;
    const adapter = new StandardProviderAdapterFixture();
    let builds = 0;

    await expect(
      createTronUsdtPayment({
        builder: vectorBuilder(() => {
          builds += 1;
        }),
        provider: new TronWalletAdapterProvider(adapter),
        paymentRequired,
        accepted,
        buyerPaymentIdentifier: "buyer-payment-id-tron-wrong-asset",
        trustedAssetContracts: [accepted.asset],
        maxFeeLimitSun: 100_000_000,
        nowMs: TRON_PAYMENT_NOW_MS,
      }),
    ).rejects.toThrow(/approved TRON exact profile/);
    expect(builds).toBe(0);
    expect(adapter.calls).toEqual([]);
  });

  it.each(adapters)(
    "%s connects, returns the current account/network, and disconnects",
    async (_name, factory) => {
      const adapter = factory();
      const provider = new TronWalletAdapterProvider(adapter);

      await expect(provider.requestAccounts()).resolves.toEqual([TRON_PAYER]);
      await expect(provider.getNetwork()).resolves.toEqual({
        networkType: "Mainnet",
        chainId: TRON_MAINNET_CHAIN_ID,
      });
      adapter.account = "TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV"; // pragma: allowlist secret
      adapter.address = adapter.account;
      await expect(provider.requestAccounts()).resolves.toEqual([
        adapter.account,
      ]);
      await provider.disconnect();
      expect(adapter.connected).toBe(false);
      expect(adapter.address).toBeNull();
    },
  );

  it.each(adapters)(
    "%s rejects a non-Mainnet session before transaction construction",
    async (_name, factory) => {
      const adapter = factory();
      adapter.networkValue = {
        networkType: "Nile",
        chainId: "0xcd8690dc",
      };
      let builds = 0;
      await expect(
        createPayment({
          adapter,
          onBuild: () => {
            builds += 1;
          },
        }),
      ).rejects.toThrow(/not connected to Mainnet/);
      expect(builds).toBe(0);
      expect(adapter.calls).not.toContain("tronWeb.trx.sign");
      expect(adapter.calls).not.toContain("walletConnect.signTransaction");
    },
  );

  it.each(adapters)(
    "%s rejects a mismatched chain identifier even when labeled Mainnet",
    async (_name, factory) => {
      const adapter = factory();
      adapter.networkValue = {
        networkType: "Mainnet",
        chainId: "0xcd8690dc",
      };
      let builds = 0;
      await expect(
        createPayment({
          adapter,
          onBuild: () => {
            builds += 1;
          },
        }),
      ).rejects.toThrow(/not connected to Mainnet/);
      expect(builds).toBe(0);
    },
  );

  it.each(adapters)(
    "%s propagates explicit user rejection without a payload",
    async (_name, factory) => {
      const adapter = factory();
      adapter.signingBehavior = "reject";
      await expect(createPayment({ adapter })).rejects.toThrow(
        /user rejected wallet prompt/,
      );
    },
  );

  it.each(adapters)(
    "%s rejects transaction mutation after the wallet prompt",
    async (_name, factory) => {
      const adapter = factory();
      adapter.signingBehavior = "mutate";
      await expect(createPayment({ adapter })).rejects.toThrow(
        /wallet changed transaction bytes/,
      );
    },
  );

  it.each(adapters)(
    "%s fails closed when its signing transport is offline",
    async (_name, factory) => {
      const adapter = factory();
      adapter.signingBehavior = "offline";
      await expect(createPayment({ adapter })).rejects.toThrow(/offline/);
    },
  );

  it("fails closed when the injected provider is offline during connect", async () => {
    const adapter = new StandardProviderAdapterFixture();
    adapter.connectOffline = true;
    await expect(createPayment({ adapter })).rejects.toThrow(
      /injected provider is offline/,
    );
  });

  it("fails closed when the WalletConnect relay is offline during connect", async () => {
    const adapter = new WalletConnectAdapterFixture();
    adapter.relayOffline = true;
    await expect(createPayment({ adapter })).rejects.toThrow(
      /WalletConnect relay is offline/,
    );
  });

  it("constructs, inspects, signs, and returns a complete TRON USD₮ payload", async () => {
    const adapter = new WalletConnectAdapterFixture();
    const payment = await createPayment({ adapter });

    expect(payment.x402Version).toBe(2);
    expect(payment.accepted.network).toBe("tron:mainnet");
    expect(payment.payload).toEqual({
      transaction: {
        ...TRON_TRANSACTION,
        signature: [TRON_SIGNATURE],
      },
    });
    expect(payment.extensions["payment-identifier"]?.info.id).toBe(
      "buyer-payment-id-tron-0001",
    );
    expect(adapter.calls).toEqual([
      "walletConnect.connect",
      "walletConnect.session.chain",
      "walletConnect.signTransaction",
    ]);
  });
});

describe("self-funded TRON payment lab", () => {
  it("constructs and signs only the exact pinned Mainnet payment", async () => {
    const adapter = new StandardProviderAdapterFixture();
    const payment = await createLabPayment({ adapter });

    expect(payment.accepted.amount).toBe("1000000");
    expect(payment.accepted.payTo).toBe(
      "TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV", // pragma: allowlist secret
    );
    expect(payment.payload.transaction).toEqual({
      ...TRON_TRANSACTION,
      signature: [TRON_SIGNATURE],
    });
  });

  it.each([
    [
      "recipient",
      (value: Parameters<typeof createTronUsdtLabPayment>[0]["admission"]) => {
        value.recipient = TRON_PAYER;
      },
    ],
    [
      "amount",
      (value: Parameters<typeof createTronUsdtLabPayment>[0]["admission"]) => {
        value.amountAtomic = "1000001";
      },
    ],
    [
      "resource",
      (value: Parameters<typeof createTronUsdtLabPayment>[0]["admission"]) => {
        value.resourceUrl = "https://tenant.test/other";
      },
    ],
    [
      "expiry",
      (value: Parameters<typeof createTronUsdtLabPayment>[0]["admission"]) => {
        value.expiresAt = new Date(TRON_PAYMENT_NOW_MS).toISOString();
      },
    ],
  ] as const)(
    "rejects a wrong %s before invoking the builder or wallet",
    async (_label, mutateAdmission) => {
      const adapter = new StandardProviderAdapterFixture();
      let builds = 0;
      await expect(
        createLabPayment({
          adapter,
          mutateAdmission,
          onBuild: () => {
            builds += 1;
          },
        }),
      ).rejects.toThrow(/exact self-funded TRON lab admission/);
      expect(builds).toBe(0);
      expect(adapter.calls).toEqual([]);
    },
  );

  it("rejects a wallet account outside the exact payer before building", async () => {
    const adapter = new StandardProviderAdapterFixture();
    let builds = 0;
    await expect(
      createLabPayment({
        adapter,
        mutateAdmission: (admission) => {
          admission.payer = admission.recipient;
        },
        onBuild: () => {
          builds += 1;
        },
      }),
    ).rejects.toThrow(/wallet account is outside/);
    expect(builds).toBe(0);
    expect(adapter.calls).toEqual(["tron_requestAccounts"]);
  });

  it("rejects transaction-byte mutation after the wallet prompt", async () => {
    const adapter = new StandardProviderAdapterFixture();
    adapter.signingBehavior = "mutate";

    await expect(createLabPayment({ adapter })).rejects.toThrow(
      /wallet changed transaction bytes/,
    );
  });
});
