import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readWalletPassphraseFile,
  setupWalletUnlock,
  walletPaths,
} from "../src/index.js";

const roots: string[] = [];

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "x402api-unlock-test-"));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("managed wallet unlock", () => {
  it("creates one owner-only source and reuses it without overwrite", async () => {
    const paths = walletPaths(join(await privateRoot(), "data"));
    const first = await setupWalletUnlock({ passwordFile: paths.unlock });
    const initialPassphrase = await readWalletPassphraseFile(paths.unlock);
    const second = await setupWalletUnlock({
      passwordFile: paths.unlock,
      passphrase: "replacement must never overwrite",
    });

    expect(first.status).toBe("configured");
    expect(second.status).toBe("already_configured");
    expect(await readWalletPassphraseFile(paths.unlock)).toBe(initialPassphrase);
    expect(initialPassphrase.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== "win32") {
      expect((await lstat(paths.root)).mode & 0o077).toBe(0);
      expect((await lstat(paths.unlock)).mode & 0o077).toBe(0);
    }
  });

  it("converges concurrent setup calls on the same valid source", async () => {
    const paths = walletPaths(join(await privateRoot(), "data"));
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        setupWalletUnlock({ passwordFile: paths.unlock }),
      ),
    );

    expect(results.filter(({ status }) => status === "configured")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "already_configured")).toHaveLength(7);
    await expect(readWalletPassphraseFile(paths.unlock)).resolves.toHaveLength(43);
  });

  it("rejects an existing password source with broad permissions", async () => {
    const paths = walletPaths(join(await privateRoot(), "data"));
    await setupWalletUnlock({ passwordFile: paths.unlock });
    if (process.platform === "win32") return;
    await chmod(paths.unlock, 0o644);

    await expect(
      setupWalletUnlock({ passwordFile: paths.unlock }),
    ).rejects.toMatchObject({ code: "wallet_storage_unsafe" });
  });

  it("rejects a symbolic-link password source", async () => {
    if (process.platform === "win32") return;
    const root = await privateRoot();
    const paths = walletPaths(join(root, "data"));
    const target = join(root, "external-password");
    await mkdir(paths.root, { mode: 0o700 });
    await writeFile(target, "must never be followed\n", { mode: 0o600 });
    await symlink(target, paths.unlock);

    await expect(
      setupWalletUnlock({ passwordFile: paths.unlock }),
    ).rejects.toMatchObject({ code: "wallet_storage_unsafe" });
  });
});
