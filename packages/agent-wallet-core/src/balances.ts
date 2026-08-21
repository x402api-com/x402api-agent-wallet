import { TronWeb } from "tronweb";

import { AgentWalletError } from "./errors.js";
import {
  BASE_USDC_MAINNET_CONTRACT,
} from "./protocol/base.js";
import {
  SOLANA_USDC_MAINNET_MINT,
  SOLANA_USDT_MAINNET_MINT,
} from "./protocol/solana.js";
import { TRON_USDT_MAINNET_CONTRACT } from "./protocol/tron.js";
import type { SupportedNetwork } from "./storage/keystore.js";

export const SOLANA_MAINNET_GENESIS_HASH =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const TRON_MAINNET_GENESIS_BLOCK_ID =
  "00000000000000001ebf88508a03865c71d452e25f4d51194196a1d22b6653dc";

export type RpcConfiguration = {
  base?: string;
  solana?: string;
  tron?: string;
};

export type WalletBalance = {
  version: 1;
  network: SupportedNetwork;
  address: string;
  asset: string;
  assetSymbol: "USDC" | "USDT";
  assetAtomic: string;
  nativeSymbol: "ETH" | "SOL" | "TRX";
  nativeAtomic: string;
  feeResources?: {
    energyAvailable: string;
    bandwidthAvailable: string;
  };
  checkedAt: string;
};

export function validateRpcUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AgentWalletError("rpc_not_configured", `${label} RPC URL is invalid`, {
      cause: error,
    });
  }
  const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  if (
    (!local && url.protocol !== "https:") ||
    (local && !["http:", "https:"].includes(url.protocol)) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new AgentWalletError(
      "rpc_not_configured",
      `${label} RPC URL must be credential-free HTTPS (HTTP is allowed only for localhost)`,
    );
  }
  return url.toString();
}

export async function jsonRpc(
  endpoint: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok || text.length > 1024 * 1024) {
      throw new Error(`RPC returned HTTP ${response.status}`);
    }
    const body = JSON.parse(text) as unknown;
    if (typeof body !== "object" || body === null || !("result" in body)) {
      throw new Error("RPC response has no result");
    }
    return (body as { result: unknown }).result;
  } catch (error) {
    throw new AgentWalletError("rpc_unavailable", `${method} RPC request failed`, {
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function hexQuantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    throw new AgentWalletError("rpc_unavailable", `${field} is not a canonical hex quantity`);
  }
  return BigInt(value);
}

async function baseBalance(endpoint: string, address: string): Promise<WalletBalance> {
  const paddedAddress = address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const [chainId, native, token] = await Promise.all([
    jsonRpc(endpoint, "eth_chainId", []),
    jsonRpc(endpoint, "eth_getBalance", [address, "latest"]),
    jsonRpc(endpoint, "eth_call", [
      {
        to: BASE_USDC_MAINNET_CONTRACT,
        data: `0x70a08231${paddedAddress}`,
      },
      "latest",
    ]),
  ]);
  if (chainId !== "0x2105") {
    throw new AgentWalletError("unsupported_network", "Base RPC is not chain ID 8453");
  }
  return {
    version: 1,
    network: "eip155:8453",
    address,
    asset: BASE_USDC_MAINNET_CONTRACT,
    assetSymbol: "USDC",
    assetAtomic: hexQuantity(token, "USDC balance").toString(),
    nativeSymbol: "ETH",
    nativeAtomic: hexQuantity(native, "ETH balance").toString(),
    checkedAt: new Date().toISOString(),
  };
}

async function solanaBalance(
  endpoint: string,
  address: string,
  selectedAsset: string = SOLANA_USDT_MAINNET_MINT,
): Promise<WalletBalance> {
  if (![SOLANA_USDC_MAINNET_MINT, SOLANA_USDT_MAINNET_MINT].includes(selectedAsset)) {
    throw new AgentWalletError("unsupported_asset", "unsupported Solana stablecoin mint");
  }
  const [genesisHash, nativeResult, tokenResult] = await Promise.all([
    jsonRpc(endpoint, "getGenesisHash", []),
    jsonRpc(endpoint, "getBalance", [address, { commitment: "confirmed" }]),
    jsonRpc(endpoint, "getTokenAccountsByOwner", [
      address,
      { mint: selectedAsset },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]),
  ]);
  if (genesisHash !== SOLANA_MAINNET_GENESIS_HASH) {
    throw new AgentWalletError("unsupported_network", "Solana RPC is not Mainnet Beta");
  }
  const native =
    typeof nativeResult === "object" &&
    nativeResult !== null &&
    "value" in nativeResult &&
    typeof nativeResult.value === "number" &&
    Number.isSafeInteger(nativeResult.value)
      ? BigInt(nativeResult.value)
      : null;
  if (native === null) {
    throw new AgentWalletError("rpc_unavailable", "Solana RPC returned an invalid SOL balance");
  }
  const accounts =
    typeof tokenResult === "object" &&
    tokenResult !== null &&
    "value" in tokenResult &&
    Array.isArray(tokenResult.value)
      ? tokenResult.value
      : null;
  if (accounts === null) {
    throw new AgentWalletError("rpc_unavailable", "Solana RPC returned invalid token accounts");
  }
  let asset = 0n;
  for (const account of accounts) {
    const amount =
      typeof account === "object" &&
      account !== null &&
      "account" in account &&
      typeof account.account === "object" &&
      account.account !== null &&
      "data" in account.account &&
      typeof account.account.data === "object" &&
      account.account.data !== null &&
      "parsed" in account.account.data &&
      typeof account.account.data.parsed === "object" &&
      account.account.data.parsed !== null &&
      "info" in account.account.data.parsed &&
      typeof account.account.data.parsed.info === "object" &&
      account.account.data.parsed.info !== null &&
      "tokenAmount" in account.account.data.parsed.info &&
      typeof account.account.data.parsed.info.tokenAmount === "object" &&
      account.account.data.parsed.info.tokenAmount !== null &&
      "amount" in account.account.data.parsed.info.tokenAmount
        ? account.account.data.parsed.info.tokenAmount.amount
        : null;
    if (typeof amount !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(amount)) {
      throw new AgentWalletError("rpc_unavailable", "Solana token amount is malformed");
    }
    asset += BigInt(amount);
  }
  return {
    version: 1,
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    address,
    asset: selectedAsset,
    assetSymbol: selectedAsset === SOLANA_USDC_MAINNET_MINT ? "USDC" : "USDT",
    assetAtomic: asset.toString(),
    nativeSymbol: "SOL",
    nativeAtomic: native.toString(),
    checkedAt: new Date().toISOString(),
  };
}

function bigintString(value: unknown, field: string): string {
  try {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return String(value);
    }
    if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)) return value;
    if (typeof value === "object" && value !== null && "toString" in value) {
      const result = String(value);
      if (/^(?:0|[1-9][0-9]*)$/.test(result)) return result;
    }
  } catch {
    // Normalize to one stable error below.
  }
  throw new AgentWalletError("rpc_unavailable", `${field} is malformed`);
}

