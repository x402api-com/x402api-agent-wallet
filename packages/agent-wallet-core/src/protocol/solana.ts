import {
  createPaymentPayload,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirement,
} from "./http.js";

import { verifyExternalRecipientDeclaration } from "./external-recipient.js";

export const SOLANA_MAINNET_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_USDC_MAINNET_MINT =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOLANA_USDT_MAINNET_MINT =
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const SOLANA_TOKEN_PROGRAM =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SOLANA_ASSOCIATED_TOKEN_PROGRAM =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const SOLANA_COMPUTE_BUDGET_PROGRAM =
  "ComputeBudget111111111111111111111111111111";
export const SOLANA_MEMO_PROGRAM =
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
export const SOLANA_USDT_BUYER_FUNDED_PROFILE =
  "com.k1hub.x402.solana-buyer-funded.v1";
export const SOLANA_SPONSORED_PROFILE =
  "com.x402api.x402.solana-sponsored.v1";

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
  [...BASE58].map((character, index) => [character, index]),
);
const FIELD = (1n << 255n) - 19n;
const D = mod(-121665n * modPow(121666n, FIELD - 2n, FIELD), FIELD);
const MEMO =
  /^k1h:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const SOLANA_ISSUER_NATIVE_STABLECOIN_MINTS = new Set([
  SOLANA_USDC_MAINNET_MINT,
  SOLANA_USDT_MAINNET_MINT,
]);

export interface SolanaRpc {
  latestBlockhash(): Promise<string>;
}

export interface SolanaWalletTransport {
  connect(network: typeof SOLANA_MAINNET_NETWORK): Promise<string>;
  signTransaction(options: {
    network: typeof SOLANA_MAINNET_NETWORK;
    transactionBase64: string;
  }): Promise<string>;
}

export interface SolanaWalletRpcProvider {
  request(
    args: { method: string; params?: Record<string, unknown> },
    chain?: string,
  ): Promise<unknown>;
}

export interface InjectedSolanaProvider {
  connect(): Promise<{ publicKey: { toString(): string } }>;
  signTransaction(
    transaction: RawSolanaVersionedTransaction,
  ): Promise<{ serialize(): Uint8Array }>;
}

function mod(value: bigint, modulus: bigint): bigint {
  const result = value % modulus;
  return result < 0n ? result + modulus : result;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let current = mod(base, modulus);
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = (result * current) % modulus;
    current = (current * current) % modulus;
    remaining >>= 1n;
  }
  return result;
}

function isCurvePoint(value: Uint8Array): boolean {
  if (value.length !== 32) return false;
  let encodedY = 0n;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    encodedY = (encodedY << 8n) | BigInt(value[index]!);
  }
  const y = encodedY & ((1n << 255n) - 1n);
  const sign = encodedY >> 255n;
  if (y >= FIELD) return false;
  const ySquared = mod(y * y, FIELD);
  const numerator = mod(ySquared - 1n, FIELD);
  const denominator = mod(D * ySquared + 1n, FIELD);
  const xSquared = mod(
    numerator * modPow(denominator, FIELD - 2n, FIELD),
    FIELD,
  );
  let x = modPow(xSquared, (FIELD + 3n) / 8n, FIELD);
  if (mod(x * x - xSquared, FIELD) !== 0n) {
    x = mod(x * modPow(2n, (FIELD - 1n) / 4n, FIELD), FIELD);
  }
  return mod(x * x - xSquared, FIELD) === 0n && !(x === 0n && sign === 1n);
}

export function decodeSolanaBase58(value: string): Uint8Array {
  if (typeof value !== "string" || value.length < 32 || value.length > 44) {
    throw new Error("Solana address is not bounded base58");
  }
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) throw new Error("Solana address is not base58");
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.push(Number(number & 255n));
    number >>= 8n;
  }
  bytes.reverse();
  const zeros = value.length - value.replace(/^1+/, "").length;
  const result = new Uint8Array(zeros + bytes.length);
  result.set(bytes, zeros);
  if (result.length !== 32 || encodeSolanaBase58(result) !== value) {
    throw new Error("Solana address is not canonical 32-byte base58");
  }
  return result;
}

