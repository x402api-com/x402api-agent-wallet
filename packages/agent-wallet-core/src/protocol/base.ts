import {
  createPaymentPayload,
  type JsonObject,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirement,
} from "./http.js";

import { verifyExternalRecipientDeclaration } from "./external-recipient.js";

export interface Eip1193Provider {
  request(args: {
    method: string;
    params?: readonly unknown[] | Record<string, unknown>;
  }): Promise<unknown>;
}

export type Eip3009Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

export const BASE_MAINNET_NETWORK = "eip155:8453";
export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_USDC_MAINNET_CONTRACT =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_USDC_BUYER_FUNDED_PROFILE =
  "com.k1hub.x402.base-usdc-eip3009-buyer-funded.v1";
export const BASE_USDC_SPONSORED_PROFILE =
  "com.x402api.x402.base-usdc-eip3009-sponsored.v1";

const BASE_CHAIN_ID_HEX = "0x2105";
const BASE_MAX_AUTHORIZATION_SECONDS = 300;
const BASE_MAX_GAS_LIMIT = 200_000n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
const SIGNED_TYPE_2_TRANSACTION = /^0x02[0-9a-f]+$/;
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;
const UINT256_MAX = (1n << 256n) - 1n;
const TRANSFER_WITH_AUTHORIZATION_SELECTOR = "e3ee160e";

export type BaseEip1559TransactionPolicy = {
  nonce: bigint;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export type BaseTransactionTransport = "eip1193_broadcast" | "signed_raw";

export type BaseUsdcAuthorizationMaterial = {
  authorization: Eip3009Authorization;
  typedData: JsonObject;
};

type RlpValue = Uint8Array | RlpValue[];

function validateBaseRequirement(accepted: PaymentRequirement): void {
  const extra = accepted.extra;
  if (
    accepted.scheme !== "exact" ||
    accepted.network !== BASE_MAINNET_NETWORK ||
    accepted.asset.toLowerCase() !== BASE_USDC_MAINNET_CONTRACT.toLowerCase() ||
    !ADDRESS.test(accepted.asset) ||
    !ADDRESS.test(accepted.payTo) ||
    !DECIMAL.test(accepted.amount) ||
    accepted.amount === "0" ||
    !Number.isSafeInteger(accepted.maxTimeoutSeconds) ||
    accepted.maxTimeoutSeconds < 1 ||
    typeof extra !== "object" ||
    extra === null ||
    Object.keys(extra).sort().join(",") !==
      "assetTransferMethod,name,payloadProfile,version" ||
    extra.assetTransferMethod !== "eip3009" ||
    extra.name !== "USD Coin" ||
    extra.version !== "2" ||
    ![BASE_USDC_BUYER_FUNDED_PROFILE, BASE_USDC_SPONSORED_PROFILE].includes(
      String(extra.payloadProfile),
    )
  ) {
    throw new Error(
      "requirement is not buyer-funded issuer-native Base USDC EIP-3009",
    );
  }
}

function decimalUint256(value: string, field: string): bigint {
  if (!DECIMAL.test(value))
    throw new Error(`${field} is not canonical decimal`);
  const result = BigInt(value);
  if (result > UINT256_MAX) throw new Error(`${field} exceeds uint256`);
  return result;
}

function boundedUint256(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n || value > UINT256_MAX) {
    throw new Error(`${field} is outside uint256`);
  }
  return value;
}

function hexQuantity(value: bigint): string {
  return `0x${value.toString(16)}`;
}

function word(value: bigint): string {
  return boundedUint256(value, "ABI integer").toString(16).padStart(64, "0");
}

function addressWord(value: string): string {
  if (!ADDRESS.test(value)) throw new Error("ABI address is malformed");
  return value.slice(2).toLowerCase().padStart(64, "0");
}

