import {
  canonicalJson,
  createPaymentPayload,
  type JsonObject,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirement,
} from "./http.js";

import { verifyExternalRecipientDeclaration } from "./external-recipient.js";

export type TronTransactionParts = {
  txID: string;
  raw_data_hex: string;
  signature?: string[];
  walletDocument?: JsonObject;
};

export interface TronTransactionBuilder {
  buildTransfer(args: {
    ownerAddress: string;
    tokenContract: string;
    recipient: string;
    amountAtomic: string;
    challengeCommitment: string;
    maxTimeoutSeconds: number;
  }): Promise<TronTransactionParts>;
}

export interface TronWalletProvider {
  requestAccounts(): Promise<string[]>;
  getNetwork(): Promise<TronWalletNetwork>;
  signTransaction(
    transaction: TronTransactionParts,
  ): Promise<TronTransactionParts>;
  disconnect(): Promise<void>;
}

export type TronWalletNetwork = {
  networkType: "Mainnet" | "Shasta" | "Nile" | "Unknown";
  chainId: string;
};

export const TRON_MAINNET_CHAIN_ID = "0x2b6653dc";
export const TRON_USDT_MAINNET_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t"; // pragma: allowlist secret

export type SelfFundedTronPaymentLabAdmission = {
  kind: "self-funded-tron-payment-lab-v1";
  payer: string;
  recipient: string;
  asset: typeof TRON_USDT_MAINNET_CONTRACT;
  amountAtomic: string;
  resourceUrl: string;
  expiresAt: string;
  maxFeeLimitSun: number;
};

export interface TronWebLike {
  transactionBuilder: {
    triggerSmartContract(
      contractAddress: string,
      functionSelector: string,
      options: {
        feeLimit: number;
        callValue: number;
        txLocal?: boolean;
      },
      parameters: { type: string; value: string }[],
      ownerAddress: string,
    ): Promise<{
      result?: { result?: boolean; message?: string };
      transaction?: JsonObject;
    }>;
    addUpdateData(
      transaction: JsonObject,
      memo: string,
      dataFormat: "hex",
      options?: { txLocal: boolean },
    ): Promise<JsonObject>;
  };
}

export interface TronWalletAdapterLike {
  address: string | null;
  connected?: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  network(): Promise<TronWalletNetwork>;
  signTransaction(transaction: JsonObject): Promise<JsonObject>;
}

export class TronWebTransactionBuilder implements TronTransactionBuilder {
  readonly #tronWeb: TronWebLike;
  readonly #feeLimitSun: number;
  readonly #buildLocally: boolean;

  constructor(options: {
    tronWeb: TronWebLike;
    feeLimitSun: number;
    buildLocally?: boolean;
  }) {
    if (!Number.isSafeInteger(options.feeLimitSun) || options.feeLimitSun < 1) {
      throw new Error("TRON fee limit is invalid");
    }
    this.#tronWeb = options.tronWeb;
    this.#feeLimitSun = options.feeLimitSun;
    this.#buildLocally = options.buildLocally ?? false;
  }

  async buildTransfer(args: {
    ownerAddress: string;
    tokenContract: string;
    recipient: string;
    amountAtomic: string;
    challengeCommitment: string;
    maxTimeoutSeconds: number;
  }): Promise<TronTransactionParts> {
    if (!/^sha256:[0-9a-f]{64}$/.test(args.challengeCommitment)) {
      throw new Error("TRON challenge commitment is invalid");
    }
    const wrapper = await this.#tronWeb.transactionBuilder.triggerSmartContract(
      args.tokenContract,
      "transfer(address,uint256)",
      {
        feeLimit: this.#feeLimitSun,
        callValue: 0,
        txLocal: this.#buildLocally,
      },
      [
        { type: "address", value: args.recipient },
        { type: "uint256", value: args.amountAtomic },
      ],
      args.ownerAddress,
    );
    if (wrapper.result?.result !== true || !wrapper.transaction) {
      throw new Error(
        `TRON transaction builder rejected transfer${wrapper.result?.message ? `: ${wrapper.result.message}` : ""}`,
      );
    }
    const memoHex = `4b31583401${args.challengeCommitment.slice("sha256:".length)}`;
    const updated = await this.#tronWeb.transactionBuilder.addUpdateData(
      wrapper.transaction,
      memoHex,
      "hex",
      { txLocal: this.#buildLocally },
    );
    return transactionParts(updated, false);
  }
}