export function encodeSolanaBase58(value: Uint8Array): string {
  let number = 0n;
  for (const byte of value) number = (number << 8n) | BigInt(byte);
  let encoded = "";
  while (number > 0n) {
    const digit = Number(number % 58n);
    encoded = BASE58[digit]! + encoded;
    number /= 58n;
  }
  let zeros = 0;
  while (zeros < value.length && value[zeros] === 0) zeros += 1;
  return "1".repeat(zeros) + encoded;
}

function concatenate(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    values.reduce((length, value) => length + value.length, 0),
  );
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}

function shortvec(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff) {
    throw new Error("short-vector value is invalid");
  }
  const result = [];
  let remaining = value;
  do {
    let element = remaining & 0x7f;
    remaining >>= 7;
    if (remaining > 0) element |= 0x80;
    result.push(element);
  } while (remaining > 0);
  return Uint8Array.from(result);
}

function littleEndian(value: bigint, length: number): Uint8Array {
  const result = new Uint8Array(length);
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    result[index] = Number(remaining & 255n);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new Error("integer exceeds binary field");
  return result;
}

async function programAddress(
  seeds: Uint8Array[],
  program: Uint8Array,
): Promise<Uint8Array> {
  const marker = new TextEncoder().encode("ProgramDerivedAddress");
  for (let bump = 255; bump >= 0; bump -= 1) {
    const input = concatenate(...seeds, Uint8Array.of(bump), program, marker);
    const digest = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        input.slice().buffer as ArrayBuffer,
      ),
    );
    if (!isCurvePoint(digest)) return digest;
  }
  throw new Error("unable to derive Solana program address");
}

export async function solanaAssociatedTokenAddress(options: {
  owner: string;
  mint: string;
}): Promise<string> {
  const tokenProgram = decodeSolanaBase58(SOLANA_TOKEN_PROGRAM);
  const address = await programAddress(
    [
      decodeSolanaBase58(options.owner),
      tokenProgram,
      decodeSolanaBase58(options.mint),
    ],
    decodeSolanaBase58(SOLANA_ASSOCIATED_TOKEN_PROGRAM),
  );
  return encodeSolanaBase58(address);
}

function instruction(
  programIndex: number,
  accountIndices: number[],
  data: Uint8Array,
): Uint8Array {
  return concatenate(
    Uint8Array.of(programIndex),
    shortvec(accountIndices.length),
    Uint8Array.from(accountIndices),
    shortvec(data.length),
    data,
  );
}

function toBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_000 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("wallet returned noncanonical base64");
  }
  const binary = atob(value);
  if (btoa(binary) !== value) throw new Error("wallet returned invalid base64");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class RawSolanaVersionedTransaction {
  readonly version = 0;
  readonly message: { version: 0; serialize(): Uint8Array };
  signatures: Uint8Array[];

  constructor(
    private readonly messageBytes: Uint8Array,
    signatures?: Uint8Array[],
  ) {
    this.signatures = signatures?.map((signature) => signature.slice()) ?? [
      new Uint8Array(64),
    ];
    this.message = {
      version: 0,
      serialize: () => this.messageBytes.slice(),
    };
  }

  serialize(): Uint8Array {
    if (
      ![1, 2].includes(this.signatures.length) ||
      this.signatures.some((signature) => signature.length !== 64)
    ) {
      throw new Error("Solana transaction signature vector is invalid");
    }
    return concatenate(
      shortvec(this.signatures.length),
      ...this.signatures,
      this.messageBytes,
    );
  }
}

export class InjectedSolanaWalletTransport implements SolanaWalletTransport {
  private payer: string | null = null;

  constructor(private readonly provider: InjectedSolanaProvider) {}

  async connect(network: typeof SOLANA_MAINNET_NETWORK): Promise<string> {
    if (network !== SOLANA_MAINNET_NETWORK)
      throw new Error("network is invalid");
    const connected = await this.provider.connect();
    const payer = connected.publicKey.toString();
    decodeSolanaBase58(payer);
    this.payer = payer;
    return payer;
  }