export async function verifyTronMainnetRpc(endpoint: string): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const base = endpoint.endsWith("/") ? endpoint : `${endpoint}/`;
    const response = await fetch(new URL("wallet/getblockbynum", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ num: 0 }),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok || text.length > 2 * 1024 * 1024) {
      throw new Error(`TRON RPC returned HTTP ${response.status}`);
    }
    const body = JSON.parse(text) as unknown;
    if (
      typeof body !== "object" ||
      body === null ||
      !("blockID" in body) ||
      body.blockID !== TRON_MAINNET_GENESIS_BLOCK_ID
    ) {
      throw new AgentWalletError(
        "unsupported_network",
        "TRON RPC genesis block is not Mainnet",
      );
    }
  } catch (error) {
    if (error instanceof AgentWalletError) throw error;
    throw new AgentWalletError("rpc_unavailable", "TRON genesis check failed", {
      retryable: true,
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function tronBalance(endpoint: string, address: string): Promise<WalletBalance> {
  try {
    await verifyTronMainnetRpc(endpoint);
    const tronWeb = new TronWeb({ fullHost: endpoint });
    const [native, contract, resources] = await Promise.all([
      tronWeb.trx.getBalance(address),
      tronWeb.contract().at(TRON_USDT_MAINNET_CONTRACT),
      tronWeb.trx.getAccountResources(address),
    ]);
    const token = await contract.balanceOf(address).call();
    const resourceRecord = resources as unknown as Record<string, unknown>;
    const energyLimit = BigInt(bigintString(resourceRecord.EnergyLimit ?? 0, "TRON energy limit"));
    const energyUsed = BigInt(bigintString(resourceRecord.EnergyUsed ?? 0, "TRON energy used"));
    const bandwidthLimit =
      BigInt(bigintString(resourceRecord.freeNetLimit ?? 0, "TRON bandwidth limit")) +
      BigInt(bigintString(resourceRecord.NetLimit ?? 0, "TRON staked bandwidth limit"));
    const bandwidthUsed =
      BigInt(bigintString(resourceRecord.freeNetUsed ?? 0, "TRON bandwidth used")) +
      BigInt(bigintString(resourceRecord.NetUsed ?? 0, "TRON staked bandwidth used"));
    return {
      version: 1,
      network: "tron:mainnet",
      address,
      asset: TRON_USDT_MAINNET_CONTRACT,
      assetSymbol: "USDT",
      assetAtomic: bigintString(token, "TRON USDT balance"),
      nativeSymbol: "TRX",
      nativeAtomic: bigintString(native, "TRX balance"),
      feeResources: {
        energyAvailable: (energyLimit > energyUsed ? energyLimit - energyUsed : 0n).toString(),
        bandwidthAvailable: (
          bandwidthLimit > bandwidthUsed ? bandwidthLimit - bandwidthUsed : 0n
        ).toString(),
      },
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof AgentWalletError) throw error;
    throw new AgentWalletError("rpc_unavailable", "TRON balance request failed", {
      retryable: true,
      cause: error,
    });
  }
}

export async function readWalletBalance(options: {
  network: SupportedNetwork;
  address: string;
  rpc: RpcConfiguration;
  asset?: string;
}): Promise<WalletBalance> {
  if (options.network === "eip155:8453") {
    if (!options.rpc.base) throw new AgentWalletError("rpc_not_configured", "Base RPC is required");
    return baseBalance(validateRpcUrl(options.rpc.base, "Base"), options.address);
  }
  if (options.network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") {
    if (!options.rpc.solana) {
      throw new AgentWalletError("rpc_not_configured", "Solana RPC is required");
    }
    return solanaBalance(
      validateRpcUrl(options.rpc.solana, "Solana"),
      options.address,
      options.asset,
    );
  }
  if (!options.rpc.tron) throw new AgentWalletError("rpc_not_configured", "TRON RPC is required");
  return tronBalance(validateRpcUrl(options.rpc.tron, "TRON"), options.address);
}
