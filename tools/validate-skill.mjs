import { access, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const skill = resolve(process.argv[2] ?? "skills/x402api-pay");
const failures = [];
const source = await readFile(join(skill, "SKILL.md"), "utf8");
const lines = source.split(/\r?\n/);
if (lines.length > 500) failures.push("SKILL.md exceeds 500 lines");
if (/\bTODO\b|\[TODO/.test(source)) failures.push("SKILL.md contains TODO markers");
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(source)?.[1];
if (!frontmatter) failures.push("SKILL.md frontmatter is missing");
else {
  const keys = frontmatter
    .split("\n")
    .filter(Boolean)
    .map((line) => line.slice(0, line.indexOf(":")));
  if (keys.sort().join(",") !== "description,name") {
    failures.push("SKILL.md frontmatter must contain only name and description");
  }
  if (!frontmatter.includes("name: x402api-pay")) failures.push("skill name is invalid");
}
for (const match of source.matchAll(/\]\((references\/[^)]+)\)/g)) {
  await access(join(skill, match[1])).catch(() => failures.push(`missing reference: ${match[1]}`));
}
const files = await readdir(skill);
if (files.some((name) => /^readme\.md$/i.test(name))) failures.push("skill must not contain a README");
const metadata = await readFile(join(skill, "agents/openai.yaml"), "utf8");
for (const key of ["display_name", "short_description", "default_prompt"]) {
  if (!metadata.includes(`${key}:`)) failures.push(`agents/openai.yaml is missing ${key}`);
}
if (!metadata.includes("$x402api-pay")) failures.push("default prompt must mention $x402api-pay");
if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}
console.log("skill validation passed");