  async signTransaction(options: {
    network: typeof SOLANA_MAINNET_NETWORK;
    transactionBase64: string;
  }): Promise<string> {
    if (this.payer === null) throw new Error("Solana wallet is not connected");
    const raw = fromBase64(options.transactionBase64);
    const signatureCount = raw[0];
    if (
      signatureCount === undefined ||
      ![1, 2].includes(signatureCount) ||
      raw.length < 1 + signatureCount * 64 + 1
    ) {
      throw new Error("Solana transaction signature vector is invalid");
    }
    const messageOffset = 1 + signatureCount * 64;
    const signatures = Array.from({ length: signatureCount }, (_, index) =>
      raw.slice(1 + index * 64, 1 + (index + 1) * 64),
    );
    const transaction = new RawSolanaVersionedTransaction(
      raw.slice(messageOffset),
      signatures,
    );
    const signed = await this.provider.signTransaction(transaction);
    return toBase64(signed.serialize());
  }
}

function validateSponsoredRequirement(accepted: PaymentRequirement): void {
  if (
    accepted.scheme !== "exact" ||
    accepted.network !== SOLANA_MAINNET_NETWORK ||
    !SOLANA_ISSUER_NATIVE_STABLECOIN_MINTS.has(accepted.asset) ||
    !DECIMAL.test(accepted.amount) ||
    accepted.amount === "0" ||
    typeof accepted.extra.feePayer !== "string" ||
    accepted.extra.payloadProfile !== SOLANA_SPONSORED_PROFILE ||
    typeof accepted.extra.memo !== "string" ||
    !MEMO.test(accepted.extra.memo)
  ) {
    throw new Error("requirement is not sponsored native Solana USDC or USDT exact");
  }
  decodeSolanaBase58(accepted.asset);
  decodeSolanaBase58(accepted.payTo);
  decodeSolanaBase58(accepted.extra.feePayer);
}

/**
 * Build the dormant tenant-sponsored Solana transaction profile.
 *
 * @deprecated V1 uses `buildBuyerFundedSolanaUsdtTransaction`. This helper is
 * retained only for managed-wallet regression and the isolated payment lab.
 */
export async function buildSolanaUsdtTransaction(options: {
  accepted: PaymentRequirement;
  payer: string;
  recentBlockhash: string;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
}): Promise<{ message: Uint8Array; transaction: Uint8Array }> {
  const { accepted, payer, recentBlockhash } = options;
  validateSponsoredRequirement(accepted);
  decodeSolanaBase58(payer);
  if (payer === accepted.payTo || payer === accepted.extra.feePayer) {
    throw new Error("payer, recipient, and fee payer must be distinct");
  }
  const amount = BigInt(accepted.amount);
  const computeLimit = options.computeUnitLimit ?? 20_000;
  const computePrice = options.computeUnitPriceMicroLamports ?? 1;
  if (
    !Number.isSafeInteger(computeLimit) ||
    computeLimit < 1 ||
    computeLimit > 200_000 ||
    !Number.isSafeInteger(computePrice) ||
    computePrice < 0 ||
    computePrice > 1_000_000
  ) {
    throw new Error("Solana compute budget is outside the client ceiling");
  }
  const [source, destination] = await Promise.all([
    solanaAssociatedTokenAddress({
      owner: payer,
      mint: accepted.asset,
    }),
    solanaAssociatedTokenAddress({
      owner: accepted.payTo,
      mint: accepted.asset,
    }),
  ]);
  const accountKeys = [
    String(accepted.extra.feePayer),
    payer,
    source,
    destination,
    accepted.asset,
    SOLANA_COMPUTE_BUDGET_PROGRAM,
    SOLANA_TOKEN_PROGRAM,
    SOLANA_MEMO_PROGRAM,
  ].map(decodeSolanaBase58);
  const compiledInstructions = [
    instruction(
      5,
      [],
      concatenate(Uint8Array.of(2), littleEndian(BigInt(computeLimit), 4)),
    ),
    instruction(
      5,
      [],
      concatenate(Uint8Array.of(3), littleEndian(BigInt(computePrice), 8)),
    ),
    instruction(
      6,
      [2, 4, 3, 1],
      concatenate(Uint8Array.of(12), littleEndian(amount, 8), Uint8Array.of(6)),
    ),
    instruction(7, [], new TextEncoder().encode(String(accepted.extra.memo))),
  ];
  const message = concatenate(
    Uint8Array.of(0x80, 2, 1, 4),
    shortvec(accountKeys.length),
    ...accountKeys,
    decodeSolanaBase58(recentBlockhash),
    shortvec(compiledInstructions.length),
    ...compiledInstructions,
    shortvec(0),
  );
  const transaction = concatenate(shortvec(2), new Uint8Array(128), message);
  if (transaction.length > 1_232)
    throw new Error("transaction exceeds packet size");
  return { message, transaction };
}

