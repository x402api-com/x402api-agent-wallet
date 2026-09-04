import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const destination = await mkdtemp(join(tmpdir(), "x402api-pack-smoke-"));

try {
  const packages = [
    {
      path: join(root, "packages/agent-wallet-core"),
      required: [
        "dist/index.js",
        "dist/index.d.ts",
        "README.md",
        "package.json",
      ],
    },
    {
      path: join(root, "packages/agent-wallet-cli"),
      required: [
        "dist/bin.js",
        "dist/cli.js",
        "README.md",
        "package.json",
        "skill/SKILL.md",
        "skill/agents/openai.yaml",
        "skill/references/cli-reference.md",
        "skill/references/merchant-integration.md",
        "skill/references/safety.md",
      ],
    },
  ];
  const tarballs = [];
  for (const item of packages) {
    const result = JSON.parse(
      execFileSync(
        "npm",
        ["pack", item.path, "--pack-destination", destination, "--json"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            npm_config_cache: join(destination, "npm-cache"),
            npm_config_update_notifier: "false",
          },
        },
      ),
    )[0];
    const names = new Set(result.files.map((file) => file.path));
    for (const required of item.required) {
      if (!names.has(required))
        throw new Error(`${result.name} pack is missing ${required}`);
    }
    for (const name of names) {
      if (
        name.startsWith("src/") ||
        name.startsWith("tests/") ||
        /wallet|password/i.test(name)
      ) {
        if (
          !name.endsWith("agent-wallet-core") &&
          !name.endsWith("agent-wallet-cli")
        ) {
          throw new Error(
            `${result.name} pack contains unexpected path ${name}`,
          );
        }
      }
    }
    tarballs.push(join(destination, result.filename));
    console.log(
      `${result.name}@${result.version}: ${result.files.length} packed files`,
    );
  }

  const consumer = join(destination, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "x402api-pack-consumer", private: true, type: "module" })}\n`,
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      ...tarballs,
    ],
    {
      cwd: consumer,
      stdio: "pipe",
      env: { ...process.env, npm_config_update_notifier: "false" },
    },
  );
  const binary = join(consumer, "node_modules/.bin/x402api");
  const help = JSON.parse(
    execFileSync(binary, ["help", "--json"], {
      cwd: consumer,
      encoding: "utf8",
    }),
  );
  if (
    !help.commands.includes(
      "payment submit --attempt <id> --request-envelope <file>",
    )
  ) {
    throw new Error("installed CLI is missing sponsored payment submission");
  }
  if (help.commands.some((command) => command.includes("receipt"))) {
    throw new Error(
      "buyer CLI must not expose tenant-authenticated receipt commands",
    );
  }
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const wallet = await import("@x402api/agent-wallet-core"); if (typeof wallet.submitAuthorizedPayment !== "function" || typeof wallet.settlementEvidenceFromResponse !== "function" || wallet.SETTLEMENT_STATUS_EXTENSION !== "com.k1hub.settlement-status") process.exit(1);',
    ],
    { cwd: consumer, stdio: "pipe" },
  );
  const installedSkill = join(consumer, "installed-skills/x402api-pay");
  execFileSync(
    binary,
    ["skill", "install", "--output", installedSkill, "--json"],
    {
      cwd: consumer,
      stdio: "pipe",
    },
  );
  execFileSync(
    process.execPath,
    [join(root, "tools/validate-skill.mjs"), installedSkill],
    {
      cwd: root,
      stdio: "pipe",
    },
  );
  console.log("clean consumer install passed");
} finally {
  await rm(destination, { recursive: true, force: true });
}
