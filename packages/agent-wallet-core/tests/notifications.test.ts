import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyMessage } from "ethers";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalJson,
  createSignedRefillNotification,
  createWallet,
  requestRefillNotification,
  unlockWallet,
  type JsonObject,
  type WalletBalance,
} from "../src/index.js";

const roots: string[] = [];
const password = "correct horse battery staple";

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("refill notification intents", () => {
  it("signs an expiring subscription-scoped request without email or display claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-notification-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const walletsDirectory = join(root, "wallets");
    const metadata = await createWallet({
      walletsDirectory,
      name: "buyer",
      network: "eip155:8453",
      passphrase: password,
    });
    const wallet = await unlockWallet(walletsDirectory, "buyer", password);
    const balance: WalletBalance = {
      version: 1,
      network: "eip155:8453",
      address: metadata.address,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      assetSymbol: "USDC",
      assetAtomic: "250000",
      nativeSymbol: "ETH",
      nativeAtomic: "1000000000000000",
      checkedAt: "2026-08-19T12:00:00.000Z",
    };
    const signed = await createSignedRefillNotification({
      wallet,
      balance,
      notificationUrl: "https://notify.x402api.example/v1/refills",
      subscriptionReference: "subscription_123",
      targetBalanceAtomic: "2000000",
      renewBy: "2026-08-25T12:00:00.000Z",
      reason: "renewal",
      now: Date.parse("2026-08-19T12:00:00.000Z"),
    });
    const message = `x402api-agent-wallet-refill-v1\n${canonicalJson(
      signed.intent as unknown as JsonObject,
    )}`;

    expect(verifyMessage(message, signed.signature.value)).toBe(metadata.address);
    expect(signed.signature.scheme).toBe("eip191");
    expect(signed.intent.balance).toMatchObject({
      currentAtomic: "250000",
      targetAtomic: "2000000",
      refillAtomic: "1750000",
    });
    expect(JSON.stringify(signed)).not.toMatch(/email|tenantName|productName|recipient/i);
  });

  it("rejects arbitrary audiences and non-future renewal deadlines", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-notification-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const walletsDirectory = join(root, "wallets");
    const metadata = await createWallet({
      walletsDirectory,
      name: "buyer",
      network: "eip155:8453",
      passphrase: password,
    });
    const wallet = await unlockWallet(walletsDirectory, "buyer", password);
    const balance: WalletBalance = {
      version: 1,
      network: "eip155:8453",
      address: metadata.address,
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      assetSymbol: "USDC",
      assetAtomic: "0",
      nativeSymbol: "ETH",
      nativeAtomic: "1",
      checkedAt: "2026-08-19T12:00:00.000Z",
    };
    await expect(
      createSignedRefillNotification({
        wallet,
        balance,
        notificationUrl: "https://user:secret@notify.x402api.example/v1/refills",
        subscriptionReference: "subscription_123",
        targetBalanceAtomic: "1",
        renewBy: "2026-08-18T12:00:00.000Z",
        reason: "low_balance",
        now: Date.parse("2026-08-19T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "notification_not_configured" });
  });

  it("posts a signed deficit and suppresses delivery when already funded", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-notification-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const walletsDirectory = join(root, "wallets");
    await createWallet({
      walletsDirectory,
      name: "buyer",
      network: "eip155:8453",
      passphrase: password,
    });
    const notificationBodies: unknown[] = [];
    let serverStatus: "accepted" | "not_required" = "accepted";
    const fetchMock = vi.fn(
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        if (url === "http://localhost:8545/") {
          const method = body.method;
          if (method === "eth_chainId") return jsonRpcResponse("0x2105");
          if (method === "eth_getBalance") return jsonRpcResponse("0x1");
          return jsonRpcResponse(`0x${"3d090".padStart(64, "0")}`);
        }
        notificationBodies.push(body);
        return new Response(
          JSON.stringify({ version: 1, notificationId: "notify_123", status: serverStatus }),
          { status: 202 },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const renewBy = new Date(Date.now() + 86_400_000).toISOString();
    const sent = await requestRefillNotification({
      walletsDirectory,
      wallet: "buyer",
      passphrase: password,
      rpc: { base: "http://localhost:8545/" },
      notificationUrl: "http://localhost:3000/v1/refills",
      subscriptionReference: "subscription_123",
      targetBalanceAtomic: "2000000",
      renewBy,
      reason: "renewal",
    });
    expect(sent).toMatchObject({
      status: "accepted",
      notificationId: "notify_123",
      currentBalanceAtomic: "250000",
      refillAmountAtomic: "1750000",
    });
    expect(notificationBodies).toHaveLength(1);
    expect(JSON.stringify(notificationBodies[0])).not.toMatch(/email|tenantName|productName/i);

    notificationBodies.length = 0;
    const skipped = await requestRefillNotification({
      walletsDirectory,
      wallet: "buyer",
      passphrase: password,
      rpc: { base: "http://localhost:8545/" },
      notificationUrl: "http://localhost:3000/v1/refills",
      subscriptionReference: "subscription_123",
      targetBalanceAtomic: "200000",
      renewBy,
      reason: "low_balance",
    });
    expect(skipped.status).toBe("not_required");
    expect(notificationBodies).toHaveLength(0);

    serverStatus = "not_required";
    const serverSuppressed = await requestRefillNotification({
      walletsDirectory,
      wallet: "buyer",
      passphrase: password,
      rpc: { base: "http://localhost:8545/" },
      notificationUrl: "http://localhost:3000/v1/refills",
      subscriptionReference: "subscription_123",
      targetBalanceAtomic: "3000000",
      renewBy,
      reason: "renewal",
    });
    expect(serverSuppressed).toMatchObject({
      status: "not_required",
      notificationId: "notify_123",
    });
    expect(notificationBodies).toHaveLength(1);
  });
});

function jsonRpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
}
