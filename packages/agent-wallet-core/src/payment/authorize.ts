import { resolve } from "node:path";

import { Wallet, type TypedDataDomain, type TypedDataField } from "ethers";
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
  BASE_USDC_SPONSORED_PROFILE,
  BASE_USDC_MAINNET_CONTRACT,
  buildBaseUsdcAuthorization,
  encodeBaseUsdcTransferWithAuthorization,
} from "../protocol/base.js";
import { verifyExternalRecipientDeclaration } from "../protocol/external-recipient.js";
import {
  createPaymentPayload,
  encodePaymentSignature,
  GAS_SPONSORSHIP_EXTENSION,
  type JsonObject,
  type PaymentRequired,
  type PaymentRequirement,
} from "../protocol/http.js";
import {
  createSponsoredSolanaPayment,
  SOLANA_MAINNET_NETWORK,
  SOLANA_SPONSORED_PROFILE,
  SOLANA_USDC_MAINNET_MINT,
  SOLANA_USDT_MAINNET_MINT,
  type SolanaRpc,
  type SolanaWalletTransport,
} from "../protocol/solana.js";
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

function sponsored(requirement: PaymentRequirement): boolean {
  return [BASE_USDC_SPONSORED_PROFILE, SOLANA_SPONSORED_PROFILE].includes(
    String(payloadProfile(requirement)),
  );
}

function selectRequirement(
  paymentRequired: PaymentRequired,
  wallet: UnlockedWallet["metadata"],
  now: Date,
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
          profiles: [BASE_USDC_SPONSORED_PROFILE],
        }
      : wallet.network === SOLANA_MAINNET_NETWORK
        ? {
            assets: [SOLANA_USDC_MAINNET_MINT, SOLANA_USDT_MAINNET_MINT],
            profiles: [SOLANA_SPONSORED_PROFILE],
          }
        : null;
  if (expected === null) {
    throw new AgentWalletError(
      "unsupported_profile",
      "TRON payments are coming soon and are not enabled in the launch payer",
    );
  }
  const assetMatches = networkMatches.filter((requirement) =>
    wallet.network === BASE_MAINNET_NETWORK
      ? requirement.asset.toLowerCase() === expected.asset
      : "assets" in expected
        ? expected.assets.includes(requirement.asset)
        : requirement.asset === expected.asset,
  );
  if (assetMatches.length === 0) {
    throw new AgentWalletError(
      "unsupported_asset",
      "challenge does not advertise the exact supported asset",
    );
  }
  const profileMatches = assetMatches.filter((requirement) =>
    expected.profiles.includes(String(payloadProfile(requirement))),
  );
  const selected = profileMatches.find((requirement) => sponsored(requirement));
  if (!selected) {
    throw new AgentWalletError(
      "unsupported_profile",
      "challenge must advertise a sponsored launch payload profile",
    );
  }
  const declaration = paymentRequired.extensions?.[GAS_SPONSORSHIP_EXTENSION];
  const requirements = declaration?.info.requirements;
  const bound =
    Array.isArray(requirements) &&
    requirements.some(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        !Array.isArray(item) &&
        item.network === selected.network &&
        item.asset === selected.asset &&
        item.payloadProfile === payloadProfile(selected),
    );
  if (!bound) {
    throw new AgentWalletError(
      "sponsored_payload_invalid",
      "sponsored requirement is not bound by the gas-sponsorship extension",
    );
  }
  const sponsorshipExpiresAt = declaration?.info.expiresAt;
  if (
    typeof sponsorshipExpiresAt !== "string" ||
    Date.parse(sponsorshipExpiresAt) <= now.getTime()
  ) {
    throw new AgentWalletError(
      "sponsorship_reservation_expired",
      "the sponsored gas reservation has expired",
    );
  }
  return selected;
}

