import { resolve } from "node:path";

import {
  Wallet,
  type TransactionRequest,
  type TypedDataDomain,
  type TypedDataField,
} from "ethers";
import { TronWeb } from "tronweb";
import nacl from "tweetnacl";

import {
  jsonRpc,
  readWalletBalance,
  SOLANA_MAINNET_GENESIS_HASH,
  validateRpcUrl,
  type RpcConfiguration,
} from "../balances.js";
import { AgentWalletError } from "../errors.js";
import {
  BASE_MAINNET_NETWORK,
  BASE_USDC_BUYER_FUNDED_PROFILE,
  BASE_USDC_MAINNET_CONTRACT,
  buildBaseUsdcAuthorization,
  buildBaseUsdcEip1559TransactionRequest,
  encodeBaseUsdcTransferWithAuthorization,
  verifyBuyerSignedBaseUsdcTransaction,
} from "../protocol/base.js";
import { verifyExternalRecipientDeclaration } from "../protocol/external-recipient.js";
import {
  createPaymentPayload,
  encodePaymentSignature,
  type JsonObject,
  type PaymentRequired,
  type PaymentRequirement,
} from "../protocol/http.js";
import {
  createSolanaPayment,
  SOLANA_MAINNET_NETWORK,
  SOLANA_USDT_BUYER_FUNDED_PROFILE,
  SOLANA_USDT_MAINNET_MINT,
  type SolanaRpc,
  type SolanaWalletTransport,
} from "../protocol/solana.js";
import {
  createTronUsdtPayment,
  TRON_MAINNET_CHAIN_ID,
  TRON_USDT_MAINNET_CONTRACT,
  TronWebTransactionBuilder,
  type TronTransactionParts,
  type TronWalletProvider,
} from "../protocol/tron.js";
import { unlockWallet, type UnlockedWallet } from "../storage/keystore.js";
import { AttemptStore } from "./attempt-store.js";
import {
  createBuyerPaymentIdentifier,
  loadRequestEnvelope,
  requirementDigest,
} from "./contracts.js";

export type AuthorizationResult = {
  version: 1;
  attemptId: string;
  wallet: string;
  payerAddress: string;
  network: string;
  asset: string;
  amountAtomic: string;
  artifactPath: string;
  state: "authorized";
};

function payloadProfile(requirement: PaymentRequirement): string | null {
  const value = requirement.extra.payloadProfile;
  return typeof value === "string" ? value : null;
}

function selectRequirement(
  paymentRequired: PaymentRequired,
  wallet: UnlockedWallet["metadata"],
): PaymentRequirement {
  const networkMatches = paymentRequired.accepts.filter(
    (requirement) => requirement.network === wallet.network,
  );
  if (networkMatches.length === 0) {
    throw new AgentWalletError(
      "unsupported_network",
      "challenge does not advertise the wallet network",
    );
  }
  const expected =
    wallet.network === BASE_MAINNET_NETWORK
      ? {
          asset: BASE_USDC_MAINNET_CONTRACT.toLowerCase(),
          profile: BASE_USDC_BUYER_FUNDED_PROFILE,
        }
      : wallet.network === SOLANA_MAINNET_NETWORK
        ? {
            asset: SOLANA_USDT_MAINNET_MINT,
            profile: SOLANA_USDT_BUYER_FUNDED_PROFILE,
          }
        : {
            asset: TRON_USDT_MAINNET_CONTRACT,
            profile: "com.k1hub.x402.tron-exact.v1",
          };
  const assetMatches = networkMatches.filter((requirement) =>
    wallet.network === BASE_MAINNET_NETWORK
      ? requirement.asset.toLowerCase() === expected.asset
      : requirement.asset === expected.asset,
  );
  if (assetMatches.length === 0) {
    throw new AgentWalletError(
      "unsupported_asset",
      "challenge does not advertise the exact supported asset",
    );
  }
  const profileMatches = assetMatches.filter(
    (requirement) => payloadProfile(requirement) === expected.profile,
  );
  if (profileMatches.length !== 1) {
    throw new AgentWalletError(
      "unsupported_profile",
      "challenge must advertise exactly one supported payload profile",
    );
  }
  return profileMatches[0]!;
}

function enforceLocalPolicy(wallet: UnlockedWallet["metadata"], amount: string): void {
  if (
    wallet.maximumPaymentAtomic !== undefined &&
    BigInt(amount) > BigInt(wallet.maximumPaymentAtomic)
  ) {
    throw new AgentWalletError(
      "payment_limit_exceeded",
      "payment amount exceeds the wallet's local per-payment ceiling",
      {
        details: {
          amountAtomic: amount,
          maximumPaymentAtomic: wallet.maximumPaymentAtomic,
        },
      },
    );
  }
}

