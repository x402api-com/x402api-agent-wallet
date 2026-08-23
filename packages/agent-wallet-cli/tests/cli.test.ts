import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttemptStore,
  encodePaymentRequiredHeader,
  loadRequestEnvelope,
  walletPaths,
  type PaymentRequired,
} from "@x402api/agent-wallet-core";

import { runCli } from "../src/cli.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.unstubAllGlobals();
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
    expect(JSON.parse(state.stdout.at(-1)!).error.code).toBe(
      "operation_not_supported",
    );
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
    expect(JSON.parse(state.stdout.at(-1)!).error.code).toBe(
      "wallet_storage_unsafe",
    );
  });

  it("installs the bundled payment skill without overwriting an existing directory", async () => {
    const state = await fixture();
    const output = join(state.root, "skills", "x402api-pay");
    expect(
      await runCli(
        ["skill", "install", "--output", output, "--json"],
        state.options,
      ),
    ).toBe(0);
    expect(await readFile(join(output, "SKILL.md"), "utf8")).toContain(
      "name: x402api-pay",
    );
    expect(
      await runCli(
        ["skill", "install", "--output", output, "--json"],
        state.options,
      ),
    ).toBe(2);
    expect(JSON.parse(state.stdout.at(-1)!).error.message).toMatch(
      /already exists/,
    );
  });

  it("submits an existing exact attempt without printing signature or paid content", async () => {
    const state = await fixture();
    const requestEnvelopePath = join(state.root, "request.json");
    const artifactPath = join(state.root, "payment.json");
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://merchant.example/paid" },
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: "100000",
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x1111111111111111111111111111111111111111",
          maxTimeoutSeconds: 180,
          extra: {
            assetTransferMethod: "eip3009",
            name: "USD Coin",
            version: "2",
            payloadProfile: "com.x402api.x402.base-usdc-eip3009-sponsored.v1",
          },
        },
      ],
    };
    await writeFile(
      requestEnvelopePath,
      `${JSON.stringify({
        version: 1,
        method: "POST",
        url: paymentRequired.resource.url,
        contentType: "application/json",
        bodyBase64: Buffer.from('{"sku":"report"}').toString("base64"),
        paymentRequired: encodePaymentRequiredHeader(paymentRequired),
        challengeDigest: `sha256:${"6".repeat(64)}`,
      })}\n`,
      { mode: 0o600 },
    );
    const loaded = await loadRequestEnvelope(requestEnvelopePath);
    const store = new AttemptStore(
      walletPaths(state.options.environment.X402API_HOME).attempts,
    );
    const { record, artifact } = await store.persistAuthorized({
      requestDigest: loaded.requestDigest,
      challengeDigest: loaded.envelope.challengeDigest,
      selectedRequirementDigest: `sha256:${"7".repeat(64)}`,
      buyerPaymentIdentifier: "buyer-payment-0001",
      wallet: "buyer",
      network: "eip155:8453",
      payerAddress: "0x2222222222222222222222222222222222222222",
      paymentSignature: Buffer.from('{"signed":true}').toString("base64"),
      artifactPath,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const paidBody = '{"download":"ready"}';
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(paidBody, {
            status: 200,
            headers: {
              "PAYMENT-RESPONSE": Buffer.from(
                JSON.stringify({
                  success: true,
                  transaction: "0xabc",
                  network: "eip155:8453",
                }),
              ).toString("base64"),
            },
          }),
      ),
    );

    expect(
      await runCli(
        [
          "payment",
          "submit",
          "--attempt",
          record.attemptId,
          "--request-envelope",
          requestEnvelopePath,
          "--json",
        ],
        state.options,
      ),
    ).toBe(0);
    const output = state.stdout.at(-1)!;
    expect(JSON.parse(output)).toMatchObject({
      state: "fulfilled",
      transaction: "0xabc",
    });
    expect(output).not.toContain(artifact.paymentSignature);
    expect(output).not.toContain(paidBody);
  });
});
