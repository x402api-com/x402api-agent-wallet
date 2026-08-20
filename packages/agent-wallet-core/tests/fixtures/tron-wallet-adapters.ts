import type { JsonObject } from "../../src/protocol/http.js";

import type {
  TronWalletAdapterLike,
  TronWalletNetwork,
} from "../../src/index.js";

import {
  TRON_PAYER,
  TRON_SIGNATURE,
} from "./tron-payment.js";

export type SigningBehavior = "signed" | "reject" | "mutate" | "offline";

function signedDocument(
  transaction: JsonObject,
  behavior: SigningBehavior,
): JsonObject {
  if (behavior === "reject") throw new Error("user rejected wallet prompt");
  if (behavior === "offline") throw new Error("wallet transport is offline");
  const result = structuredClone(transaction);
  result.signature = [TRON_SIGNATURE];
  if (behavior === "mutate") {
    result.raw_data_hex = `${String(result.raw_data_hex).slice(0, -2)}00`;
  }
  return result;
}

export class StandardProviderAdapterFixture
  implements TronWalletAdapterLike
{
  readonly name = "TronLink Adapter";
  readonly readyState = "Found";
  readonly calls: string[] = [];
  address: string | null = null;
  connected = false;
  account = TRON_PAYER;
  networkValue: TronWalletNetwork = {
    networkType: "Mainnet",
    chainId: "0x2b6653dc",
  };
  signingBehavior: SigningBehavior = "signed";
  connectOffline = false;

  async connect(): Promise<void> {
    this.calls.push("tron_requestAccounts");
    if (this.connectOffline) throw new Error("injected provider is offline");
    this.connected = true;
    this.address = this.account;
  }

  async disconnect(): Promise<void> {
    this.calls.push("disconnect");
    this.connected = false;
    this.address = null;
  }

  async network(): Promise<TronWalletNetwork> {
    this.calls.push("network");
    return structuredClone(this.networkValue);
  }

  async signTransaction(transaction: JsonObject): Promise<JsonObject> {
    this.calls.push("tronWeb.trx.sign");
    return signedDocument(transaction, this.signingBehavior);
  }
}
export class WalletConnectAdapterFixture implements TronWalletAdapterLike {
  readonly name = "WalletConnect";
  readonly readyState = "Found";
  readonly config = {
    network: "Mainnet",
    options: {
      projectId: "fixture-project",
      relayUrl: "wss://relay.walletconnect.invalid",
      metadata: {
        name: "Conformance fixture",
        description: "WalletConnect-style TRON fixture",
        url: "https://tenant.test",
        icons: ["https://tenant.test/icon.png"],
      },
    },
  };
  readonly calls: string[] = [];
  address: string | null = null;
  connected = false;
  account = TRON_PAYER;
  networkValue: TronWalletNetwork = {
    networkType: "Mainnet",
    chainId: "0x2b6653dc",
  };
  signingBehavior: SigningBehavior = "signed";
  relayOffline = false;

  async connect(): Promise<void> {
    this.calls.push("walletConnect.connect");
    if (this.relayOffline) throw new Error("WalletConnect relay is offline");
    this.connected = true;
    this.address = this.account;
  }

  async getConnectionStatus(): Promise<{ address: string }> {
    return { address: this.connected ? (this.address ?? "") : "" };
  }

  async disconnect(): Promise<void> {
    this.calls.push("walletConnect.disconnect");
    this.connected = false;
    this.address = null;
  }

  async network(): Promise<TronWalletNetwork> {
    this.calls.push("walletConnect.session.chain");
    return structuredClone(this.networkValue);
  }

  async signTransaction(transaction: JsonObject): Promise<JsonObject> {
    this.calls.push("walletConnect.signTransaction");
    return signedDocument(transaction, this.signingBehavior);
  }
}
