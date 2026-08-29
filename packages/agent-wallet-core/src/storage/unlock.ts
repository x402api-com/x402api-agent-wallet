import { randomBytes } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";

import { AgentWalletError } from "../errors.js";
import { atomicWritePrivate, readPrivateFile } from "./private-files.js";

const MINIMUM_PASSPHRASE_CHARACTERS = 12;
const MAXIMUM_PASSPHRASE_CHARACTERS = 1024;

export type WalletUnlockSetup = {
  version: 1;
  status: "configured" | "already_configured";
  passwordFile: string;
};

export function normalizeWalletPassphrase(value: string): string {
  const normalized = value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
  if (
    normalized.includes("\n") ||
    normalized.includes("\r") ||
    normalized.length < MINIMUM_PASSPHRASE_CHARACTERS ||
    normalized.length > MAXIMUM_PASSPHRASE_CHARACTERS
  ) {
    throw new AgentWalletError(
      "password_required",
      "wallet passphrase must be one line containing 12-1024 characters",
    );
  }
  return normalized;
}

export async function readWalletPassphraseFile(path: string): Promise<string> {
  const absolute = resolve(path);
  let bytes: Buffer;
  try {
    bytes = await readPrivateFile(absolute, MAXIMUM_PASSPHRASE_CHARACTERS + 2);
  } catch (error) {
    if (
      error instanceof AgentWalletError &&
      error.code === "wallet_not_found"
    ) {
      throw new AgentWalletError(
        "password_required",
        "wallet password source is not configured; run x402api wallet setup --json",
        { cause: error },
      );
    }
    throw error;
  }
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AgentWalletError(
      "wallet_storage_unsafe",
      "wallet password file is not valid UTF-8",
      { cause: error },
    );
  }
  return normalizeWalletPassphrase(value);
}

export async function setupWalletUnlock(options: {
  passwordFile: string;
  passphrase?: string;
}): Promise<WalletUnlockSetup> {
  const passwordFile = resolve(options.passwordFile);
  const existing = await lstat(passwordFile).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existing !== undefined) {
    await readWalletPassphraseFile(passwordFile);
    return { version: 1, status: "already_configured", passwordFile };
  }

  const passphrase =
    options.passphrase === undefined
      ? randomBytes(32).toString("base64url")
      : normalizeWalletPassphrase(options.passphrase);
  try {
    await atomicWritePrivate(passwordFile, `${passphrase}\n`);
  } catch (error) {
    if (!(error instanceof AgentWalletError) || error.code !== "wallet_exists") {
      throw error;
    }
    await readWalletPassphraseFile(passwordFile);
    return { version: 1, status: "already_configured", passwordFile };
  }
  return { version: 1, status: "configured", passwordFile };
}
