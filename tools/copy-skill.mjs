import { cp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "skills/x402api-pay");
const destination = join(root, "packages/agent-wallet-cli/skill");

await rm(destination, { recursive: true, force: true });
await cp(source, destination, {
  recursive: true,
  errorOnExist: true,
  force: false,
});
