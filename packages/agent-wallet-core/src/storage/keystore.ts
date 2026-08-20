import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
  scrypt,
} from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Wallet } from "ethers";
import { TronWeb } from "tronweb";
import nacl from "tweetnacl";

import { AgentWalletError } from "../errors.js";
import { encodeSolanaBase58 } from "../protocol/solana.js";
import {
  atomicWritePrivate,
  ensurePrivateDirectory,
  readPrivateFile,
} from "./private-files.js";

export const SUPPORTED_NETWORKS = [
  "eip155:8453",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "tron:mainnet",
] as const;

export type SupportedNetwork = (typeof SUPPORTED_NETWORKS)[number];

export type WalletMetadata = {
  version: 1;
  walletId: string;
  name: string;
  network: SupportedNetwork;
  address: string;
  createdAt: string;
  maximumPaymentAtomic?: string;
  retiredAt?: string;
};

export type WalletSecret = {
  version: 1;
  privateKeyHex?: string;
  seedBase64?: string;
};

type EncryptedKeystore = WalletMetadata & {
  crypto: {
    cipher: "aes-256-gcm";
    ciphertext: string;
    iv: string;
    tag: string;
    kdf: "scrypt";
    salt: string;
    n: 32768;
    r: 8;
    p: 1;
  };
};

const WALLET_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,77})$/;
const HEX32 = /^[0-9a-f]{64}$/;

function exactObject(
  value: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentWalletError("wallet_locked", `${label} is malformed`);
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !allowed.includes(key))) {
    throw new AgentWalletError("wallet_locked", `${label} has unknown fields`);
  }
  return object;
}

function assertName(name: string): void {
  if (!WALLET_NAME.test(name)) {
    throw new AgentWalletError(
      "invalid_input",
      "wallet name must be 1-64 lowercase letters, digits, dots, dashes, or underscores",
    );
  }
}

function assertPassphrase(passphrase: string): void {
  if (passphrase.length < 12 || passphrase.length > 1024) {
    throw new AgentWalletError(
      "password_required",
      "wallet passphrase must contain 12-1024 characters",
    );
  }
}

function metadataFrom(value: unknown): WalletMetadata {
  const object = exactObject(
    value,
    [
      "version",
      "walletId",
      "name",
      "network",
      "address",
      "createdAt",
      "maximumPaymentAtomic",
      "retiredAt",
      "crypto",
    ],
    "keystore",
  );
  if (
    object.version !== 1 ||
    typeof object.walletId !== "string" ||
    typeof object.name !== "string" ||
    !WALLET_NAME.test(object.name) ||
    typeof object.network !== "string" ||
    !SUPPORTED_NETWORKS.includes(object.network as SupportedNetwork) ||
    typeof object.address !== "string" ||
    typeof object.createdAt !== "string" ||
    !Number.isFinite(Date.parse(object.createdAt)) ||
    (object.maximumPaymentAtomic !== undefined &&
      (typeof object.maximumPaymentAtomic !== "string" ||
        !DECIMAL.test(object.maximumPaymentAtomic))) ||
    (object.retiredAt !== undefined &&
      (typeof object.retiredAt !== "string" ||
        !Number.isFinite(Date.parse(object.retiredAt))))
  ) {
    throw new AgentWalletError("wallet_locked", "keystore metadata is malformed");
  }
  return {
    version: 1,
    walletId: object.walletId,
    name: object.name,
    network: object.network as SupportedNetwork,
    address: object.address,
    createdAt: object.createdAt,
    ...(object.maximumPaymentAtomic === undefined
      ? {}
      : { maximumPaymentAtomic: object.maximumPaymentAtomic }),
    ...(object.retiredAt === undefined ? {} : { retiredAt: object.retiredAt }),
  };
}

function parseKeystore(bytes: Uint8Array): EncryptedKeystore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new AgentWalletError("wallet_locked", "keystore is not UTF-8 JSON", {
      cause: error,
    });
  }
  const metadata = metadataFrom(parsed);
  const object = parsed as Record<string, unknown>;
  const crypto = exactObject(
    object.crypto,
    ["cipher", "ciphertext", "iv", "tag", "kdf", "salt", "n", "r", "p"],
    "keystore crypto",
  );
  if (
    crypto.cipher !== "aes-256-gcm" ||
    crypto.kdf !== "scrypt" ||
    crypto.n !== 32768 ||
    crypto.r !== 8 ||
    crypto.p !== 1 ||
    ![crypto.ciphertext, crypto.iv, crypto.tag, crypto.salt].every(
      (entry) => typeof entry === "string" && entry.length > 0,
    )
  ) {
    throw new AgentWalletError("wallet_locked", "keystore crypto is malformed");
  }
  return { ...metadata, crypto: crypto as EncryptedKeystore["crypto"] };
}

