import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BASE_USDC_MAINNET_CONTRACT,
  readWalletBalance,
  SOLANA_MAINNET_GENESIS_HASH,
  SOLANA_USDC_MAINNET_MINT,
  TRON_MAINNET_GENESIS_BLOCK_ID,
  verifyTronMainnetRpc,
} from "../src/index.js";

function json(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("RPC network identity", () => {
  it("rejects a wrong Base asset before making an RPC request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      readWalletBalance({
        network: "eip155:8453",
        address: "0x1111111111111111111111111111111111111111",
        asset: `${BASE_USDC_MAINNET_CONTRACT.slice(0, -1)}4`,
        rpc: { base: "http://localhost:8545/" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_asset" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-Base EVM endpoint before reporting balances", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "eth_chainId") return json("0x1");
        return json("0x0");
      }),
    );
    await expect(
      readWalletBalance({
        network: "eip155:8453",
        address: "0x1111111111111111111111111111111111111111",
        rpc: { base: "http://localhost:8545/" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_network" });
  });

  it.each([
    ["zero", `0x${"0".repeat(64)}`, "0"],
    ["nonzero", `0x${"f4240".padStart(64, "0")}`, "1000000"],
  ])("decodes a %s Base USDC uint256 ABI word", async (_label, token, expected) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "eth_chainId") return json("0x2105");
        if (request.method === "eth_getBalance") return json("0x0");
        return json(token);
      }),
    );
    await expect(
      readWalletBalance({
        network: "eip155:8453",
        address: "0x1111111111111111111111111111111111111111",
        asset: BASE_USDC_MAINNET_CONTRACT,
        rpc: { base: "http://localhost:8545/" },
      }),
    ).resolves.toMatchObject({ assetAtomic: expected, nativeAtomic: "0" });
  });

  it("rejects a Base USDC result that is not one ABI uint256 word", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "eth_chainId") return json("0x2105");
        if (request.method === "eth_getBalance") return json("0x0");
        return json("0x0");
      }),
    );
    await expect(
      readWalletBalance({
        network: "eip155:8453",
        address: "0x1111111111111111111111111111111111111111",
        rpc: { base: "http://localhost:8545/" },
      }),
    ).rejects.toMatchObject({
      code: "rpc_unavailable",
      message: "USDC balance is not a canonical uint256 ABI word",
    });
  });

  it("reports zero for a new Solana wallet with no token account", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getGenesisHash") return json(SOLANA_MAINNET_GENESIS_HASH);
        if (request.method === "getBalance") return json({ value: 0 });
        return json({ value: [] });
      }),
    );
    await expect(
      readWalletBalance({
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        address: "11111111111111111111111111111111",
        asset: SOLANA_USDC_MAINNET_MINT,
        rpc: { solana: "http://localhost:8899/" },
      }),
    ).resolves.toMatchObject({
      asset: SOLANA_USDC_MAINNET_MINT,
      assetSymbol: "USDC",
      assetAtomic: "0",
      nativeSymbol: "SOL",
      nativeAtomic: "0",
    });
  });

  it("pins the full Solana Mainnet genesis hash", async () => {
    expect(SOLANA_MAINNET_GENESIS_HASH).toBe(
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as { method: string };
        if (request.method === "getGenesisHash") return json("testnet-genesis");
        if (request.method === "getBalance") return json({ value: 0 });
        return json({ value: [] });
      }),
    );
    await expect(
      readWalletBalance({
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        address: "11111111111111111111111111111111",
        rpc: { solana: "http://localhost:8899/" },
      }),
    ).rejects.toMatchObject({ code: "unsupported_network" });
  });

  it("accepts only the full TRON Mainnet block-0 identifier", async () => {
    const fetchMock = vi.fn(async (_input?: string | URL | Request) =>
      new Response(JSON.stringify({ blockID: TRON_MAINNET_GENESIS_BLOCK_ID }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(verifyTronMainnetRpc("http://localhost:8090/")).resolves.toBeUndefined();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "http://localhost:8090/wallet/getblockbynum",
    );

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ blockID: `00000000${"0".repeat(56)}` }), { status: 200 }),
    );
    await expect(verifyTronMainnetRpc("http://localhost:8090/")).rejects.toMatchObject({
      code: "unsupported_network",
    });
  });
});
