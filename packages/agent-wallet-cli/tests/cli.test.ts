import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AttemptStore,
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_USDC_MAINNET_MINT,
  encodePaymentRequiredHeader,
  loadRequestEnvelope,
  walletPaths,
  type PaymentRequired,
} from "@x402api/agent-wallet-core";

import { runCli } from "../src/cli.js";

const roots: string[] = [];

function rpc(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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
  it("routes a missing managed source to wallet setup", async () => {
    const state = await fixture();
    const options = {
      ...state.options,
      environment: {
        X402API_HOME: state.options.environment.X402API_HOME,
      },
    };

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
        options,
      ),
    ).toBe(14);
    expect(JSON.parse(state.stdout.at(-1)!)).toMatchObject({
      error: {
        code: "password_required",
        message:
          "wallet password source is not configured; run x402api wallet setup --json",
      },
    });
  });

  it("sets up a managed unlock source and creates a wallet without environment plumbing", async () => {
    const state = await fixture();
    const environment: NodeJS.ProcessEnv = {
      X402API_HOME: state.options.environment.X402API_HOME,
    };
    const options = { ...state.options, environment };

    expect(await runCli(["wallet", "setup", "--json"], options)).toBe(0);
    const setup = JSON.parse(state.stdout.at(-1)!);
    expect(setup).toMatchObject({
      version: 1,
      status: "configured",
      passwordSource: "managed_default_file",
    });
    expect(setup.supportedNetworks).toContain("eip155:8453");
    expect(JSON.stringify(setup)).not.toMatch(/passphrase|privateKey|ciphertext/);
    if (process.platform !== "win32") {
      expect((await lstat(setup.passwordFile)).mode & 0o077).toBe(0);
    }

    expect(await runCli(["wallet", "setup", "--json"], options)).toBe(0);
    expect(JSON.parse(state.stdout.at(-1)!).status).toBe("already_configured");
    expect(
      await runCli(
        [
          "wallet",
          "create",
          "--name",
          "managed-buyer",
          "--network",
          "eip155:8453",
          "--maximum-payment-atomic",
          "25000000",
          "--json",
        ],
        options,
      ),
    ).toBe(0);
    const created = JSON.parse(state.stdout.at(-1)!);
    expect(created.status).toBe("created_unfunded");
    expect(created.fundingAssets[0].funding.argv).toContain(
      "<target-balance-atomic>",
    );
  });

  it("can seed the managed source from supervised stdin without echoing it", async () => {
    const state = await fixture();
    const supervisedSecret = "operator supervised passphrase";
    const options = {
      environment: {
        X402API_HOME: state.options.environment.X402API_HOME,
      },
      io: {
        ...state.options.io,
        readStdin: async () => `${supervisedSecret}\n`,
      },
    };

    expect(
      await runCli(
        ["wallet", "setup", "--password-stdin", "--json"],
        options,
      ),
    ).toBe(0);
    expect(state.stdout.at(-1)).not.toContain(supervisedSecret);
    expect(
      await runCli(
        [
          "wallet",
          "create",
          "--name",
          "stdin-buyer",
          "--network",
          "eip155:8453",
          "--json",
        ],
        options,
      ),
    ).toBe(0);
  });

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

  it("returns exact Base funding deficit and payer-address guidance", async () => {
    const state = await fixture();
    const environment = {
      ...state.options.environment,
      X402API_BASE_RPC_URL: "http://localhost:8545/",
    };
    const options = { ...state.options, environment };
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
        options,
      ),
    ).toBe(0);
    const created = JSON.parse(state.stdout.at(-1)!);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "eth_chainId") return rpc("0x2105");
        if (request.method === "eth_getBalance") return rpc("0x0");
        return rpc(`0x${"0".repeat(64)}`);
      }),
    );

    expect(
      await runCli(
        [
          "wallet",
          "funding",
          "--wallet",
          "buyer",
          "--asset",
          "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          "--target-balance-atomic",
          "25000000",
          "--json",
        ],
        options,
      ),
    ).toBe(0);
    const funding = JSON.parse(state.stdout.at(-1)!);
    expect(funding).toMatchObject({
      status: "funding_required",
      assetSymbol: "USDC",
      assetAtomic: "0",
      targetBalanceAtomic: "25000000",
      targetBalance: "25",
      deficitAtomic: "25000000",
      deficit: "25",
      funding: {
        destination: created.address,
        qrPayload: created.address,
        amountAtomic: "25000000",
        amount: "25",
        nativeFeeFundingRequiredForSupportedPayments: false,
      },
    });
    expect(funding.funding.instruction).toContain("payer wallet address");
    expect(funding.funding.networkFee).toContain("Do not fund ETH or SOL");
    expect(JSON.stringify(funding)).not.toContain(state.secret);
  });

  it("checks the exact selected Solana stablecoin when calculating funding", async () => {
    const state = await fixture();
    const environment = {
      ...state.options.environment,
      X402API_SOLANA_RPC_URL: "http://localhost:8899/",
    };
    const options = { ...state.options, environment };
    expect(
      await runCli(
        [
          "wallet",
          "create",
          "--name",
          "solana-buyer",
          "--network",
          "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
          "--json",
        ],
        options,
      ),
    ).toBe(0);
    const selectedMints: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          method: string;
          params: unknown[];
        };
        if (request.method === "getGenesisHash") {
          return rpc(SOLANA_MAINNET_GENESIS_HASH);
        }
        if (request.method === "getBalance") return rpc({ value: 0 });
        const selection = request.params[1] as { mint: string };
        selectedMints.push(selection.mint);
        return rpc({
          value: [
            {
              account: {
                data: {
                  parsed: { info: { tokenAmount: { amount: "5000000" } } },
                },
              },
            },
          ],
        });
      }),
    );

    expect(
      await runCli(
        [
          "wallet",
          "funding",
          "--wallet",
          "solana-buyer",
          "--asset",
          SOLANA_USDC_MAINNET_MINT,
          "--target-balance-atomic",
          "25000000",
          "--json",
        ],
        options,
      ),
    ).toBe(0);
    expect(selectedMints).toEqual([SOLANA_USDC_MAINNET_MINT]);
    expect(JSON.parse(state.stdout.at(-1)!)).toMatchObject({
      asset: SOLANA_USDC_MAINNET_MINT,
      assetSymbol: "USDC",
      deficitAtomic: "20000000",
      deficit: "20",
    });
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

  it("accepts confirmed 202, exposes status, and requires explicit reconciliation", async () => {
    const state = await fixture();
    const requestEnvelopePath = join(state.root, "confirmed-request.json");
    const artifactPath = join(state.root, "confirmed-payment.json");
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource: { url: "https://merchant.example/confirmed" },
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
        bodyBase64: Buffer.from('{"sku":"server"}').toString("base64"),
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
      buyerPaymentIdentifier: "buyer-payment-0002",
      wallet: "buyer",
      network: "eip155:8453",
      payerAddress: "0x2222222222222222222222222222222222222222",
      paymentSignature: Buffer.from('{"signed":true}').toString("base64"),
      artifactPath,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const paymentId = "01a069c8-77b9-75c7-946b-1858db8b8249";
    const paidBody = JSON.stringify({
      status: "payment_confirmed",
      paymentId,
      transaction: "0xabc",
      payment: {
        state: "confirmed",
        confirmed: true,
        finalized: false,
      },
      fulfillment: { status: "waiting_for_finality" },
    });
    const seenSignatures: string[] = [];
    const fetchImplementation = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        seenSignatures.push(
          new Headers(init?.headers).get("PAYMENT-SIGNATURE")!,
        );
        return new Response(paidBody, {
          status: 202,
          headers: {
            "Retry-After": "2",
            "PAYMENT-RESPONSE": Buffer.from(
              JSON.stringify({
                success: true,
                transaction: "0xabc",
                network: "eip155:8453",
                extensions: {
                  "com.k1hub.settlement-status": {
                    version: 1,
                    settlementJobId: paymentId,
                    state: "confirmed",
                    confirmed: true,
                    finalized: false,
                  },
                },
              }),
            ).toString("base64"),
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchImplementation);

    const submitArgs = [
      "payment",
      "submit",
      "--attempt",
      record.attemptId,
      "--request-envelope",
      requestEnvelopePath,
      "--json",
    ];
    expect(await runCli(submitArgs, state.options)).toBe(0);
    const submitted = JSON.parse(state.stdout.at(-1)!);
    expect(submitted).toMatchObject({
      state: "settled",
      paymentId,
      paymentState: "confirmed",
      confirmed: true,
      finalized: false,
      fulfillmentPending: true,
      retryAfterSeconds: 2,
      transaction: "0xabc",
      network: "eip155:8453",
    });
    expect(JSON.stringify(submitted)).not.toContain(paidBody);

    expect(
      await runCli(
        ["payment", "status", "--attempt", record.attemptId, "--json"],
        state.options,
      ),
    ).toBe(0);
    expect(JSON.parse(state.stdout.at(-1)!)).toMatchObject({
      state: "settled",
      paymentId,
      paymentState: "confirmed",
      confirmed: true,
      finalized: false,
      transaction: "0xabc",
      network: "eip155:8453",
    });

    expect(await runCli(submitArgs, state.options)).toBe(42);
    expect(JSON.parse(state.stdout.at(-1)!)).toMatchObject({
      error: {
        code: "attempt_ambiguous",
        details: { action: "reconcile_existing_attempt" },
      },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();

    expect(
      await runCli(
        [
          "payment",
          "reconcile",
          "--attempt",
          record.attemptId,
          "--request-envelope",
          requestEnvelopePath,
          "--json",
        ],
        state.options,
      ),
    ).toBe(0);
    expect(seenSignatures).toEqual([
      artifact.paymentSignature,
      artifact.paymentSignature,
    ]);
  });
});