export class TronWalletAdapterProvider implements TronWalletProvider {
  readonly #adapter: TronWalletAdapterLike;

  constructor(adapter: TronWalletAdapterLike) {
    this.#adapter = adapter;
  }

  async requestAccounts(): Promise<string[]> {
    if (!this.#adapter.connected) await this.#adapter.connect();
    return this.#adapter.address ? [this.#adapter.address] : [];
  }

  async getNetwork(): Promise<TronWalletNetwork> {
    const network = await this.#adapter.network();
    if (
      typeof network !== "object" ||
      network === null ||
      !["Mainnet", "Shasta", "Nile", "Unknown"].includes(network.networkType) ||
      typeof network.chainId !== "string" ||
      network.chainId.length < 1 ||
      network.chainId.length > 128
    ) {
      throw new Error("TRON wallet returned malformed network information");
    }
    return network;
  }

  async signTransaction(
    transaction: TronTransactionParts,
  ): Promise<TronTransactionParts> {
    if (!transaction.walletDocument) {
      throw new Error("TRON wallet document is unavailable");
    }
    const signed = await this.#adapter.signTransaction(
      transaction.walletDocument,
    );
    return transactionParts(signed, true);
  }

  async disconnect(): Promise<void> {
    await this.#adapter.disconnect();
  }
}

export type InspectedTronTransfer = {
  txID: string;
  payerCanonicalHex: string;
  tokenCanonicalHex: string;
  recipientCanonicalHex: string;
  amountAtomic: string;
  timestampMs: number;
  expirationMs: number;
  feeLimitSun: number;
  challengeCommitmentHex: string;
};

type Field = { number: number; wireType: number; value: bigint | Uint8Array };

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const HEX64 = /^[0-9a-f]{64}$/;
const RAW_HEX = /^(?:[0-9a-f]{2})+$/;
const SIGNATURE = /^[0-9a-f]{130}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;