function signatureParts(signature: string): {
  recoveryId: number;
  r: bigint;
  s: bigint;
  rHex: string;
  sHex: string;
} {
  if (!SIGNATURE.test(signature)) {
    throw new Error("wallet returned an invalid EIP-3009 signature");
  }
  const rHex = signature.slice(2, 66).toLowerCase();
  const sHex = signature.slice(66, 130).toLowerCase();
  const rawRecoveryId = Number.parseInt(signature.slice(130, 132), 16);
  const recoveryId =
    rawRecoveryId === 0 || rawRecoveryId === 1
      ? rawRecoveryId + 27
      : rawRecoveryId;
  const r = BigInt(`0x${rHex}`);
  const s = BigInt(`0x${sHex}`);
  if (
    ![27, 28].includes(recoveryId) ||
    r < 1n ||
    r >= SECP256K1_ORDER ||
    s < 1n ||
    s > SECP256K1_HALF_ORDER
  ) {
    throw new Error("EIP-3009 signature is not canonical low-s secp256k1");
  }
  return { recoveryId, r, s, rHex, sHex };
}

export function buildBaseUsdcAuthorization(options: {
  accepted: PaymentRequirement;
  payer: string;
  nowSeconds: number;
  challengeDigest: string;
}): BaseUsdcAuthorizationMaterial {
  validateBaseRequirement(options.accepted);
  if (
    !ADDRESS.test(options.payer) ||
    !Number.isSafeInteger(options.nowSeconds) ||
    options.nowSeconds < 1
  ) {
    throw new Error("payer or current time is invalid");
  }
  const digest = DIGEST.exec(options.challengeDigest);
  if (digest === null) throw new Error("payment challenge digest is invalid");
  const validFor = Math.min(
    options.accepted.maxTimeoutSeconds,
    BASE_MAX_AUTHORIZATION_SECONDS,
  );
  const authorization: Eip3009Authorization = {
    from: options.payer,
    to: options.accepted.payTo,
    value: options.accepted.amount,
    validAfter: String(options.nowSeconds - 1),
    validBefore: String(options.nowSeconds + validFor),
    nonce: `0x${digest[1]}`,
  };
  decimalUint256(authorization.value, "authorization value");
  const typedData: JsonObject = {
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    domain: {
      name: "USD Coin",
      version: "2",
      chainId: BASE_MAINNET_CHAIN_ID,
      verifyingContract: options.accepted.asset,
    },
    message: authorization,
  };
  return { authorization, typedData };
}

export function encodeBaseUsdcTransferWithAuthorization(options: {
  authorization: Eip3009Authorization;
  signature: string;
}): string {
  const { authorization } = options;
  if (
    !ADDRESS.test(authorization.from) ||
    !ADDRESS.test(authorization.to) ||
    !/^0x[0-9a-f]{64}$/.test(authorization.nonce)
  ) {
    throw new Error("EIP-3009 authorization is malformed");
  }
  const value = decimalUint256(authorization.value, "authorization value");
  const validAfter = decimalUint256(
    authorization.validAfter,
    "authorization validAfter",
  );
  const validBefore = decimalUint256(
    authorization.validBefore,
    "authorization validBefore",
  );
  if (validAfter >= validBefore) {
    throw new Error("EIP-3009 authorization validity window is empty");
  }
  const { recoveryId, rHex, sHex } = signatureParts(options.signature);
  return (
    `0x${TRANSFER_WITH_AUTHORIZATION_SELECTOR}` +
    addressWord(authorization.from) +
    addressWord(authorization.to) +
    word(value) +
    word(validAfter) +
    word(validBefore) +
    authorization.nonce.slice(2) +
    word(BigInt(recoveryId)) +
    rHex.padStart(64, "0") +
    sHex.padStart(64, "0")
  );
}

