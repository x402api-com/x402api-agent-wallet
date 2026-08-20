import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AttemptStore } from "../src/index.js";

const roots: string[] = [];
const digest = (byte: string) => `sha256:${byte.repeat(64)}`;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable payment attempt store", () => {
  it("persists one artifact for a request and detects tampering", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-attempt-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const store = new AttemptStore(join(root, "attempts"));
    const artifactPath = join(root, "artifacts", "payment.json");
    const saved = await store.persistAuthorized({
      requestDigest: digest("1"),
      challengeDigest: digest("2"),
      selectedRequirementDigest: digest("3"),
      buyerPaymentIdentifier: "buyer_0123456789abcdef",
      wallet: "primary",
      network: "eip155:8453",
      payerAddress: "0x1111111111111111111111111111111111111111",
      paymentSignature: "signed-payload",
      artifactPath,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    expect(await store.findByRequestDigest(digest("1"))).toEqual(saved.record);
    expect((await store.readArtifact(saved.record.attemptId)).paymentSignature).toBe(
      "signed-payload",
    );
    await expect(
      store.persistAuthorized({
        requestDigest: digest("1"),
        challengeDigest: digest("2"),
        selectedRequirementDigest: digest("3"),
        buyerPaymentIdentifier: "buyer_fedcba9876543210",
        wallet: "primary",
        network: "eip155:8453",
        payerAddress: "0x1111111111111111111111111111111111111111",
        paymentSignature: "different-payload",
        artifactPath: join(root, "artifacts", "other.json"),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "attempt_already_exists" });

    const original = await readFile(artifactPath, "utf8");
    await writeFile(artifactPath, original.replace("signed-payload", "tampered-payload"), {
      mode: 0o600,
    });
    await expect(store.readArtifact(saved.record.attemptId)).rejects.toMatchObject({
      code: "payment_artifact_corrupt",
    });
  });

  it("tracks terminal state and active attempts independently", async () => {
    const root = await mkdtemp(join(tmpdir(), "x402api-attempt-test-"));
    await chmod(root, 0o700);
    roots.push(root);
    const store = new AttemptStore(join(root, "attempts"));
    const saved = await store.persistAuthorized({
      requestDigest: digest("a"),
      challengeDigest: digest("b"),
      selectedRequirementDigest: digest("c"),
      buyerPaymentIdentifier: "buyer_0123456789abcdef",
      wallet: "primary",
      network: "tron:mainnet",
      payerAddress: "TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV",
      paymentSignature: "signed-payload",
      artifactPath: join(root, "artifacts", "payment.json"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(await store.activeForWallet("primary")).toHaveLength(1);
    await store.updateState(saved.record.attemptId, "fulfilled");
    expect(await store.activeForWallet("primary")).toHaveLength(0);
  });
});
