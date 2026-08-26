import { access, lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

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

const documentationFiles = files.filter(
  (path) => path.endsWith(".md") || path.endsWith("/llms.txt"),
);
for (const path of documentationFiles) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/(?<!!)\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
    let target = match[1];
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
    const localTarget = target.split("#", 1)[0];
    if (!localTarget) continue;
    const destination = resolve(dirname(path), decodeURIComponent(localTarget));
    await access(destination).catch(() =>
      failures.push(
        `broken local documentation link: ${relative(root, path)} -> ${target}`,
      ),
    );
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

const llmsPath = join(root, "llms.txt");
const llms = await readFile(llmsPath, "utf8").catch(() => "");
if (!llms) failures.push("llms.txt is required");
else {
  if (!/^# [^\n]+\n\n> /u.test(llms)) {
    failures.push("llms.txt must start with an H1 and summary blockquote");
  }
  for (const required of [
    `Version ${rootPackage.version}`,
    "--maximum-payment-atomic",
    "sponsored Base USDC",
    "not hosted by or running inside WarpMetal",
    "## Start here",
  ]) {
    if (!llms.includes(required)) failures.push(`llms.txt is missing: ${required}`);
  }
}

const readme = await readFile(join(root, "README.md"), "utf8");
if (!readme.includes(`@x402api/agent-wallet-cli@${rootPackage.version}`)) {
  failures.push("README install command must pin the current CLI version");
}
const cliReference = await readFile(
  join(root, "skills/x402api-pay/references/cli-reference.md"),
  "utf8",
);
if (!cliReference.includes("payment_limit_exceeded")) {
  failures.push("CLI reference must document payment_limit_exceeded");
}

const expectedWireLiterals = [
  "com.k1hub.x402.base-usdc-eip3009-buyer-funded.v1",
  "com.k1hub.x402.solana-buyer-funded.v1",
  "com.k1hub.x402.tron-exact.v1",
  "com.k1hub.external-recipient",
  "com.x402api.gas-sponsorship",
  "com.x402api.x402.base-usdc-eip3009-sponsored.v1",
  "com.x402api.x402.solana-sponsored.v1",
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
const allowedX402apiWireLiterals = new Set(
  expectedWireLiterals.filter((literal) => literal.startsWith("com.x402api.")),
);
const observedX402apiWireLiterals = new Set(
  sourceText.match(/com\.x402api\.[a-z0-9.-]+/gi) ?? [],
);
for (const literal of observedX402apiWireLiterals) {
  if (!allowedX402apiWireLiterals.has(literal)) {
    failures.push(`uncoordinated com.x402api wire literal detected: ${literal}`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log(`repository validation passed (${files.length} files checked)`);