export function buildBaseUsdcEip1559TransactionRequest(options: {
  accepted: PaymentRequirement;
  payer: string;
  data: string;
  policy: BaseEip1559TransactionPolicy;
}): JsonObject {
  validateBaseRequirement(options.accepted);
  if (!ADDRESS.test(options.payer)) throw new Error("payer is malformed");
  if (!/^0xe3ee160e[0-9a-f]{576}$/.test(options.data)) {
    throw new Error("Base USDC transfer calldata is not canonical");
  }
  const { policy } = options;
  const nonce = boundedUint256(policy.nonce, "transaction nonce");
  const gasLimit = boundedUint256(policy.gasLimit, "transaction gas limit");
  const maxFeePerGas = boundedUint256(
    policy.maxFeePerGas,
    "transaction max fee",
  );
  const maxPriorityFeePerGas = boundedUint256(
    policy.maxPriorityFeePerGas,
    "transaction priority fee",
  );
  if (
    gasLimit < 21_000n ||
    gasLimit > BASE_MAX_GAS_LIMIT ||
    maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw new Error("Base EIP-1559 fee policy is outside the client ceiling");
  }
  return {
    type: "0x2",
    chainId: BASE_CHAIN_ID_HEX,
    from: options.payer,
    to: options.accepted.asset,
    value: "0x0",
    data: options.data,
    nonce: hexQuantity(nonce),
    gas: hexQuantity(gasLimit),
    maxFeePerGas: hexQuantity(maxFeePerGas),
    maxPriorityFeePerGas: hexQuantity(maxPriorityFeePerGas),
    accessList: [],
  };
}

function readBigEndian(value: Uint8Array): number {
  if (value.length > 4) throw new Error("RLP length exceeds client bound");
  let result = 0;
  for (const byte of value) result = result * 256 + byte;
  return result;
}

function parseRlp(
  input: Uint8Array,
  offset: number,
  depth = 0,
): { value: RlpValue; next: number } {
  if (depth > 3 || offset >= input.length) {
    throw new Error("signed EIP-1559 transaction RLP is malformed");
  }
  const prefix = input[offset]!;
  if (prefix <= 0x7f) {
    return { value: input.slice(offset, offset + 1), next: offset + 1 };
  }
  let payloadStart: number;
  let payloadLength: number;
  let list = false;
  if (prefix <= 0xb7) {
    payloadLength = prefix - 0x80;
    payloadStart = offset + 1;
    if (payloadLength === 1 && input[payloadStart]! <= 0x7f) {
      throw new Error("signed EIP-1559 transaction RLP is noncanonical");
    }
  } else if (prefix <= 0xbf) {
    const lengthLength = prefix - 0xb7;
    const lengthBytes = input.slice(offset + 1, offset + 1 + lengthLength);
    if (lengthBytes[0] === 0) {
      throw new Error("signed EIP-1559 transaction RLP is noncanonical");
    }
    payloadLength = readBigEndian(lengthBytes);
    if (payloadLength < 56) {
      throw new Error("signed EIP-1559 transaction RLP is noncanonical");
    }
    payloadStart = offset + 1 + lengthLength;
  } else if (prefix <= 0xf7) {
    list = true;
    payloadLength = prefix - 0xc0;
    payloadStart = offset + 1;
  } else {
    list = true;
    const lengthLength = prefix - 0xf7;
    const lengthBytes = input.slice(offset + 1, offset + 1 + lengthLength);
    if (lengthBytes[0] === 0) {
      throw new Error("signed EIP-1559 transaction RLP is noncanonical");
    }
    payloadLength = readBigEndian(lengthBytes);
    if (payloadLength < 56) {
      throw new Error("signed EIP-1559 transaction RLP is noncanonical");
    }
    payloadStart = offset + 1 + lengthLength;
  }
  const payloadEnd = payloadStart + payloadLength;
  if (payloadStart > input.length || payloadEnd > input.length) {
    throw new Error("signed EIP-1559 transaction RLP is truncated");
  }
  if (!list) {
    return { value: input.slice(payloadStart, payloadEnd), next: payloadEnd };
  }
  const values: RlpValue[] = [];
  let cursor = payloadStart;
  while (cursor < payloadEnd) {
    const parsed = parseRlp(input, cursor, depth + 1);
    if (parsed.next > payloadEnd) {
      throw new Error("signed EIP-1559 transaction RLP list is malformed");
    }
    values.push(parsed.value);
    cursor = parsed.next;
  }
  if (cursor !== payloadEnd) {
    throw new Error("signed EIP-1559 transaction RLP list is malformed");
  }
  return { value: values, next: payloadEnd };
}