function verifySponsoredWalletTransaction(options: {
  unsigned: Uint8Array;
  signed: Uint8Array;
  message: Uint8Array;
}): void {
  const { unsigned, signed, message } = options;
  if (signed.length !== unsigned.length || signed.length > 1_232) {
    throw new Error("wallet changed the transaction size");
  }
  if (signed[0] !== 2 || signed.slice(129).toString() !== message.toString()) {
    throw new Error("wallet changed the frozen Solana message");
  }
  if (
    signed.slice(1, 65).some((value) => value !== 0) ||
    signed.slice(65, 129).every((value) => value === 0)
  ) {
    throw new Error("wallet changed the sponsor slot or omitted its signature");
  }
}

function validateBuyerFundedRequirement(accepted: PaymentRequirement): void {
  if (
    accepted.scheme !== "exact" ||
    accepted.network !== SOLANA_MAINNET_NETWORK ||
    !SOLANA_ISSUER_NATIVE_STABLECOIN_MINTS.has(accepted.asset) ||
    !DECIMAL.test(accepted.amount) ||
    accepted.amount === "0" ||
    typeof accepted.extra !== "object" ||
    accepted.extra === null ||
    Object.keys(accepted.extra).sort().join(",") !== "memo,payloadProfile" ||
    accepted.extra.payloadProfile !== SOLANA_USDT_BUYER_FUNDED_PROFILE ||
    typeof accepted.extra.memo !== "string" ||
    !MEMO.test(accepted.extra.memo)
  ) {
    throw new Error(
      "requirement is not buyer-funded issuer-native Solana USDC or USDT exact",
    );
  }
  decodeSolanaBase58(accepted.asset);
  decodeSolanaBase58(accepted.payTo);
}

/**
 * Build an exact V1 buyer-funded issuer-native Solana stablecoin transaction.
 *
 * The connected buyer is both the SPL token authority and the only transaction
 * signer/fee payer. The frozen v0 message contains exactly two compute-budget
 * instructions, one `TransferChecked`, and the challenge memo.
 */
export async function buildBuyerFundedSolanaPayment(options: {
  accepted: PaymentRequirement;
  payer: string;
  recentBlockhash: string;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: number;
}): Promise<{ message: Uint8Array; transaction: Uint8Array }> {
  const { accepted, payer, recentBlockhash } = options;
  validateBuyerFundedRequirement(accepted);
  decodeSolanaBase58(payer);
  decodeSolanaBase58(recentBlockhash);
  if (payer === accepted.payTo) {
    throw new Error("payer and recipient must be distinct");
  }
  const amount = BigInt(accepted.amount);
  const computeLimit = options.computeUnitLimit ?? 20_000;
  const computePrice = options.computeUnitPriceMicroLamports ?? 1;
  if (
    !Number.isSafeInteger(computeLimit) ||
    computeLimit < 1 ||
    computeLimit > 200_000 ||
    !Number.isSafeInteger(computePrice) ||
    computePrice < 0 ||
    computePrice > 1_000_000
  ) {
    throw new Error("Solana compute budget is outside the client ceiling");
  }
  const [source, destination] = await Promise.all([
    solanaAssociatedTokenAddress({ owner: payer, mint: accepted.asset }),
    solanaAssociatedTokenAddress({
      owner: accepted.payTo,
      mint: accepted.asset,
    }),
  ]);
  const accountKeys = [
    payer,
    source,
    destination,
    accepted.asset,
    SOLANA_COMPUTE_BUDGET_PROGRAM,
    SOLANA_TOKEN_PROGRAM,
    SOLANA_MEMO_PROGRAM,
  ].map(decodeSolanaBase58);
  const compiledInstructions = [
    instruction(
      4,
      [],
      concatenate(Uint8Array.of(2), littleEndian(BigInt(computeLimit), 4)),
    ),
    instruction(
      4,
      [],
      concatenate(Uint8Array.of(3), littleEndian(BigInt(computePrice), 8)),
    ),
    instruction(
      5,
      [1, 3, 2, 0],
      concatenate(Uint8Array.of(12), littleEndian(amount, 8), Uint8Array.of(6)),
    ),
    instruction(6, [], new TextEncoder().encode(String(accepted.extra.memo))),
  ];
  const message = concatenate(
    Uint8Array.of(0x80, 1, 0, 4),
    shortvec(accountKeys.length),
    ...accountKeys,
    decodeSolanaBase58(recentBlockhash),
    shortvec(compiledInstructions.length),
    ...compiledInstructions,
    shortvec(0),
  );
  const transaction = concatenate(shortvec(1), new Uint8Array(64), message);
  if (transaction.length > 1_232) {
    throw new Error("transaction exceeds packet size");
  }
  return { message, transaction };
}

