import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requested = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (requested === undefined || !/^v?\d+\.\d+\.\d+$/.test(requested)) {
  throw new Error("provide an exact release version such as v0.2.0");
}
const expected = requested.replace(/^v/, "");
const readPackage = async (path) =>
  JSON.parse(await readFile(join(root, path, "package.json"), "utf8"));
const workspace = await readPackage(".");
const core = await readPackage("packages/agent-wallet-core");
const cli = await readPackage("packages/agent-wallet-cli");
const lock = JSON.parse(
  await readFile(join(root, "package-lock.json"), "utf8"),
);

const versions = new Map([
  ["workspace", workspace.version],
  ["core", core.version],
  ["CLI", cli.version],
  ["lock workspace", lock.packages?.[""]?.version],
  ["lock core", lock.packages?.["packages/agent-wallet-core"]?.version],
  ["lock CLI", lock.packages?.["packages/agent-wallet-cli"]?.version],
  ["CLI core dependency", cli.dependencies?.["@x402api/agent-wallet-core"]],
  [
    "lock CLI core dependency",
    lock.packages?.["packages/agent-wallet-cli"]?.dependencies?.[
      "@x402api/agent-wallet-core"
    ],
  ],
]);
const mismatches = [...versions].filter(([, version]) => version !== expected);
if (mismatches.length > 0) {
  throw new Error(
    `release ${expected} does not match: ${mismatches
      .map(([label, version]) => `${label}=${String(version)}`)
      .join(", ")}`,
  );
}
console.log(`release version ${expected} is consistent`);