function enforceLocalPolicy(
  wallet: UnlockedWallet["metadata"],
  amount: string,
): void {
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
  asset: string;
  sponsored: boolean;
}): Promise<void> {
  const balance = await readWalletBalance({
    network: options.wallet.network,
    address: options.wallet.address,
    rpc: options.rpc,
    asset: options.asset,
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
    !options.sponsored &&
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
    throw new AgentWalletError(
      "request_binding_mismatch",
      "Base typed data is malformed",
    );
  }
  const transfer = (types as Record<string, unknown>).TransferWithAuthorization;
  if (!Array.isArray(transfer)) {
    throw new AgentWalletError(
      "request_binding_mismatch",
      "Base typed data types are malformed",
    );
  }
  return {
    domain: domain as TypedDataDomain,
    types: {
      TransferWithAuthorization: transfer as unknown as TypedDataField[],
    },
    message: message as Record<string, unknown>,
  };
}

async function basePayment(options: {
  wallet: UnlockedWallet;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  challengeDigest: string;
  buyerPaymentIdentifier: string;
  rpc: string;
  now: Date;
}): Promise<string> {
  if (!options.wallet.secret.privateKeyHex) {
    throw new AgentWalletError(
      "wallet_locked",
      "Base private key is unavailable",
    );
  }
  const endpoint = validateRpcUrl(options.rpc, "Base");
  const chainId = await jsonRpc(endpoint, "eth_chainId", []);
  if (chainId !== "0x2105") {
    throw new AgentWalletError(
      "unsupported_network",
      "Base RPC is not chain ID 8453",
    );
  }
  await verifyExternalRecipientDeclaration({
    paymentRequired: options.paymentRequired,
    accepted: options.accepted,
  });
  const signer = new Wallet(`0x${options.wallet.secret.privateKeyHex}`);
  const material = buildBaseUsdcAuthorization({
    accepted: options.accepted,
    payer: signer.address,
    nowSeconds: Math.floor(options.now.getTime() / 1000),
    challengeDigest: options.challengeDigest,
  });
  const typed = typedDataParts(material.typedData);
  const authorizationSignature = await signer.signTypedData(
    typed.domain,
    typed.types,
    typed.message,
  );
  encodeBaseUsdcTransferWithAuthorization({
    authorization: material.authorization,
    signature: authorizationSignature,
  });
  return encodePaymentSignature(
    createPaymentPayload({
      paymentRequired: options.paymentRequired,
      accepted: options.accepted,
      paymentIdentifier: options.buyerPaymentIdentifier,
      schemePayload: {
        authorization: material.authorization,
        signature: authorizationSignature,
      },
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
    throw new AgentWalletError(
      "unsupported_network",
      "Solana RPC is not Mainnet Beta",
    );
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
        throw new AgentWalletError(
          "rpc_unavailable",
          "Solana blockhash is unavailable",
        );
      }
      return blockhash;
    },
  };
  const transport: SolanaWalletTransport = {
    connect: async () => options.wallet.metadata.address,
    signTransaction: async ({ transactionBase64 }) => {
      const transaction = Buffer.from(transactionBase64, "base64");
      const signatureCount = 2;
      const messageOffset = 1 + signatureCount * 64;
      if (
        transaction[0] !== signatureCount ||
        transaction.length <= messageOffset
      ) {
        throw new AgentWalletError(
          "request_binding_mismatch",
          "Solana transaction is malformed",
        );
      }
      const message = transaction.subarray(messageOffset);
      const signature = nacl.sign.detached(message, keyPair.secretKey);
      const signed = Buffer.from(transaction);
      signed.set(signature, 65);
      return signed.toString("base64");
    },
  };
  return encodePaymentSignature(
    await createSponsoredSolanaPayment({
      rpc,
      wallet: transport,
      paymentRequired: options.paymentRequired,
      accepted: options.accepted,
      buyerPaymentIdentifier: options.buyerPaymentIdentifier,
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
  now?: Date;
}): Promise<AuthorizationResult> {
  const now = options.now ?? new Date();
  const unlocked = await unlockWallet(
    options.walletsDirectory,
    options.wallet,
    options.passphrase,
  );
  const loaded = await loadRequestEnvelope(options.requestEnvelopePath);
  const accepted = selectRequirement(
    loaded.paymentRequired,
    unlocked.metadata,
    now,
  );
  enforceLocalPolicy(unlocked.metadata, accepted.amount);
  const store = new AttemptStore(options.attemptsDirectory);
  const existing = await store.findByRequestDigest(loaded.requestDigest);
  if (
    existing !== null &&
    !["terminal_failed", "abandoned_local"].includes(existing.state)
  ) {
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
    asset: accepted.asset,
    sponsored: sponsored(accepted),
  });
  const buyerPaymentIdentifier = createBuyerPaymentIdentifier();
  let paymentSignature: string;
  if (unlocked.metadata.network === BASE_MAINNET_NETWORK) {
    if (!options.rpc.base)
      throw new AgentWalletError("rpc_not_configured", "Base RPC is required");
    paymentSignature = await basePayment({
      wallet: unlocked,
      paymentRequired: loaded.paymentRequired,
      accepted,
      challengeDigest: loaded.envelope.challengeDigest,
      buyerPaymentIdentifier,
      rpc: options.rpc.base,
      now,
    });
  } else if (unlocked.metadata.network === SOLANA_MAINNET_NETWORK) {
    if (!options.rpc.solana) {
      throw new AgentWalletError(
        "rpc_not_configured",
        "Solana RPC is required",
      );
    }
    paymentSignature = await solanaPayment({
      wallet: unlocked,
      paymentRequired: loaded.paymentRequired,
      accepted,
      buyerPaymentIdentifier,
      rpc: options.rpc.solana,
    });
  } else {
    throw new AgentWalletError(
      "unsupported_profile",
      "TRON payments are coming soon and are not enabled in the launch payer",
    );
  }
  const selectedRequirementDigest = requirementDigest(accepted);
  const sponsorshipExpiresAt = String(
    loaded.paymentRequired.extensions?.[GAS_SPONSORSHIP_EXTENSION]?.info
      .expiresAt,
  );
  const expiresAt = new Date(
    Math.min(
      now.getTime() + Math.min(accepted.maxTimeoutSeconds, 3600) * 1000,
      Date.parse(sponsorshipExpiresAt),
    ),
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