/** @deprecated Use `buildBuyerFundedSolanaPayment`; retained for compatibility. */
export const buildBuyerFundedSolanaUsdtTransaction =
  buildBuyerFundedSolanaPayment;

function verifyBuyerFundedWalletTransaction(options: {
  unsigned: Uint8Array;
  signed: Uint8Array;
  message: Uint8Array;
}): void {
  const { unsigned, signed, message } = options;
  if (signed.length !== unsigned.length || signed.length > 1_232) {
    throw new Error("wallet changed the transaction size");
  }
  if (signed[0] !== 1 || signed.slice(65).toString() !== message.toString()) {
    throw new Error("wallet changed the frozen Solana message");
  }
  if (signed.slice(1, 65).every((value) => value === 0)) {
    throw new Error("wallet omitted the buyer transaction signature");
  }
}

export class ConnectedSolanaWalletRpcTransport implements SolanaWalletTransport {
  constructor(
    private readonly provider: SolanaWalletRpcProvider,
    private readonly account: () => Promise<string>,
  ) {}

  async connect(network: typeof SOLANA_MAINNET_NETWORK): Promise<string> {
    if (network !== SOLANA_MAINNET_NETWORK)
      throw new Error("network is invalid");
    const account = await this.account();
    decodeSolanaBase58(account);
    return account;
  }

  async signTransaction(options: {
    network: typeof SOLANA_MAINNET_NETWORK;
    transactionBase64: string;
  }): Promise<string> {
    const result = await this.provider.request(
      {
        method: "solana_signTransaction",
        params: { transaction: options.transactionBase64 },
      },
      options.network,
    );
    if (typeof result === "string") return result;
    if (
      typeof result === "object" &&
      result !== null &&
      "transaction" in result &&
      typeof result.transaction === "string"
    ) {
      return result.transaction;
    }
    throw new Error("Solana wallet returned no signed transaction");
  }
}

export class SolanaJsonRpc implements SolanaRpc {
  constructor(private readonly endpoint: string) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("Solana browser RPC must be a fixed HTTPS endpoint");
    }
  }

  async latestBlockhash(): Promise<string> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getLatestBlockhash",
        params: [{ commitment: "confirmed" }],
      }),
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("Solana RPC is unavailable");
    const document: unknown = await response.json();
    const blockhash =
      typeof document === "object" &&
      document !== null &&
      "result" in document &&
      typeof document.result === "object" &&
      document.result !== null &&
      "value" in document.result &&
      typeof document.result.value === "object" &&
      document.result.value !== null &&
      "blockhash" in document.result.value
        ? document.result.value.blockhash
        : null;
    if (typeof blockhash !== "string") {
      throw new Error("Solana RPC returned no recent blockhash");
    }
    decodeSolanaBase58(blockhash);
    return blockhash;
  }
}

export async function createSolanaPayment(options: {
  rpc: SolanaRpc;
  wallet: SolanaWalletTransport;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  buyerPaymentIdentifier: string;
  now?: Date;
}): Promise<PaymentPayload> {
  const { accepted, paymentRequired } = options;
  validateBuyerFundedRequirement(accepted);
  await verifyExternalRecipientDeclaration({
    paymentRequired,
    accepted,
  });
  const payer = await options.wallet.connect(SOLANA_MAINNET_NETWORK);
  const recentBlockhash = await options.rpc.latestBlockhash();
  const { message, transaction } = await buildBuyerFundedSolanaPayment({
    accepted,
    payer,
    recentBlockhash,
  });
  const signed = fromBase64(
    await options.wallet.signTransaction({
      network: SOLANA_MAINNET_NETWORK,
      transactionBase64: toBase64(transaction),
    }),
  );
  verifyBuyerFundedWalletTransaction({
    unsigned: transaction,
    signed,
    message,
  });
  return createPaymentPayload({
    paymentRequired,
    accepted,
    paymentIdentifier: options.buyerPaymentIdentifier,
    schemePayload: { transaction: toBase64(signed) },
  });
}

