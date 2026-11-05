// Writes <agent dir>/npm/package.json from the `packages` of <agent dir>/settings.json, so that
// list is the only one (Renovate bumps it). Every entry must be `npm:<name>@<exact version>`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const agentDir = process.argv[2];
const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));

const dependencies = {};
for (const source of settings.packages ?? []) {
  const match = /^npm:((?:@[^/]+\/)?[^@]+)@(\d[^@]*)$/.exec(source);
  if (!match) throw new Error(`settings.json package without an exact npm version: ${source}`);
  dependencies[match[1]] = match[2];
}

mkdirSync(join(agentDir, "npm"), { recursive: true });
writeFileSync(
  join(agentDir, "npm", "package.json"),
  `${JSON.stringify({ name: "pi-extensions", private: true, dependencies }, null, 2)}\n`,
);