async function enforceBalances(options: {
  wallet: UnlockedWallet["metadata"];
  amount: string;
  rpc: RpcConfiguration;
}): Promise<void> {
  const balance = await readWalletBalance({
    network: options.wallet.network,
    address: options.wallet.address,
    rpc: options.rpc,
  });
  if (BigInt(balance.assetAtomic) < BigInt(options.amount)) {
    throw new AgentWalletError(
      "insufficient_asset_balance",
      `${balance.assetSymbol} balance is below the exact payment amount`,
      {
        details: {
          requiredAtomic: options.amount,
          availableAtomic: balance.assetAtomic,
        },
      },
    );
  }
  if (
    BigInt(balance.nativeAtomic) === 0n &&
    (balance.network !== "tron:mainnet" ||
      BigInt(balance.feeResources?.energyAvailable ?? "0") === 0n)
  ) {
    throw new AgentWalletError(
      "insufficient_network_fee_resources",
      `${balance.nativeSymbol} or network fee resources are required`,
    );
  }
}

function typedDataParts(value: JsonObject): {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  message: Record<string, unknown>;
} {
  const domain = value.domain;
  const types = value.types;
  const message = value.message;
  if (
    typeof domain !== "object" ||
    domain === null ||
    Array.isArray(domain) ||
    typeof types !== "object" ||
    types === null ||
    Array.isArray(types) ||
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message)
  ) {
    throw new AgentWalletError("request_binding_mismatch", "Base typed data is malformed");
  }
  const transfer = (types as Record<string, unknown>).TransferWithAuthorization;
  if (!Array.isArray(transfer)) {
    throw new AgentWalletError("request_binding_mismatch", "Base typed data types are malformed");
  }
  return {
    domain: domain as TypedDataDomain,
    types: {
      TransferWithAuthorization: transfer as unknown as TypedDataField[],
    },
    message: message as Record<string, unknown>,
  };
}

function requestFromJson(value: JsonObject): TransactionRequest {
  const required = [
    "chainId",
    "nonce",
    "gas",
    "maxFeePerGas",
    "maxPriorityFeePerGas",
    "to",
    "value",
    "data",
  ];
  if (required.some((key) => typeof value[key] !== "string")) {
    throw new AgentWalletError("request_binding_mismatch", "Base transaction request is malformed");
  }
  return {
    type: 2,
    chainId: BigInt(value.chainId as string),
    nonce: Number(BigInt(value.nonce as string)),
    gasLimit: BigInt(value.gas as string),
    maxFeePerGas: BigInt(value.maxFeePerGas as string),
    maxPriorityFeePerGas: BigInt(value.maxPriorityFeePerGas as string),
    to: value.to as string,
    value: BigInt(value.value as string),
    data: value.data as string,
    accessList: [],
  };
}

async function basePayment(options: {
  wallet: UnlockedWallet;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  challengeDigest: string;
  buyerPaymentIdentifier: string;
  rpc: string;
}): Promise<string> {
  if (!options.wallet.secret.privateKeyHex) {
    throw new AgentWalletError("wallet_locked", "Base private key is unavailable");
  }
  const endpoint = validateRpcUrl(options.rpc, "Base");
  const chainId = await jsonRpc(endpoint, "eth_chainId", []);
  if (chainId !== "0x2105") {
    throw new AgentWalletError("unsupported_network", "Base RPC is not chain ID 8453");
  }
  await verifyExternalRecipientDeclaration({
    paymentRequired: options.paymentRequired,
    accepted: options.accepted,
  });
  const signer = new Wallet(`0x${options.wallet.secret.privateKeyHex}`);
  const material = buildBaseUsdcAuthorization({
    accepted: options.accepted,
    payer: signer.address,
    nowSeconds: Math.floor(Date.now() / 1000),
    challengeDigest: options.challengeDigest,
  });
  const typed = typedDataParts(material.typedData);
  const authorizationSignature = await signer.signTypedData(
    typed.domain,
    typed.types,
    typed.message,
  );
  const data = encodeBaseUsdcTransferWithAuthorization({
    authorization: material.authorization,
    signature: authorizationSignature,
  });
  const [nonceRaw, blockRaw, priorityRaw] = await Promise.all([
    jsonRpc(endpoint, "eth_getTransactionCount", [signer.address, "pending"]),
    jsonRpc(endpoint, "eth_getBlockByNumber", ["latest", false]),
    jsonRpc(endpoint, "eth_maxPriorityFeePerGas", []),
  ]);
  if (
    typeof nonceRaw !== "string" ||
    typeof priorityRaw !== "string" ||
    typeof blockRaw !== "object" ||
    blockRaw === null ||
    !("baseFeePerGas" in blockRaw) ||
    typeof blockRaw.baseFeePerGas !== "string"
  ) {
    throw new AgentWalletError("rpc_unavailable", "Base fee policy is unavailable");
  }
  const priority = BigInt(priorityRaw);
  const maxFee = BigInt(blockRaw.baseFeePerGas) * 2n + priority;
  const provisional = buildBaseUsdcEip1559TransactionRequest({
    accepted: options.accepted,
    payer: signer.address,
    data,
    policy: {
      nonce: BigInt(nonceRaw),
      gasLimit: 150_000n,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priority,
    },
  });
  const estimatedRaw = await jsonRpc(endpoint, "eth_estimateGas", [provisional]);
  if (typeof estimatedRaw !== "string") {
    throw new AgentWalletError("rpc_unavailable", "Base gas estimate is unavailable");
  }
  const estimated = BigInt(estimatedRaw);
  const gasLimit = (estimated * 120n + 99n) / 100n;
  const request = buildBaseUsdcEip1559TransactionRequest({
    accepted: options.accepted,
    payer: signer.address,
    data,
    policy: {
      nonce: BigInt(nonceRaw),
      gasLimit,
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: priority,
    },
  });
  const signedTransaction = await signer.signTransaction(requestFromJson(request));
  verifyBuyerSignedBaseUsdcTransaction({ signedTransaction, request });
  return encodePaymentSignature(
    createPaymentPayload({
      paymentRequired: options.paymentRequired,
      accepted: options.accepted,
      paymentIdentifier: options.buyerPaymentIdentifier,
      schemePayload: { transaction: signedTransaction },
    }),
  );
}

