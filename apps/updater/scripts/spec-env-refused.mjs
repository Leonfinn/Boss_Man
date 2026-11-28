// BOS-2921: checks a docker-compose.images.yml UPDATER_SPEC_ENV block against the updater's own refusal, with no Docker and no
// build of the updater. A second copy of the refused keys would drift, so the updater's real config parser is run on the block:
//   apps/updater/node_modules/.bin/tsx -e 'import("./src/config.ts").then(...)'   (run from apps/updater; loads TypeScript directly)
// The block is fed as UPDATER_SPEC_ENV, the way the compose file gives it, with the other required settings filled in.
// Run with no report prints "ok".
//
//   node apps/updater/scripts/spec-env-refused.mjs           # the compose file's block, the default path below
//   node apps/updater/scripts/spec-env-refused.mjs <compose> # another compose file, for a test's fixture
//
// Exits 0 when the updater accepts the block; exits 1 and prints the updater's refusal when it does not (its sentence names the
// key); exits 2 and prints why when the check itself cannot run (no tsx, no config.ts, no UPDATER_SPEC_ENV found): a check that
// cannot read the files must not go quiet.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const updater = path.resolve(here, "..");
const compose = path.resolve(process.argv[2] ?? path.join(updater, "..", "..", "docker-compose.images.yml"));
const configTs = path.join(updater, "src", "config.ts");
const tsx = path.join(updater, "node_modules", ".bin", "tsx");

/** @param {string} why */
function die(why) {
  console.error(`spec-env-refused: ${why}`);
  process.exit(2);
}

if (!existsSync(tsx)) die(`the updater's tsx runner is missing (${path.relative(process.cwd(), tsx)}); run pnpm install`);
if (!existsSync(configTs)) die(`the updater's config is missing (${path.relative(process.cwd(), configTs)})`);
if (!existsSync(compose)) die(`no compose file at ${compose}`);

// The UPDATER_SPEC_ENV value as Compose reads it: the lines under "UPDATER_SPEC_ENV: |" that are indented deeper than the key,
// each with the block's indentation removed (one blank indented line is kept as the blank line it is).
const lines = readFileSync(compose, "utf8").split("\n");
const at = lines.findIndex((l) => /^\s*UPDATER_SPEC_ENV:\s*[|>][-+]?\s*$/.test(l));
const keyLine = at < 0 ? "" : lines[at] ?? "";
if (!keyLine) die(`${path.relative(process.cwd(), compose)} has no "UPDATER_SPEC_ENV: |" block to check`);
const keyIndent = keyLine.search(/\S/);
const block = [];
let blockIndent = -1;
for (const l of lines.slice(at + 1)) {
  if (!l.trim()) {
    block.push("");
    continue;
  }
  const indent = l.search(/\S/);
  if (indent <= keyIndent) break;
  if (blockIndent < 0) blockIndent = indent;
  if (indent < blockIndent) break;
  block.push(l.slice(blockIndent));
}
while (block.length && block[block.length - 1] === "") block.pop();
const specEnv = block.join("\n");
if (!specEnv.trim()) die(`${path.relative(process.cwd(), compose)}'s UPDATER_SPEC_ENV block is empty`);

// The settings the updater needs before it reads the block, with values the parser accepts. None of them touches the block.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === "string")),
  UPDATER_REPO: "example/boss-man",
  UPDATER_REGISTRY: "ghcr.io/example",
  UPDATER_INSTALL_LABEL: "com.bossman.install=example",
  UPDATER_CURRENT_VERSION: "0.1.0",
  UPDATER_PACK_VOLUME: "example-pack",
  UPDATER_NETWORK: "example_default",
  UPDATER_NAME_PREFIX: "example-updater",
  // The block's own checks run only with the swap settings set, as on a real install.
  UPDATER_FRONT_NETWORK: "example_front",
  UPDATER_LAUNCHER_NETWORK: "example_launcher",
  UPDATER_DB_CONTAINER: "example-db",
  UPDATER_SELF_NETWORK: "example_self",
  UPDATER_SPEC_ENV: specEnv,
};
const script = `import("./src/config.ts").then((m) => {
  try { const c = m.loadConfig(JSON.parse(process.env.SPEC_ENV_CONFIG)); if (!c.swap) throw new Error("the updater read no colour spec"); console.log("ok"); }
  catch (e) { console.log(JSON.stringify({ refused: String(e && e.message || e) })); process.exit(1); }
});`;
const run = spawnSync(tsx, ["-e", script], {
  cwd: updater,
  env: { ...env, SPEC_ENV_CONFIG: JSON.stringify(env) },
  encoding: "utf8",
  timeout: 60_000,
});
if (run.error) die(`could not run the updater's config parser: ${run.error.message}`);
const out = (run.stdout ?? "").trim();
const err = (run.stderr ?? "").trim();
if (run.status === 0 && out === "ok") {
  console.log("ok");
  process.exit(0);
}
let refused = "";
try {
  refused = JSON.parse(out).refused;
} catch {
  refused = "";
}
if (run.status === 1 && refused) {
  console.log(`REFUSED ${refused}`);
  process.exit(1);
}
die(`the updater's config parser gave no clear answer (exit ${run.status}): ${(out + " " + err).replace(/\s+/g, " ").trim().slice(0, 400)}`);
