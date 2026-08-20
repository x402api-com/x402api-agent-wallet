import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "x402api-cli-test-"));
  await chmod(root, 0o700);
  roots.push(root);
  const passwordFile = join(root, "password");
  const secret = "correct horse battery staple";
  await writeFile(passwordFile, `${secret}\n`, { mode: 0o600 });
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    root,
    secret,
    stdout,
    stderr,
    options: {
      environment: {
        X402API_HOME: join(root, "data"),
        X402API_WALLET_PASSWORD_FILE: passwordFile,
      },
      io: {
        stdout: (value: string) => stdout.push(value),
        stderr: (value: string) => stderr.push(value),
        readStdin: async () => "",
      },
    },
  };
}

describe("agent wallet CLI contract", () => {
  it("creates and inspects a wallet with JSON-only, secret-free output", async () => {
    const state = await fixture();
    expect(
      await runCli(
        [
          "wallet",
          "create",
          "--name",
          "buyer",
          "--network",
          "eip155:8453",
          "--json",
        ],
        state.options,
      ),
    ).toBe(0);
    expect(await runCli(["wallet", "list", "--json"], state.options)).toBe(0);
    const output = state.stdout.join("");
    expect(output).toContain('"status":"created_unfunded"');
    expect(output).toContain('"wallet":"buyer"');
    expect(output).not.toContain(state.secret);
    expect(output).not.toMatch(/privateKey|seedBase64|ciphertext/);
    expect(state.stderr).toEqual([]);
  });

  it("requires --json and release-gates sweep", async () => {
    const state = await fixture();
    expect(await runCli(["help"], state.options)).toBe(2);
    expect(state.stderr[0]).toMatch(/--json is required/);
    expect(
      await runCli(
        ["wallet", "sweep", "--wallet", "buyer", "--to", "0x1", "--json"],
        state.options,
      ),
    ).toBe(71);
    expect(JSON.parse(state.stdout.at(-1)!).error.code).toBe("operation_not_supported");
  });

  it("rejects a password file readable by other users", async () => {
    const state = await fixture();
    await chmod(state.options.environment.X402API_WALLET_PASSWORD_FILE!, 0o644);
    expect(
      await runCli(
        [
          "wallet",
          "create",
          "--name",
          "buyer",
          "--network",
          "eip155:8453",
          "--json",
        ],
        state.options,
      ),
    ).toBe(13);
    expect(JSON.parse(state.stdout.at(-1)!).error.code).toBe("wallet_storage_unsafe");
  });
});