async function solanaPayment(options: {
  wallet: UnlockedWallet;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  buyerPaymentIdentifier: string;
  rpc: string;
}): Promise<string> {
  if (!options.wallet.secret.seedBase64) {
    throw new AgentWalletError("wallet_locked", "Solana seed is unavailable");
  }
  const endpoint = validateRpcUrl(options.rpc, "Solana");
  const genesis = await jsonRpc(endpoint, "getGenesisHash", []);
  if (genesis !== SOLANA_MAINNET_GENESIS_HASH) {
    throw new AgentWalletError("unsupported_network", "Solana RPC is not Mainnet Beta");
  }
  const seed = Buffer.from(options.wallet.secret.seedBase64, "base64");
  const keyPair = nacl.sign.keyPair.fromSeed(seed);
  const rpc: SolanaRpc = {
    latestBlockhash: async () => {
      const result = await jsonRpc(endpoint, "getLatestBlockhash", [
        { commitment: "confirmed" },
      ]);
      const blockhash =
        typeof result === "object" &&
        result !== null &&
        "value" in result &&
        typeof result.value === "object" &&
        result.value !== null &&
        "blockhash" in result.value
          ? result.value.blockhash
          : null;
      if (typeof blockhash !== "string") {
        throw new AgentWalletError("rpc_unavailable", "Solana blockhash is unavailable");
      }
      return blockhash;
    },
  };
  const transport: SolanaWalletTransport = {
    connect: async () => options.wallet.metadata.address,
    signTransaction: async ({ transactionBase64 }) => {
      const transaction = Buffer.from(transactionBase64, "base64");
      if (transaction[0] !== 1 || transaction.length < 66) {
        throw new AgentWalletError("request_binding_mismatch", "Solana transaction is malformed");
      }
      const message = transaction.subarray(65);
      const signature = nacl.sign.detached(message, keyPair.secretKey);
      const signed = Buffer.from(transaction);
      signed.set(signature, 1);
      return signed.toString("base64");
    },
  };
  return encodePaymentSignature(
    await createSolanaPayment({
      rpc,
      wallet: transport,
      paymentRequired: options.paymentRequired,
      accepted: options.accepted,
      buyerPaymentIdentifier: options.buyerPaymentIdentifier,
    }),
  );
}