function rlpBytes(value: RlpValue, field: string): Uint8Array {
  if (Array.isArray(value)) throw new Error(`${field} is not an RLP string`);
  return value;
}

function rlpInteger(value: RlpValue, field: string): bigint {
  const bytes = rlpBytes(value, field);
  if (bytes.length > 32 || (bytes.length > 0 && bytes[0] === 0)) {
    throw new Error(`${field} is not a canonical uint256`);
  }
  let result = 0n;
  for (const byte of bytes) result = (result << 8n) | BigInt(byte);
  return result;
}

function hexBytes(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function policyFromRequest(request: JsonObject): BaseEip1559TransactionPolicy {
  const quantity = (field: string): bigint => {
    const value = request[field];
    if (
      typeof value !== "string" ||
      !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)
    ) {
      throw new Error(`${field} is not a canonical JSON-RPC quantity`);
    }
    return BigInt(value);
  };
  return {
    nonce: quantity("nonce"),
    gasLimit: quantity("gas"),
    maxFeePerGas: quantity("maxFeePerGas"),
    maxPriorityFeePerGas: quantity("maxPriorityFeePerGas"),
  };
}

/**
 * Decode and compare every frozen EIP-1559 field returned by the wallet.
 *
 * Sender recovery and EIP-3009 signature recovery are repeated by K1Hub's
 * backend before reservation. This browser-side check prevents a wallet from
 * silently changing chain, nonce, fees, destination, value, calldata, or
 * access list.
 */
export function verifyBuyerSignedBaseUsdcTransaction(options: {
  signedTransaction: string;
  request: JsonObject;
}): void {
  const { signedTransaction, request } = options;
  if (
    typeof signedTransaction !== "string" ||
    signedTransaction.length > 32_770 ||
    signedTransaction.length % 2 !== 0 ||
    !SIGNED_TYPE_2_TRANSACTION.test(signedTransaction)
  ) {
    throw new Error("wallet returned no canonical signed EIP-1559 transaction");
  }
  const raw = Uint8Array.from(
    signedTransaction.slice(2).match(/../g) ?? [],
    (pair) => Number.parseInt(pair, 16),
  );
  if (raw[0] !== 2)
    throw new Error("wallet returned the wrong transaction type");
  const parsed = parseRlp(raw, 1);
  if (parsed.next !== raw.length || !Array.isArray(parsed.value)) {
    throw new Error("signed EIP-1559 transaction has trailing data");
  }
  const fields = parsed.value;
  if (fields.length !== 12) {
    throw new Error("signed EIP-1559 transaction has the wrong field count");
  }
  const [
    chainId,
    nonce,
    priorityFee,
    maxFee,
    gas,
    to,
    value,
    data,
    accessList,
    parity,
    signatureR,
    signatureS,
  ] = fields;
  const expected = policyFromRequest(request);
  const expectedTo = request.to;
  const expectedData = request.data;
  const transactionR = rlpInteger(signatureR!, "transaction signature r");
  const transactionS = rlpInteger(signatureS!, "transaction signature s");
  if (
    rlpInteger(chainId!, "transaction chainId") !==
      BigInt(BASE_MAINNET_CHAIN_ID) ||
    rlpInteger(nonce!, "transaction nonce") !== expected.nonce ||
    rlpInteger(priorityFee!, "transaction priority fee") !==
      expected.maxPriorityFeePerGas ||
    rlpInteger(maxFee!, "transaction max fee") !== expected.maxFeePerGas ||
    rlpInteger(gas!, "transaction gas") !== expected.gasLimit ||
    typeof expectedTo !== "string" ||
    `0x${hexBytes(rlpBytes(to!, "transaction to"))}`.toLowerCase() !==
      expectedTo.toLowerCase() ||
    rlpInteger(value!, "transaction value") !== 0n ||
    typeof expectedData !== "string" ||
    `0x${hexBytes(rlpBytes(data!, "transaction data"))}` !== expectedData ||
    !Array.isArray(accessList) ||
    accessList.length !== 0 ||
    ![0n, 1n].includes(rlpInteger(parity!, "transaction y parity")) ||
    transactionR < 1n ||
    transactionR >= SECP256K1_ORDER ||
    transactionS < 1n ||
    transactionS > SECP256K1_HALF_ORDER
  ) {
    throw new Error("wallet changed the frozen buyer-funded Base transaction");
  }
}

function signedTransactionResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "raw" in value &&
    typeof value.raw === "string"
  ) {
    return value.raw;
  }
  throw new Error("wallet returned no signed EIP-1559 transaction");
}

/**
 * Construct the exact external-wallet V1 Base USDC x402 payload.
 *
 * The default path asks the buyer's ordinary EIP-1193 wallet to broadcast the
 * exact EIP-1559 request. K1Hub receives only its hash plus the frozen
 * authorization/request and independently verifies the transaction through
 * its RPC quorum. Wallets that support `eth_signTransaction` may opt into raw
 * transport; K1Hub relays those already-signed bytes without signing or gas.
 */
export async function createBaseUsdcPayment(options: {
  provider: Eip1193Provider;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  buyerPaymentIdentifier: string;
  challengeDigest: string;
  transactionPolicy: BaseEip1559TransactionPolicy;
  transactionTransport?: BaseTransactionTransport;
  nowSeconds?: number;
}): Promise<PaymentPayload> {
  const { provider, accepted, paymentRequired } = options;
  validateBaseRequirement(accepted);
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) {
    throw new Error("current time is invalid");
  }
  await verifyExternalRecipientDeclaration({
    paymentRequired,
    accepted,
  });
  if (
    (await provider.request({ method: "eth_chainId" })) !== BASE_CHAIN_ID_HEX
  ) {
    throw new Error("wallet is not connected to Base Mainnet");
  }
  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    !ADDRESS.test(accounts[0])
  ) {
    throw new Error("wallet returned no valid Base account");
  }
  const payer = accounts[0];
  if (payer.toLowerCase() === accepted.payTo.toLowerCase()) {
    throw new Error("payer and recipient must be distinct");
  }
  const { authorization, typedData } = buildBaseUsdcAuthorization({
    accepted,
    payer,
    nowSeconds,
    challengeDigest: options.challengeDigest,
  });
  const authorizationSignature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [payer, JSON.stringify(typedData)],
  });
  if (typeof authorizationSignature !== "string") {
    throw new Error("wallet returned no EIP-3009 signature");
  }
  const data = encodeBaseUsdcTransferWithAuthorization({
    authorization,
    signature: authorizationSignature,
  });
  const request = buildBaseUsdcEip1559TransactionRequest({
    accepted,
    payer,
    data,
    policy: options.transactionPolicy,
  });
  if ((options.transactionTransport ?? "eip1193_broadcast") === "signed_raw") {
    const signedTransaction = signedTransactionResult(
      await provider.request({
        method: "eth_signTransaction",
        params: [request],
      }),
    );
    verifyBuyerSignedBaseUsdcTransaction({ signedTransaction, request });
    return createPaymentPayload({
      paymentRequired,
      accepted,
      paymentIdentifier: options.buyerPaymentIdentifier,
      schemePayload: { transaction: signedTransaction },
    });
  }
  const transactionHash = await provider.request({
    method: "eth_sendTransaction",
    params: [request],
  });
  if (
    typeof transactionHash !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(transactionHash)
  ) {
    throw new Error(
      "wallet returned no canonical buyer-broadcast Base transaction hash",
    );
  }
  return createPaymentPayload({
    paymentRequired,
    accepted,
    paymentIdentifier: options.buyerPaymentIdentifier,
    schemePayload: {
      transactionHash,
      transactionRequest: request,
      authorization,
      signature: authorizationSignature,
    },
  });
}