function aad(metadata: WalletMetadata): Buffer {
  return Buffer.from(JSON.stringify(metadata), "utf8");
}

async function deriveKey(passphrase: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    scrypt(
      passphrase,
      salt,
      32,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, key) => {
        if (error) rejectPromise(error);
        else resolvePromise(key);
      },
    );
  });
}

function secretForNetwork(network: SupportedNetwork): WalletSecret {
  if (network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") {
    return { version: 1, seedBase64: randomBytes(32).toString("base64") };
  }
  for (;;) {
    const privateKeyHex = randomBytes(32).toString("hex");
    try {
      new Wallet(`0x${privateKeyHex}`);
      return { version: 1, privateKeyHex };
    } catch {
      // Invalid secp256k1 entropy is vanishingly unlikely; retry safely.
    }
  }
}

export function deriveWalletAddress(
  network: SupportedNetwork,
  secret: WalletSecret,
): string {
  if (network === "eip155:8453") {
    if (!secret.privateKeyHex || !HEX32.test(secret.privateKeyHex)) {
      throw new AgentWalletError("wallet_locked", "Base key material is malformed");
    }
    return new Wallet(`0x${secret.privateKeyHex}`).address;
  }
  if (network === "tron:mainnet") {
    if (!secret.privateKeyHex || !HEX32.test(secret.privateKeyHex)) {
      throw new AgentWalletError("wallet_locked", "TRON key material is malformed");
    }
    const address = TronWeb.address.fromPrivateKey(secret.privateKeyHex);
    if (address === false) {
      throw new AgentWalletError("wallet_locked", "TRON key is invalid");
    }
    return address;
  }
  if (!secret.seedBase64) {
    throw new AgentWalletError("wallet_locked", "Solana key material is malformed");
  }
  const seed = Buffer.from(secret.seedBase64, "base64");
  if (seed.length !== 32 || seed.toString("base64") !== secret.seedBase64) {
    throw new AgentWalletError("wallet_locked", "Solana seed is malformed");
  }
  return encodeSolanaBase58(nacl.sign.keyPair.fromSeed(seed).publicKey);
}

async function seal(
  metadata: WalletMetadata,
  secret: WalletSecret,
  passphrase: string,
): Promise<EncryptedKeystore> {
  assertPassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const plaintext = Buffer.from(JSON.stringify(secret), "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(metadata));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      ...metadata,
      crypto: {
        cipher: "aes-256-gcm",
        ciphertext: ciphertext.toString("base64"),
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        kdf: "scrypt",
        salt: salt.toString("base64"),
        n: 32768,
        r: 8,
        p: 1,
      },
    };
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
}

async function unseal(
  keystore: EncryptedKeystore,
  passphrase: string,
): Promise<WalletSecret> {
  assertPassphrase(passphrase);
  const key = await deriveKey(
    passphrase,
    Buffer.from(keystore.crypto.salt, "base64"),
  );
  let plaintext: Buffer | undefined;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(keystore.crypto.iv, "base64"),
    );
    decipher.setAAD(aad(metadataFrom(keystore)));
    decipher.setAuthTag(Buffer.from(keystore.crypto.tag, "base64"));
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(keystore.crypto.ciphertext, "base64")),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
    const object = exactObject(
      parsed,
      ["version", "privateKeyHex", "seedBase64"],
      "wallet secret",
    );
    if (
      object.version !== 1 ||
      (object.privateKeyHex !== undefined &&
        typeof object.privateKeyHex !== "string") ||
      (object.seedBase64 !== undefined && typeof object.seedBase64 !== "string")
    ) {
      throw new Error("secret schema is invalid");
    }
    const secret = object as WalletSecret;
    if (deriveWalletAddress(keystore.network, secret) !== keystore.address) {
      throw new Error("secret does not match the public address");
    }
    return secret;
  } catch (error) {
    throw new AgentWalletError(
      "wallet_locked",
      "keystore could not be unlocked or failed integrity validation",
      { cause: error },
    );
  } finally {
    key.fill(0);
    plaintext?.fill(0);
  }
}

export function walletFilePath(walletsDirectory: string, name: string): string {
  assertName(name);
  return join(resolve(walletsDirectory), `${name}.wallet.json`);
}