async function tronPayment(options: {
  wallet: UnlockedWallet;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  buyerPaymentIdentifier: string;
  rpc: string;
}): Promise<string> {
  if (!options.wallet.secret.privateKeyHex) {
    throw new AgentWalletError("wallet_locked", "TRON private key is unavailable");
  }
  const endpoint = validateRpcUrl(options.rpc, "TRON");
  const tronWeb = new TronWeb({
    fullHost: endpoint,
    privateKey: options.wallet.secret.privateKeyHex,
  });
  const provider: TronWalletProvider = {
    requestAccounts: async () => [options.wallet.metadata.address],
    getNetwork: async () => ({ networkType: "Mainnet", chainId: TRON_MAINNET_CHAIN_ID }),
    signTransaction: async (transaction: TronTransactionParts) => {
      if (!transaction.walletDocument) {
        throw new AgentWalletError("request_binding_mismatch", "TRON wallet document is missing");
      }
      const signed = (await tronWeb.trx.sign(
        transaction.walletDocument as never,
        options.wallet.secret.privateKeyHex,
      )) as unknown as JsonObject;
      const result: TronTransactionParts = {
        txID: String(signed.txID),
        raw_data_hex: String(signed.raw_data_hex),
        walletDocument: signed,
      };
      if (Array.isArray(signed.signature)) {
        result.signature = signed.signature.map((value) => String(value));
      }
      return result;
    },
    disconnect: async () => undefined,
  };
  const builder = new TronWebTransactionBuilder({
    tronWeb: tronWeb as unknown as ConstructorParameters<typeof TronWebTransactionBuilder>[0]["tronWeb"],
    feeLimitSun: 150_000_000,
  });
  return encodePaymentSignature(
    await createTronUsdtPayment({
      builder,
      provider,
      paymentRequired: options.paymentRequired,
      accepted: options.accepted,
      buyerPaymentIdentifier: options.buyerPaymentIdentifier,
      trustedAssetContracts: [TRON_USDT_MAINNET_CONTRACT],
      maxFeeLimitSun: 150_000_000,
    }),
  );
}

export async function authorizePayment(options: {
  walletsDirectory: string;
  attemptsDirectory: string;
  wallet: string;
  passphrase: string;
  requestEnvelopePath: string;
  artifactPath: string;
  rpc: RpcConfiguration;
}): Promise<AuthorizationResult> {
  const unlocked = await unlockWallet(
    options.walletsDirectory,
    options.wallet,
    options.passphrase,
  );
  const loaded = await loadRequestEnvelope(options.requestEnvelopePath);
  const accepted = selectRequirement(loaded.paymentRequired, unlocked.metadata);
  enforceLocalPolicy(unlocked.metadata, accepted.amount);
  const store = new AttemptStore(options.attemptsDirectory);
  const existing = await store.findByRequestDigest(loaded.requestDigest);
  if (existing !== null && !["terminal_failed", "abandoned_local"].includes(existing.state)) {
    throw new AgentWalletError(
      "attempt_already_exists",
      "reuse the existing payment attempt for this exact request",
      { details: { attemptId: existing.attemptId, state: existing.state } },
    );
  }
  await enforceBalances({
    wallet: unlocked.metadata,
    amount: accepted.amount,
    rpc: options.rpc,
  });
  const buyerPaymentIdentifier = createBuyerPaymentIdentifier();
  let paymentSignature: string;
  if (unlocked.metadata.network === BASE_MAINNET_NETWORK) {
    if (!options.rpc.base) throw new AgentWalletError("rpc_not_configured", "Base RPC is required");
    paymentSignature = await basePayment({
      wallet: unlocked,
      paymentRequired: loaded.paymentRequired,
      accepted,
      challengeDigest: loaded.envelope.challengeDigest,
      buyerPaymentIdentifier,
      rpc: options.rpc.base,
    });
  } else if (unlocked.metadata.network === SOLANA_MAINNET_NETWORK) {
    if (!options.rpc.solana) {
      throw new AgentWalletError("rpc_not_configured", "Solana RPC is required");
    }
    paymentSignature = await solanaPayment({
      wallet: unlocked,
      paymentRequired: loaded.paymentRequired,
      accepted,
      buyerPaymentIdentifier,
      rpc: options.rpc.solana,
    });
  } else {
    if (!options.rpc.tron) throw new AgentWalletError("rpc_not_configured", "TRON RPC is required");
    paymentSignature = await tronPayment({
      wallet: unlocked,
      paymentRequired: loaded.paymentRequired,
      accepted,
      buyerPaymentIdentifier,
      rpc: options.rpc.tron,
    });
  }
  const selectedRequirementDigest = requirementDigest(accepted);
  const expiresAt = new Date(
    Date.now() + Math.min(accepted.maxTimeoutSeconds, 3600) * 1000,
  ).toISOString();
  const { record } = await store.persistAuthorized({
    requestDigest: loaded.requestDigest,
    challengeDigest: loaded.envelope.challengeDigest,
    selectedRequirementDigest,
    buyerPaymentIdentifier,
    wallet: unlocked.metadata.name,
    network: unlocked.metadata.network,
    payerAddress: unlocked.metadata.address,
    paymentSignature,
    artifactPath: resolve(options.artifactPath),
    expiresAt,
  });
  return {
    version: 1,
    attemptId: record.attemptId,
    wallet: unlocked.metadata.name,
    payerAddress: unlocked.metadata.address,
    network: unlocked.metadata.network,
    asset: accepted.asset,
    amountAtomic: accepted.amount,
    artifactPath: record.artifactPath,
    state: "authorized",
  };
}
