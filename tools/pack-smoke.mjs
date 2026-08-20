import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const destination = await mkdtemp(join(tmpdir(), "x402api-pack-smoke-"));

try {
  const packages = [
    {
      path: join(root, "packages/agent-wallet-core"),
      required: ["dist/index.js", "dist/index.d.ts", "README.md", "package.json"],
    },
    {
      path: join(root, "packages/agent-wallet-cli"),
      required: ["dist/bin.js", "dist/cli.js", "README.md", "package.json"],
    },
  ];
  for (const item of packages) {
    const result = JSON.parse(
      execFileSync("npm", ["pack", item.path, "--pack-destination", destination, "--json"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          npm_config_cache: join(destination, "npm-cache"),
          npm_config_update_notifier: "false",
        },
      }),
    )[0];
    const names = new Set(result.files.map((file) => file.path));
    for (const required of item.required) {
      if (!names.has(required)) throw new Error(`${result.name} pack is missing ${required}`);
    }
    for (const name of names) {
      if (name.startsWith("src/") || name.startsWith("tests/") || /wallet|password/i.test(name)) {
        if (!name.endsWith("agent-wallet-core") && !name.endsWith("agent-wallet-cli")) {
          throw new Error(`${result.name} pack contains unexpected path ${name}`);
        }
      }
    }
    console.log(`${result.name}@${result.version}: ${result.files.length} packed files`);
  }
} finally {
  await rm(destination, { recursive: true, force: true });
}
