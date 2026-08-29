import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type WalletPaths = {
  root: string;
  unlock: string;
  wallets: string;
  attempts: string;
};

export function defaultDataRoot(environment = process.env): string {
  if (environment.X402API_HOME) return resolve(environment.X402API_HOME);
  if (environment.XDG_DATA_HOME) {
    return resolve(environment.XDG_DATA_HOME, "x402api");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "x402api");
  }
  return join(homedir(), ".local", "share", "x402api");
}

export function walletPaths(root = defaultDataRoot()): WalletPaths {
  const absolute = resolve(root);
  return {
    root: absolute,
    unlock: join(absolute, "wallet.unlock"),
    wallets: join(absolute, "wallets"),
    attempts: join(absolute, "attempts"),
  };
}