export const createSolanaUsdcPayment = createSolanaPayment;
export const createSolanaUsdtPayment = createSolanaPayment;
export const createBuyerFundedSolanaPayment = createSolanaPayment;
export const createBuyerFundedSolanaUsdtPayment = createSolanaPayment;

/** Create a sponsored Solana USDC/USDT payload where the buyer needs no SOL. */
export async function createSponsoredSolanaPayment(options: {
  rpc: SolanaRpc;
  wallet: SolanaWalletTransport;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  buyerPaymentIdentifier: string;
}): Promise<PaymentPayload> {
  const { accepted, paymentRequired } = options;
  validateSponsoredRequirement(accepted);
  await verifyExternalRecipientDeclaration({ paymentRequired, accepted });
  const payer = await options.wallet.connect(SOLANA_MAINNET_NETWORK);
  const { message, transaction } = await buildSolanaUsdtTransaction({
    accepted,
    payer,
    recentBlockhash: await options.rpc.latestBlockhash(),
  });
  const signed = fromBase64(
    await options.wallet.signTransaction({
      network: SOLANA_MAINNET_NETWORK,
      transactionBase64: toBase64(transaction),
    }),
  );
  verifySponsoredWalletTransaction({ unsigned: transaction, signed, message });
  return createPaymentPayload({
    paymentRequired,
    accepted,
    paymentIdentifier: options.buyerPaymentIdentifier,
    schemePayload: { transaction: toBase64(signed) },
  });
}

export const createSponsoredSolanaUsdcPayment = createSponsoredSolanaPayment;
export const createSponsoredSolanaUsdtPayment = createSponsoredSolanaPayment;

export type SponsoredSolanaPaymentLabAdmission = {
  kind: "tenant-sponsored-solana-payment-lab-v1";
  payer: string;
  recipient: string;
  asset: typeof SOLANA_USDT_MAINNET_MINT;
  amountAtomic: string;
  resourceUrl: string;
  expiresAt: string;
};

/**
 * @deprecated Isolated tenant-sponsored payment-lab helper. It is not part of
 * the external-wallet V1 product path.
 */
export async function createSolanaUsdtLabPayment(options: {
  rpc: SolanaRpc;
  wallet: SolanaWalletTransport;
  paymentRequired: PaymentRequired;
  accepted: PaymentRequirement;
  buyerPaymentIdentifier: string;
  admission: SponsoredSolanaPaymentLabAdmission;
  now?: Date;
}): Promise<PaymentPayload> {
  const { accepted, admission, paymentRequired } = options;
  validateSponsoredRequirement(accepted);
  const now = options.now ?? new Date();
  const expiresAt = new Date(admission.expiresAt);
  if (
    admission.kind !== "tenant-sponsored-solana-payment-lab-v1" ||
    admission.asset !== SOLANA_USDT_MAINNET_MINT ||
    admission.resourceUrl !== paymentRequired.resource.url ||
    admission.recipient !== accepted.payTo ||
    admission.amountAtomic !== accepted.amount ||
    !DECIMAL.test(admission.amountAtomic) ||
    Number.isNaN(expiresAt.valueOf()) ||
    expiresAt <= now
  ) {
    throw new Error(
      "Solana payment-lab admission does not match the challenge",
    );
  }
  const payer = await options.wallet.connect(SOLANA_MAINNET_NETWORK);
  if (payer !== admission.payer) {
    throw new Error("connected Solana wallet is not the admitted lab payer");
  }
  const { message, transaction } = await buildSolanaUsdtTransaction({
    accepted,
    payer,
    recentBlockhash: await options.rpc.latestBlockhash(),
  });
  const signed = fromBase64(
    await options.wallet.signTransaction({
      network: SOLANA_MAINNET_NETWORK,
      transactionBase64: toBase64(transaction),
    }),
  );
  verifySponsoredWalletTransaction({
    unsigned: transaction,
    signed,
    message,
  });
  return createPaymentPayload({
    paymentRequired,
    accepted,
    paymentIdentifier: options.buyerPaymentIdentifier,
    schemePayload: { transaction: toBase64(signed) },
  });
}