export async function createWallet(options: {
  walletsDirectory: string;
  name: string;
  network: SupportedNetwork;
  passphrase: string;
  maximumPaymentAtomic?: string;
}): Promise<WalletMetadata> {
  assertName(options.name);
  if (!SUPPORTED_NETWORKS.includes(options.network)) {
    throw new AgentWalletError("unsupported_network", "network is not supported");
  }
  if (
    options.maximumPaymentAtomic !== undefined &&
    !DECIMAL.test(options.maximumPaymentAtomic)
  ) {
    throw new AgentWalletError(
      "invalid_input",
      "payment ceiling is not canonical decimal",
    );
  }
  const secret = secretForNetwork(options.network);
  const metadata: WalletMetadata = {
    version: 1,
    walletId: randomUUID(),
    name: options.name,
    network: options.network,
    address: deriveWalletAddress(options.network, secret),
    createdAt: new Date().toISOString(),
    ...(options.maximumPaymentAtomic === undefined
      ? {}
      : { maximumPaymentAtomic: options.maximumPaymentAtomic }),
  };
  const keystore = await seal(metadata, secret, options.passphrase);
  await ensurePrivateDirectory(options.walletsDirectory);
  await atomicWritePrivate(
    walletFilePath(options.walletsDirectory, options.name),
    `${JSON.stringify(keystore, null, 2)}\n`,
  );
  return metadata;
}

export async function readWalletMetadata(
  walletsDirectory: string,
  name: string,
): Promise<WalletMetadata> {
  const bytes = await readPrivateFile(walletFilePath(walletsDirectory, name));
  return metadataFrom(parseKeystore(bytes));
}

export async function listWallets(
  walletsDirectory: string,
): Promise<WalletMetadata[]> {
  await ensurePrivateDirectory(walletsDirectory);
  const names = (await readdir(walletsDirectory))
    .filter((name) => name.endsWith(".wallet.json"))
    .sort();
  return Promise.all(
    names.map(async (file) =>
      metadataFrom(parseKeystore(await readPrivateFile(join(walletsDirectory, file)))),
    ),
  );
}

export async function unlockWallet(
  walletsDirectory: string,
  name: string,
  passphrase: string,
): Promise<{ metadata: WalletMetadata; secret: WalletSecret }> {
  const bytes = await readPrivateFile(walletFilePath(walletsDirectory, name));
  const keystore = parseKeystore(bytes);
  if (keystore.retiredAt !== undefined) {
    throw new AgentWalletError("wallet_locked", "wallet is retired");
  }
  return {
    metadata: metadataFrom(keystore),
    secret: await unseal(keystore, passphrase),
  };
}

export async function backupWallet(options: {
  walletsDirectory: string;
  name: string;
  output: string;
}): Promise<string> {
  const source = walletFilePath(options.walletsDirectory, options.name);
  const bytes = await readPrivateFile(source);
  parseKeystore(bytes);
  const destination = resolve(options.output);
  if (destination === source) {
    throw new AgentWalletError(
      "invalid_input",
      "backup destination equals the live keystore",
    );
  }
  await atomicWritePrivate(destination, bytes);
  return destination;
}

export async function importWallet(options: {
  walletsDirectory: string;
  name: string;
  input: string;
  passphrase: string;
}): Promise<WalletMetadata> {
  assertName(options.name);
  const imported = parseKeystore(await readPrivateFile(resolve(options.input)));
  const secret = await unseal(imported, options.passphrase);
  const metadata: WalletMetadata = {
    ...metadataFrom(imported),
    walletId: randomUUID(),
    name: options.name,
    createdAt: new Date().toISOString(),
  };
  delete metadata.retiredAt;
  const resealed = await seal(metadata, secret, options.passphrase);
  await atomicWritePrivate(
    walletFilePath(options.walletsDirectory, options.name),
    `${JSON.stringify(resealed, null, 2)}\n`,
  );
  return metadata;
}

export async function retireWallet(options: {
  walletsDirectory: string;
  name: string;
  passphrase: string;
  confirmation: string;
}): Promise<WalletMetadata> {
  if (options.confirmation !== options.name) {
    throw new AgentWalletError(
      "operator_confirmation_required",
      `retirement confirmation must exactly equal ${options.name}`,
    );
  }
  const path = walletFilePath(options.walletsDirectory, options.name);
  const existing = parseKeystore(await readPrivateFile(path));
  const secret = await unseal(existing, options.passphrase);
  const metadata: WalletMetadata = {
    ...metadataFrom(existing),
    retiredAt: new Date().toISOString(),
  };
  const resealed = await seal(metadata, secret, options.passphrase);
  await atomicWritePrivate(path, `${JSON.stringify(resealed, null, 2)}\n`, {
    overwrite: true,
  });
  return metadata;
}

export type UnlockedWallet = Awaited<ReturnType<typeof unlockWallet>>;
