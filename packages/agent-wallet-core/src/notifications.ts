import { randomBytes } from "node:crypto";

import { Wallet } from "ethers";
import { Trx } from "tronweb";
import nacl from "tweetnacl";

import { readWalletBalance, type RpcConfiguration, type WalletBalance } from "./balances.js";
import { AgentWalletError } from "./errors.js";
import { canonicalJson, type JsonObject } from "./protocol/http.js";
import { unlockWallet, type UnlockedWallet } from "./storage/keystore.js";

export type RefillReason = "low_balance" | "renewal";

export type RefillNotificationIntent = {
  version: 1;
  kind: "x402api.refill-notification.v1";
  audience: string;
  subscriptionReference: string;
  wallet: {
    network: string;
    address: string;
  };
  balance: {
    asset: string;
    assetSymbol: "USDC" | "USDT";
    currentAtomic: string;
    targetAtomic: string;
    refillAtomic: string;
  };
  renewBy: string;
  reason: RefillReason;
  createdAt: string;
  expiresAt: string;
  nonce: string;
};

export type SignedRefillNotification = {
  version: 1;
  intent: RefillNotificationIntent;
  signature: {
    scheme: "eip191" | "ed25519" | "tron-message-v2";
    value: string;
  };
};

export type RefillNotificationResult = {
  version: 1;
  status: "accepted" | "deduplicated" | "not_required";
  notificationId?: string;
  wallet: string;
  network: string;
  address: string;
  asset: string;
  assetSymbol: "USDC" | "USDT";
  currentBalanceAtomic: string;
  targetBalanceAtomic: string;
  refillAmountAtomic: string;
  renewBy: string;
  subscriptionReference: string;
};

const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DOMAIN = "x402api-agent-wallet-refill-v1\n";

export function validateNotificationUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AgentWalletError(
      "notification_not_configured",
      "x402api notification URL is invalid",
      { cause: error },
    );
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (!local && url.protocol !== "https:") ||
    (local && !["http:", "https:"].includes(url.protocol)) ||
    url.username ||
    url.password ||
    url.hash ||
    value !== url.toString()
  ) {
    throw new AgentWalletError(
      "notification_not_configured",
      "x402api notification URL must be normalized credential-free HTTPS",
    );
  }
  return url.toString();
}

function canonicalRenewBy(value: string, now: number): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
    throw new AgentWalletError("invalid_input", "--renew-by must be a canonical UTC timestamp");
  }
  const timestamp = Date.parse(value);
  const normalized = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
  if (
    !Number.isFinite(timestamp) ||
    (value !== normalized && value !== normalized.replace(".000Z", "Z")) ||
    timestamp <= now ||
    timestamp > now + 366 * 86_400_000
  ) {
    throw new AgentWalletError(
      "invalid_input",
      "--renew-by must be in the future and no more than 366 days away",
    );
  }
  return normalized;
}

function signingMessage(intent: RefillNotificationIntent): string {
  return `${DOMAIN}${canonicalJson(intent as unknown as JsonObject)}`;
}

export async function createSignedRefillNotification(options: {
  wallet: UnlockedWallet;
  balance: WalletBalance;
  notificationUrl: string;
  subscriptionReference: string;
  targetBalanceAtomic: string;
  renewBy: string;
  reason: RefillReason;
  now?: number;
}): Promise<SignedRefillNotification> {
  const now = options.now ?? Date.now();
  const audience = validateNotificationUrl(options.notificationUrl);
  if (!REFERENCE.test(options.subscriptionReference)) {
    throw new AgentWalletError(
      "invalid_input",
      "subscription reference must contain 1-128 safe identifier characters",
    );
  }
  if (!DECIMAL.test(options.targetBalanceAtomic)) {
    throw new AgentWalletError("invalid_input", "target balance is not canonical decimal");
  }
  if (
    options.balance.network !== options.wallet.metadata.network ||
    options.balance.address !== options.wallet.metadata.address
  ) {
    throw new AgentWalletError("invalid_input", "balance does not belong to the unlocked wallet");
  }
  const current = BigInt(options.balance.assetAtomic);
  const target = BigInt(options.targetBalanceAtomic);
  if (target <= current) {
    throw new AgentWalletError("invalid_input", "target balance must exceed current balance");
  }
  if (!(["low_balance", "renewal"] as const).includes(options.reason)) {
    throw new AgentWalletError("invalid_input", "refill reason is unsupported");
  }
  const createdAt = new Date(now).toISOString();
  const intent: RefillNotificationIntent = {
    version: 1,
    kind: "x402api.refill-notification.v1",
    audience,
    subscriptionReference: options.subscriptionReference,
    wallet: {
      network: options.wallet.metadata.network,
      address: options.wallet.metadata.address,
    },
    balance: {
      asset: options.balance.asset,
      assetSymbol: options.balance.assetSymbol,
      currentAtomic: current.toString(),
      targetAtomic: target.toString(),
      refillAtomic: (target - current).toString(),
    },
    renewBy: canonicalRenewBy(options.renewBy, now),
    reason: options.reason,
    createdAt,
    expiresAt: new Date(now + 15 * 60_000).toISOString(),
    nonce: randomBytes(24).toString("base64url"),
  };
  const message = signingMessage(intent);
  let scheme: SignedRefillNotification["signature"]["scheme"];
  let value: string;
  if (options.wallet.metadata.network === "eip155:8453") {
    if (!options.wallet.secret.privateKeyHex) {
      throw new AgentWalletError("wallet_locked", "Base private key is unavailable");
    }
    scheme = "eip191";
    value = await new Wallet(`0x${options.wallet.secret.privateKeyHex}`).signMessage(message);
  } else if (options.wallet.metadata.network === "tron:mainnet") {
    if (!options.wallet.secret.privateKeyHex) {
      throw new AgentWalletError("wallet_locked", "TRON private key is unavailable");
    }
    scheme = "tron-message-v2";
    value = Trx.signMessageV2(message, options.wallet.secret.privateKeyHex);
  } else {
    if (!options.wallet.secret.seedBase64) {
      throw new AgentWalletError("wallet_locked", "Solana seed is unavailable");
    }
    scheme = "ed25519";
    const keyPair = nacl.sign.keyPair.fromSeed(Buffer.from(options.wallet.secret.seedBase64, "base64"));
    value = Buffer.from(nacl.sign.detached(Buffer.from(message, "utf8"), keyPair.secretKey)).toString(
      "base64",
    );
  }
  return { version: 1, intent, signature: { scheme, value } };
}

