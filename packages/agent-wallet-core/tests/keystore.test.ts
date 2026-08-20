import { chmod, lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentWalletError,
  backupWallet,
  createWallet,
  importWallet,
  listWallets,
  retireWallet,
  unlockWallet,
  walletFilePath,
  type SupportedNetwork,
} from "../src/index.js";

const roots: string[] = [];
const password = "correct horse battery staple";

async function privateTemporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "x402api-wallet-test-"));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("encrypted local keystore", () => {
  it.each<SupportedNetwork>([
    "eip155:8453",
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "tron:mainnet",
  ])("creates and unlocks a dedicated %s wallet", async (network) => {
    const root = await privateTemporaryDirectory();
    const walletsDirectory = join(root, "wallets");
    const created = await createWallet({
      walletsDirectory,
      name: "buyer",
      network,
      passphrase: password,
      maximumPaymentAtomic: "2500000",
    });

    expect(created.address.length).toBeGreaterThan(20);
    expect((await unlockWallet(walletsDirectory, "buyer", password)).metadata).toEqual(created);
    expect((await lstat(walletFilePath(walletsDirectory, "buyer"))).mode & 0o077).toBe(0);
    await expect(unlockWallet(walletsDirectory, "buyer", "this password is wrong"))
      .rejects.toMatchObject({ code: "wallet_locked" } satisfies Partial<AgentWalletError>);
  });

  it("backs up, imports under a new identity, and retires with confirmation", async () => {
    const root = await privateTemporaryDirectory();
    const walletsDirectory = join(root, "wallets");
    await createWallet({
      walletsDirectory,
      name: "primary",
      network: "eip155:8453",
      passphrase: password,
    });
    const backup = join(root, "backups", "primary.wallet.json");
    await backupWallet({ walletsDirectory, name: "primary", output: backup });
    const imported = await importWallet({
      walletsDirectory,
      name: "restored",
      input: backup,
      passphrase: password,
    });
    expect((await listWallets(walletsDirectory)).map((wallet) => wallet.name)).toEqual([
      "primary",
      "restored",
    ]);
    await expect(
      retireWallet({
        walletsDirectory,
        name: "restored",
        passphrase: password,
        confirmation: "wrong",
      }),
    ).rejects.toMatchObject({ code: "operator_confirmation_required" });
    const retired = await retireWallet({
      walletsDirectory,
      name: "restored",
      passphrase: password,
      confirmation: "restored",
    });
    expect(retired.address).toBe(imported.address);
    expect(retired.retiredAt).toBeDefined();
    await expect(unlockWallet(walletsDirectory, "restored", password)).rejects.toMatchObject({
      code: "wallet_locked",
    });
  });
});