function transactionParts(
  value: JsonObject,
  signatureRequired: boolean,
): TronTransactionParts {
  const txID = value.txID;
  const rawDataHex = value.raw_data_hex;
  const signatures = value.signature;
  if (
    typeof txID !== "string" ||
    typeof rawDataHex !== "string" ||
    (signatures !== undefined &&
      (!Array.isArray(signatures) ||
        signatures.some((entry) => typeof entry !== "string"))) ||
    (signatureRequired && !Array.isArray(signatures))
  ) {
    throw new Error("TronWeb returned a malformed transaction");
  }
  return {
    txID,
    raw_data_hex: rawDataHex,
    ...(Array.isArray(signatures) ? { signature: signatures as string[] } : {}),
    walletDocument: value,
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(value: string, name: string): Uint8Array {
  if (!RAW_HEX.test(value))
    throw new Error(`${name} is not canonical lowercase hex`);
  return Uint8Array.from(
    value.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
  );
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256(value: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", arrayBuffer(value)),
  );
}

function encodeVarint(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("negative protobuf varint");
  const result: number[] = [];
  do {
    let byte = Number(value & 0x7fn);
    value >>= 7n;
    if (value > 0n) byte |= 0x80;
    result.push(byte);
  } while (value > 0n);
  return Uint8Array.from(result);
}

function readVarint(data: Uint8Array, start: number): [bigint, number] {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < data.length && shift <= 63n) {
    const byte = data[offset++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if (byte < 0x80) {
      if (hex(data.slice(start, offset)) !== hex(encodeVarint(value))) {
        throw new Error("protobuf varint is not minimally encoded");
      }
      return [value, offset];
    }
    shift += 7n;
  }
  throw new Error("protobuf varint is truncated or too large");
}

function parseFields(data: Uint8Array): Field[] {
  const fields: Field[] = [];
  let offset = 0;
  let previous = 0;
  while (offset < data.length) {
    let tag: bigint;
    [tag, offset] = readVarint(data, offset);
    const number = Number(tag >> 3n);
    const wireType = Number(tag & 7n);
    if (number < 1 || number < previous)
      throw new Error("protobuf fields are not ordered");
    previous = number;
    if (wireType === 0) {
      let value: bigint;
      [value, offset] = readVarint(data, offset);
      fields.push({ number, wireType, value });
    } else if (wireType === 2) {
      let length: bigint;
      [length, offset] = readVarint(data, offset);
      if (length > BigInt(data.length - offset))
        throw new Error("protobuf field is truncated");
      const end = offset + Number(length);
      fields.push({ number, wireType, value: data.slice(offset, end) });
      offset = end;
    } else {
      throw new Error("unsupported protobuf wire type");
    }
  }
  return fields;
}

function fieldMap(
  fields: Field[],
  allowed: Set<number>,
  repeated = new Set<number>(),
): Map<number, Field[]> {
  const result = new Map<number, Field[]>();
  for (const field of fields) {
    if (!allowed.has(field.number))
      throw new Error(`prohibited protobuf field ${field.number}`);
    const values = result.get(field.number) ?? [];
    values.push(field);
    result.set(field.number, values);
  }
  for (const [number, values] of result) {
    if (values.length !== 1 && !repeated.has(number)) {
      throw new Error("duplicate singular protobuf field");
    }
  }
  return result;
}

function one(
  fields: Map<number, Field[]>,
  number: number,
  wireType: number,
  name: string,
): bigint | Uint8Array {
  const values = fields.get(number);
  if (!values || values.length !== 1 || values[0]!.wireType !== wireType) {
    throw new Error(`missing or malformed ${name}`);
  }
  return values[0]!.value;
}

function bytes(value: bigint | Uint8Array, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new Error(`${name} is not bytes`);
  return value;
}

function safeNumber(value: bigint | Uint8Array, name: string): number {
  if (
    typeof value !== "bigint" ||
    value < 1n ||
    value > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error(`${name} is outside the safe positive integer range`);
  }
  return Number(value);
}

async function decodeBase58Check(value: string): Promise<Uint8Array> {
  if (value.length < 26 || value.length > 36)
    throw new Error("TRON address length is invalid");
  let numeric = 0n;
  for (const character of value) {
    const index = BASE58_ALPHABET.indexOf(character);
    if (index < 0) throw new Error("TRON address is not Base58");
    numeric = numeric * 58n + BigInt(index);
  }
  const decoded: number[] = [];
  while (numeric > 0n) {
    decoded.push(Number(numeric & 0xffn));
    numeric >>= 8n;
  }
  decoded.reverse();
  const leading = value.match(/^1*/)?.[0].length ?? 0;
  const complete = Uint8Array.from([...new Array(leading).fill(0), ...decoded]);
  if (complete.length !== 25)
    throw new Error("TRON address has the wrong byte length");
  const payload = complete.slice(0, 21);
  const checksum = (await sha256(await sha256(payload))).slice(0, 4);
  if (hex(checksum) !== hex(complete.slice(21)) || payload[0] !== 0x41) {
    throw new Error("TRON address checksum or network prefix is invalid");
  }
  return payload;
}

export async function inspectTronTransfer(
  transaction: TronTransactionParts,
): Promise<InspectedTronTransfer> {
  if (
    !HEX64.test(transaction.txID) ||
    !RAW_HEX.test(transaction.raw_data_hex)
  ) {
    throw new Error("TRON transaction identity or bytes are not canonical hex");
  }
  const raw = fromHex(transaction.raw_data_hex, "TRON raw data");
  if (hex(await sha256(raw)) !== transaction.txID) {
    throw new Error("TRON txID is not SHA-256(raw_data)");
  }
  const rawFields = fieldMap(
    parseFields(raw),
    new Set([1, 3, 4, 8, 9, 10, 11, 12, 14, 18]),
    new Set([9, 11]),
  );
  if (rawFields.has(9) || rawFields.has(12))
    throw new Error("TRON auth/scripts are forbidden");
  if ((rawFields.get(11)?.length ?? 0) !== 1)
    throw new Error("TRON transaction needs one contract");
  const refBlockBytes = bytes(
    one(rawFields, 1, 2, "reference-block bytes"),
    "reference-block bytes",
  );
  const refBlockHash = bytes(
    one(rawFields, 4, 2, "reference-block hash"),
    "reference-block hash",
  );
  if (refBlockBytes.length !== 2 || refBlockHash.length !== 8) {
    throw new Error("TRON reference-block identity is malformed");
  }
  if (rawFields.has(3)) {
    safeNumber(
      one(rawFields, 3, 0, "reference-block number"),
      "reference-block number",
    );
  }
  const commitment = bytes(
    one(rawFields, 10, 2, "challenge commitment"),
    "commitment",
  );
  if (
    commitment.length !== 37 ||
    hex(commitment.slice(0, 5)) !== "4b31583401"
  ) {
    throw new Error("TRON challenge commitment is not K1X4 v1");
  }
  const contractFields = fieldMap(
    parseFields(bytes(one(rawFields, 11, 2, "contract"), "contract")),
    new Set([1, 2, 3, 4, 5]),
  );
  if (
    one(contractFields, 1, 0, "contract type") !== 31n ||
    contractFields.has(3) ||
    contractFields.has(4) ||
    contractFields.has(5)
  ) {
    throw new Error(
      "TRON contract is not owner-permission TriggerSmartContract",
    );
  }
  const anyFields = fieldMap(
    parseFields(
      bytes(one(contractFields, 2, 2, "contract parameter"), "parameter"),
    ),
    new Set([1, 2]),
  );
  const typeUrl = new TextDecoder("utf-8", { fatal: true }).decode(
    bytes(one(anyFields, 1, 2, "type URL"), "type URL"),
  );
  if (typeUrl !== "type.googleapis.com/protocol.TriggerSmartContract") {
    throw new Error("TRON Any type is not TriggerSmartContract");
  }
  const trigger = fieldMap(
    parseFields(bytes(one(anyFields, 2, 2, "trigger value"), "trigger")),
    new Set([1, 2, 3, 4, 5, 6]),
  );
  if (trigger.has(3) || trigger.has(5) || trigger.has(6)) {
    throw new Error("TRON trigger value/token fields are forbidden");
  }
  const payer = bytes(one(trigger, 1, 2, "owner"), "owner");
  const token = bytes(one(trigger, 2, 2, "token contract"), "token");
  const callData = bytes(one(trigger, 4, 2, "call data"), "call data");
  if (
    payer.length !== 21 ||
    token.length !== 21 ||
    callData.length !== 68 ||
    hex(callData.slice(0, 4)) !== "a9059cbb" ||
    callData.slice(4, 16).some((value) => value !== 0)
  ) {
    throw new Error(
      "TRON transfer call is not canonical transfer(address,uint256)",
    );
  }
  const amount = BigInt(`0x${hex(callData.slice(36))}`);
  if (amount < 1n) throw new Error("TRON transfer amount is zero");
  return {
    txID: transaction.txID,
    payerCanonicalHex: hex(payer),
    tokenCanonicalHex: hex(token),
    recipientCanonicalHex: `41${hex(callData.slice(16, 36))}`,
    amountAtomic: amount.toString(),
    timestampMs: safeNumber(one(rawFields, 14, 0, "timestamp"), "timestamp"),
    expirationMs: safeNumber(one(rawFields, 8, 0, "expiration"), "expiration"),
    feeLimitSun: safeNumber(one(rawFields, 18, 0, "fee limit"), "fee limit"),
    challengeCommitmentHex: hex(commitment),
  };
}

async function verifyAgainstRequirement(options: {
  transaction: TronTransactionParts;
  accepted: PaymentRequirement;
  payer: string;
  trustedAssetContracts: readonly string[];
  maxFeeLimitSun: number;
  nowMs: number;
}): Promise<InspectedTronTransfer> {
  const {
    transaction,
    accepted,
    payer,
    trustedAssetContracts,
    maxFeeLimitSun,
    nowMs,
  } = options;
  validateRequirement({
    accepted,
    trustedAssetContracts,
    maxFeeLimitSun,
    nowMs,
  });
  const inspected = await inspectTronTransfer(transaction);
  const [payerBytes, tokenBytes, recipientBytes] = await Promise.all([
    decodeBase58Check(payer),
    decodeBase58Check(accepted.asset),
    decodeBase58Check(accepted.payTo),
  ]);
  if (
    inspected.payerCanonicalHex !== hex(payerBytes) ||
    inspected.tokenCanonicalHex !== hex(tokenBytes) ||
    inspected.recipientCanonicalHex !== hex(recipientBytes) ||
    inspected.amountAtomic !== accepted.amount ||
    inspected.challengeCommitmentHex !==
      `4b31583401${String(accepted.extra.challengeCommitment).slice(
        "sha256:".length,
      )}` ||
    inspected.feeLimitSun > maxFeeLimitSun ||
    inspected.timestampMs > nowMs + 10_000 ||
    inspected.timestampMs < nowMs - 60_000 ||
    inspected.expirationMs <= nowMs ||
    inspected.expirationMs - nowMs > accepted.maxTimeoutSeconds * 1_000
  ) {
    throw new Error("signed TRON transaction does not match the exact payment");
  }
  return inspected;
}

function validateRequirement(options: {
  accepted: PaymentRequirement;
  trustedAssetContracts: readonly string[];
  maxFeeLimitSun: number;
  nowMs: number;
}): void {
  const { accepted, trustedAssetContracts, maxFeeLimitSun, nowMs } = options;
  if (
    accepted.scheme !== "exact" ||
    accepted.network !== "tron:mainnet" ||
    accepted.extra.assetTransferMethod !== "signed_trc20_transaction" ||
    accepted.extra.payloadProfile !== "com.k1hub.x402.tron-exact.v1" ||
    accepted.extra.transactionContractType !== "TriggerSmartContract" ||
    accepted.extra.function !== "transfer(address,uint256)" ||
    typeof accepted.extra.challengeCommitment !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(accepted.extra.challengeCommitment) ||
    !DECIMAL.test(accepted.amount) ||
    accepted.amount === "0" ||
    accepted.asset !== TRON_USDT_MAINNET_CONTRACT ||
    !trustedAssetContracts.includes(TRON_USDT_MAINNET_CONTRACT) ||
    !Number.isSafeInteger(maxFeeLimitSun) ||
    maxFeeLimitSun < 1 ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 1
  ) {
    throw new Error("requirement is not an approved TRON exact profile");
  }
}

export async function createTronUsdtPayment(options: {
  builder: TronTransactionBuilder;
  provider: TronWalletProvider;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  buyerPaymentIdentifier: string;
  trustedAssetContracts: readonly string[];
  maxFeeLimitSun: number;
  nowMs?: number;
}): Promise<PaymentPayload> {
  const {
    builder,
    provider,
    paymentRequired,
    accepted,
    buyerPaymentIdentifier,
    trustedAssetContracts,
    maxFeeLimitSun,
  } = options;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
    throw new Error("current time is invalid");
  }
  await verifyExternalRecipientDeclaration({
    paymentRequired,
    accepted,
  });
  validateRequirement({
    accepted,
    trustedAssetContracts,
    maxFeeLimitSun,
    nowMs,
  });
  await Promise.all([
    decodeBase58Check(accepted.asset),
    decodeBase58Check(accepted.payTo),
  ]);
  const accounts = await provider.requestAccounts();
  if (accounts.length < 1 || typeof accounts[0] !== "string") {
    throw new Error("TRON wallet returned no account");
  }
  const payer = accounts[0];
  const network = await provider.getNetwork();
  if (
    network.networkType !== "Mainnet" ||
    network.chainId.toLowerCase() !== TRON_MAINNET_CHAIN_ID
  ) {
    throw new Error("TRON wallet is not connected to Mainnet");
  }
  await decodeBase58Check(payer);
  const transaction = await builder.buildTransfer({
    ownerAddress: payer,
    tokenContract: accepted.asset,
    recipient: accepted.payTo,
    amountAtomic: accepted.amount,
    challengeCommitment: String(accepted.extra.challengeCommitment),
    maxTimeoutSeconds: accepted.maxTimeoutSeconds,
  });
  await verifyAgainstRequirement({
    transaction,
    accepted,
    payer,
    trustedAssetContracts,
    maxFeeLimitSun,
    nowMs,
  });
  const signed = await provider.signTransaction(transaction);
  if (
    signed.txID !== transaction.txID ||
    signed.raw_data_hex !== transaction.raw_data_hex ||
    !Array.isArray(signed.signature) ||
    signed.signature.length !== 1 ||
    !SIGNATURE.test(signed.signature[0]!)
  ) {
    throw new Error(
      "TRON wallet changed transaction bytes or returned an invalid signature",
    );
  }
  await verifyAgainstRequirement({
    transaction: signed,
    accepted,
    payer,
    trustedAssetContracts,
    maxFeeLimitSun,
    nowMs,
  });
  return createPaymentPayload({
    paymentRequired,
    accepted,
    paymentIdentifier: buyerPaymentIdentifier,
    schemePayload: {
      transaction: {
        txID: signed.txID,
        raw_data_hex: signed.raw_data_hex,
        signature: signed.signature,
      },
    },
  });
}

async function validateSelfFundedLabAdmission(options: {
  admission: SelfFundedTronPaymentLabAdmission;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  nowMs: number;
}): Promise<void> {
  const { admission, paymentRequired, accepted, nowMs } = options;
  const expiresAtMs = Date.parse(admission.expiresAt);
  if (
    admission.kind !== "self-funded-tron-payment-lab-v1" ||
    admission.asset !== TRON_USDT_MAINNET_CONTRACT ||
    admission.recipient !== accepted.payTo ||
    admission.amountAtomic !== accepted.amount ||
    admission.resourceUrl !== paymentRequired.resource.url ||
    accepted.asset !== admission.asset ||
    !DECIMAL.test(admission.amountAtomic) ||
    admission.amountAtomic === "0" ||
    !Number.isSafeInteger(admission.maxFeeLimitSun) ||
    admission.maxFeeLimitSun < 1_000_000 ||
    admission.maxFeeLimitSun > 15_000_000_000 ||
    !Number.isFinite(expiresAtMs) ||
    !admission.expiresAt.endsWith("Z") ||
    expiresAtMs <= nowMs ||
    expiresAtMs - nowMs > 86_400_000 ||
    !paymentRequired.accepts.some(
      (candidate) => canonicalJson(candidate) === canonicalJson(accepted),
    )
  ) {
    throw new Error(
      "payment is outside the exact self-funded TRON lab admission",
    );
  }
  await Promise.all([
    decodeBase58Check(admission.payer),
    decodeBase58Check(admission.recipient),
    decodeBase58Check(admission.asset),
  ]);
}

/**
 * Construct one bounded, self-funded TRON Mainnet payment without relying on
 * a separately distributed recipient checkpoint. This entry point is for the
 * private payment lab only: the caller must pin every economically relevant
 * value from the operator's signed same-day canary admission.
 */
export async function createTronUsdtLabPayment(options: {
  builder: TronTransactionBuilder;
  provider: TronWalletProvider;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  buyerPaymentIdentifier: string;
  admission: SelfFundedTronPaymentLabAdmission;
  nowMs?: number;
}): Promise<PaymentPayload> {
  const {
    builder,
    provider,
    paymentRequired,
    accepted,
    buyerPaymentIdentifier,
    admission,
  } = options;
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 1) {
    throw new Error("current time is invalid");
  }
  await validateSelfFundedLabAdmission({
    admission,
    paymentRequired,
    accepted,
    nowMs,
  });
  validateRequirement({
    accepted,
    trustedAssetContracts: [TRON_USDT_MAINNET_CONTRACT],
    maxFeeLimitSun: admission.maxFeeLimitSun,
    nowMs,
  });

  const accounts = await provider.requestAccounts();
  if (
    accounts.length < 1 ||
    typeof accounts[0] !== "string" ||
    accounts[0] !== admission.payer
  ) {
    throw new Error("TRON wallet account is outside the exact lab admission");
  }
  const payer = accounts[0];
  const network = await provider.getNetwork();
  if (
    network.networkType !== "Mainnet" ||
    network.chainId.toLowerCase() !== TRON_MAINNET_CHAIN_ID
  ) {
    throw new Error("TRON wallet is not connected to Mainnet");
  }

  const transaction = await builder.buildTransfer({
    ownerAddress: payer,
    tokenContract: accepted.asset,
    recipient: accepted.payTo,
    amountAtomic: accepted.amount,
    challengeCommitment: String(accepted.extra.challengeCommitment),
    maxTimeoutSeconds: accepted.maxTimeoutSeconds,
  });
  await verifyAgainstRequirement({
    transaction,
    accepted,
    payer,
    trustedAssetContracts: [TRON_USDT_MAINNET_CONTRACT],
    maxFeeLimitSun: admission.maxFeeLimitSun,
    nowMs,
  });
  const signed = await provider.signTransaction(transaction);
  if (
    signed.txID !== transaction.txID ||
    signed.raw_data_hex !== transaction.raw_data_hex ||
    !Array.isArray(signed.signature) ||
    signed.signature.length !== 1 ||
    !SIGNATURE.test(signed.signature[0]!)
  ) {
    throw new Error(
      "TRON wallet changed transaction bytes or returned an invalid signature",
    );
  }
  await verifyAgainstRequirement({
    transaction: signed,
    accepted,
    payer,
    trustedAssetContracts: [TRON_USDT_MAINNET_CONTRACT],
    maxFeeLimitSun: admission.maxFeeLimitSun,
    nowMs,
  });
  return createPaymentPayload({
    paymentRequired,
    accepted,
    paymentIdentifier: buyerPaymentIdentifier,
    schemePayload: {
      transaction: {
        txID: signed.txID,
        raw_data_hex: signed.raw_data_hex,
        signature: signed.signature,
      },
    },
  });
}