function responseBody(value: unknown): {
  notificationId: string;
  status: "accepted" | "deduplicated" | "not_required";
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("notification response is malformed");
  }
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => !["version", "notificationId", "status"].includes(key)) ||
    body.version !== 1 ||
    typeof body.notificationId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(body.notificationId) ||
    typeof body.status !== "string" ||
    !["accepted", "deduplicated", "not_required"].includes(body.status)
  ) {
    throw new Error("notification response failed validation");
  }
  return body as {
    notificationId: string;
    status: "accepted" | "deduplicated" | "not_required";
  };
}

export async function requestRefillNotification(options: {
  walletsDirectory: string;
  wallet: string;
  passphrase: string;
  rpc: RpcConfiguration;
  notificationUrl: string;
  subscriptionReference: string;
  targetBalanceAtomic: string;
  renewBy: string;
  reason: RefillReason;
}): Promise<RefillNotificationResult> {
  if (!DECIMAL.test(options.targetBalanceAtomic)) {
    throw new AgentWalletError("invalid_input", "target balance is not canonical decimal");
  }
  const endpoint = validateNotificationUrl(options.notificationUrl);
  if (!REFERENCE.test(options.subscriptionReference)) {
    throw new AgentWalletError(
      "invalid_input",
      "subscription reference must contain 1-128 safe identifier characters",
    );
  }
  if (!(["low_balance", "renewal"] as const).includes(options.reason)) {
    throw new AgentWalletError("invalid_input", "refill reason is unsupported");
  }
  const renewBy = canonicalRenewBy(options.renewBy, Date.now());
  const wallet = await unlockWallet(options.walletsDirectory, options.wallet, options.passphrase);
  const balance = await readWalletBalance({
    network: wallet.metadata.network,
    address: wallet.metadata.address,
    rpc: options.rpc,
  });
  const target = BigInt(options.targetBalanceAtomic);
  const current = BigInt(balance.assetAtomic);
  const common = {
    version: 1 as const,
    wallet: wallet.metadata.name,
    network: wallet.metadata.network,
    address: wallet.metadata.address,
    asset: balance.asset,
    assetSymbol: balance.assetSymbol,
    currentBalanceAtomic: balance.assetAtomic,
    targetBalanceAtomic: options.targetBalanceAtomic,
    refillAmountAtomic: (target > current ? target - current : 0n).toString(),
    renewBy,
    subscriptionReference: options.subscriptionReference,
  };
  if (current >= target) {
    return { ...common, status: "not_required" };
  }
  const signed = await createSignedRefillNotification({
    wallet,
    balance,
    notificationUrl: endpoint,
    subscriptionReference: options.subscriptionReference,
    targetBalanceAtomic: options.targetBalanceAtomic,
    renewBy,
    reason: options.reason,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signed),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok || text.length > 64 * 1024) {
      throw new Error(`notification service returned HTTP ${response.status}`);
    }
    const delivered = responseBody(JSON.parse(text) as unknown);
    return {
      ...common,
      status: delivered.status,
      notificationId: delivered.notificationId,
    };
  } catch (error) {
    if (error instanceof AgentWalletError) throw error;
    throw new AgentWalletError(
      "notification_unavailable",
      "x402api could not accept the refill notification",
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
}
