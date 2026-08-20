import {
  constants,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

import { AgentWalletError } from "../errors.js";
import type { AgentWalletErrorCode } from "../errors.js";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function assertOwner(stat: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new AgentWalletError(
      "wallet_storage_unsafe",
      `wallet storage is not owned by the current user: ${path}`,
    );
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new AgentWalletError(
      "wallet_storage_unsafe",
      `wallet storage is not a real directory: ${path}`,
    );
  }
  assertOwner(stat, path);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new AgentWalletError(
      "wallet_storage_unsafe",
      `wallet storage permissions must be 0700: ${path}`,
    );
  }
}

export async function readPrivateFile(
  path: string,
  maximumBytes = 1024 * 1024,
): Promise<Buffer> {
  const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new AgentWalletError("wallet_not_found", `file not found: ${path}`);
    }
    throw error;
  });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new AgentWalletError(
      "wallet_storage_unsafe",
      `wallet file is not a regular file: ${path}`,
    );
  }
  assertOwner(stat, path);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new AgentWalletError(
      "wallet_storage_unsafe",
      `wallet file permissions must be 0600: ${path}`,
    );
  }
  if (stat.size < 1 || stat.size > maximumBytes) {
    throw new AgentWalletError(
      "wallet_storage_unsafe",
      `wallet file size is outside the supported bound: ${path}`,
    );
  }
  return readFile(path);
}

export async function atomicWritePrivate(
  path: string,
  data: string | Uint8Array,
  options: {
    overwrite?: boolean;
    existsCode?: AgentWalletErrorCode;
  } = {},
): Promise<void> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  if (!options.overwrite) {
    try {
      await lstat(path);
      throw new AgentWalletError(
        options.existsCode ?? "wallet_exists",
        `file already exists: ${path}`,
      );
    } catch (error) {
      if (error instanceof AgentWalletError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const temporary = join(
    parent,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (options.overwrite) {
      await rename(temporary, path);
    } else {
      await link(temporary, path);
      await unlink(temporary);
    }
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new AgentWalletError(
        options.existsCode ?? "wallet_exists",
        `file already exists: ${path}`,
      );
    }
    throw error;
  }
}
