// BOS-2921: checks a docker-compose.images.yml UPDATER_SPEC_ENV block against the updater's own refusal, with no Docker, no
// package install and no build. A second copy of the refused keys would drift, so the updater's real config parser
// (apps/updater/src/config.ts loadConfig) is run on the block, with Node's own TypeScript support (node --experimental-strip-types,
// Node 22.6 or later; CI's images job runs Node 22). Nothing outside Node runs it: GitHub's images job runs this test before any
// pnpm install, and there tsx is not installed (BOS-2921's own GitHub red). Node's TypeScript support loads only ".ts" files with
// erasable types, so config.ts only needs to be importable that way once its one relative type import names ".ts" (Node does not
// map ".js" to ".ts"); in a copy, never the repository's file.
// The block is fed as UPDATER_SPEC_ENV, the way the compose file gives it, with the other required settings filled in.
// Run with no report prints "ok".
//
//   node apps/updater/scripts/spec-env-refused.mjs           # the compose file's block, the default path below
//   node apps/updater/scripts/spec-env-refused.mjs <compose> # another compose file, for a test's fixture
//
// Exits 0 when the updater accepts the block; exits 1 and prints the updater's refusal when it does not (its sentence names the
// key); exits 2 and prints why when the check itself cannot run (no config.ts, no UPDATER_SPEC_ENV found, the copy broke):
// a check that cannot read the files must not go quiet.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const updater = path.resolve(here, "..");
const compose = path.resolve(process.argv[2] ?? path.join(updater, "..", "..", "docker-compose.images.yml"));
const srcDir = path.join(updater, "src");
const configTs = path.join(srcDir, "config.ts");

/** @param {string} why */
function die(why) {
  console.error(`spec-env-refused: ${why}`);
  process.exit(2);
}

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

// A copy of the updater's src folder holding the modules config.ts imports, each byte-for-byte as in the repository except that
// a relative import naming ".js" names ".ts" (Node's TypeScript support resolves the file on disk, not the build's names). If an
// import cannot be followed the check stops: it must never test a parser whose imports it silently dropped.
const copy = mkdtempSync(path.join(tmpdir(), "spec-env-refused-"));
process.on("exit", () => rmSync(copy, { recursive: true, force: true }));
/** @param {string} rel */
function copyModule(rel) {
  const src = path.join(srcDir, rel);
  if (!existsSync(src)) die(`config.ts imports ${rel}, which is missing from ${path.relative(process.cwd(), srcDir)}`);
  const text = readFileSync(src, "utf8");
  const imports = [...text.matchAll(/^import\s[^;]*?\sfrom\s+"([^"]+)";/gm)].map((m) => m[1]);
  const out = text.replace(/(^import\s[^;]*?\sfrom\s+")(\.{1,2}\/[^"]+)\.js(";)/gm, '$1$2.ts$3');
  for (const spec of imports) {
    if (!spec.startsWith(".")) continue;
    copyModule(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)).replace(/\.js$/, ".ts"));
  }
  writeFileSync(path.join(copy, rel), out);
}
copyModule("config.ts");

let module;
try {
  module = await import(path.join(copy, "config.ts"));
} catch (e) {
  die(`could not load the updater's config parser: ${String((e && e.message) || e)}`);
}
if (typeof module.loadConfig !== "function") die("config.ts exports no loadConfig");

// The settings the updater needs before it reads the block, with values the parser accepts. None of them touches the block.
const env = {
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
let config;
try {
  config = module.loadConfig(env);
} catch (e) {
  console.log(`REFUSED ${String((e && e.message) || e)}`);
  process.exit(1);
}
if (!config || !config.swap) die("the updater read no colour spec from the block");
console.log("ok");
