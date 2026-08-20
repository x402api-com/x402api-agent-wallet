import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const failures = [];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) failures.push(`symbolic link is not allowed: ${relative(root, path)}`);
    else if (stat.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

const files = await walk(root);
const forbiddenNames = [
  /(?:^|\/)\.env(?:\.|$)/,
  /\.wallet\.json$/,
  /(?:^|\/)(?:password|passphrase|seed|private-key)(?:\.|$)/i,
  /(?:^|\/)payment-artifact(?:\.|$)/i,
];
for (const path of files) {
  const name = relative(root, path);
  if (forbiddenNames.some((pattern) => pattern.test(name))) {
    failures.push(`sensitive-looking file is not allowed: ${name}`);
  }
  if (/\.(?:ts|js|mjs|json|md|ya?ml)$/.test(name)) {
    const text = await readFile(path, "utf8");
    if (
      name.startsWith("packages/") &&
      /(?:from\s+["']@k1hub\/|require\(["']@k1hub\/)/.test(text)
    ) {
      failures.push(`private package import remains: ${name}`);
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) {
      failures.push(`private key material detected: ${name}`);
    }
  }
}

const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const corePackage = JSON.parse(
  await readFile(join(root, "packages/agent-wallet-core/package.json"), "utf8"),
);
const cliPackage = JSON.parse(
  await readFile(join(root, "packages/agent-wallet-cli/package.json"), "utf8"),
);
if (rootPackage.private !== true) failures.push("workspace root must remain private");
if (corePackage.name !== "@x402api/agent-wallet-core") failures.push("core package name changed");
if (cliPackage.name !== "@x402api/agent-wallet-cli") failures.push("CLI package name changed");
if (cliPackage.dependencies?.[corePackage.name] !== corePackage.version) {
  failures.push("CLI must pin the exact matching core version");
}

const expectedWireLiterals = [
  "com.k1hub.x402.base-usdc-eip3009-buyer-funded.v1",
  "com.k1hub.x402.solana-buyer-funded.v1",
  "com.k1hub.x402.tron-exact.v1",
  "com.k1hub.external-recipient",
];
const sourceText = (
  await Promise.all(
    files
      .filter((path) => path.includes("/packages/agent-wallet-core/src/"))
      .map((path) => readFile(path, "utf8")),
  )
).join("\n");
for (const literal of expectedWireLiterals) {
  if (!sourceText.includes(literal)) failures.push(`required deployed wire literal is missing: ${literal}`);
}
if (sourceText.includes("com.x402api.")) {
  failures.push("uncoordinated com.x402api wire literal detected");
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`repository validation passed (${files.length} files checked)`);
