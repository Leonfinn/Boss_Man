// The tools a check runs with, and a fingerprint of them (BOS-1570). The runner and the check worker both call this, so
// the two sides hash the same inputs the same way. A worker takes a company's checks when the fingerprints match: a
// runner update that leaves the tools alone changes nothing here, so workers keep working without the owner touching
// them. Versions are read from the installed binaries, not from build arguments, so what is compared is what runs.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { TOOLCHAIN_NOT_COMPARED, TOOLCHAIN_ONE_WAY, type Toolchain } from "@boss-man/shared";

type Exec = (cmd: string, args: string[]) => Promise<string>;
const exec: Exec = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => (err ? reject(err) : resolve(`${stdout}\n${stderr}`))));

/** The first dotted number in a tool's version output ("jq-1.6", "ShellCheck ... version: 0.9.0", "Docker version 29.9.3, build x"). */
export function firstVersion(output: string): string | null {
  return /\d+(?:\.\d+)+/.exec(output)?.[0] ?? null;
}

/** What to ask for each tool. A tool that isn't installed or doesn't answer is left out, which makes the fingerprint differ. */
const ASKS: Array<[name: string, cmd: string, args: string[]]> = [
  ["pnpm", "pnpm", ["--version"]],
  ["git", "git", ["--version"]],
  ["shellcheck", "shellcheck", ["--version"]],
  ["ripgrep", "rg", ["--version"]],
  ["jq", "jq", ["--version"]],
  ["docker-cli", "docker", ["--version"]],
  ["docker-compose", "docker", ["compose", "version"]],
  ["actionlint", "actionlint", ["-version"]],
  ["chromium", "chromium", ["--version"]],
  // BOS-1606: the web tests load the playwright module; a worker without it failed full checks on good code. Compared one
  // way (not in the fingerprint): the server keeps a worker without it idle when the runner has it, says "playwright
  // missing here", and lets a worker with an extra one work.
  ["playwright", "playwright", ["--version"]],
];

export function osRelease(read: () => string = () => readFileSync("/etc/os-release", "utf8")): string | null {
  try {
    const id = /^ID=(.*)$/m.exec(read())?.[1]?.replace(/"/g, "");
    const ver = /^VERSION_ID=(.*)$/m.exec(read())?.[1]?.replace(/"/g, "");
    return id && ver ? `${id}-${ver}` : null;
  } catch {
    return null;
  }
}

/** Hash of the compared tools, order-independent: "name=version" lines sorted, then sha256. */
export function fingerprintOf(tools: Record<string, string>): string {
  const lines = Object.entries(tools)
    .filter(([name]) => !(TOOLCHAIN_NOT_COMPARED as readonly string[]).includes(name) && !(TOOLCHAIN_ONE_WAY as readonly string[]).includes(name))
    .map(([name, v]) => `${name}=${v}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

export async function readToolchain(opts: { run?: Exec; nodeVersion?: string; os?: string | null } = {}): Promise<Toolchain> {
  const run = opts.run ?? exec;
  const tools: Record<string, string> = { node: (opts.nodeVersion ?? process.versions.node) };
  const os = opts.os === undefined ? osRelease() : opts.os;
  if (os) tools.os = os;
  await Promise.all(
    ASKS.map(async ([name, cmd, args]) => {
      try {
        const v = firstVersion(await run(cmd, args));
        if (v) tools[name] = v;
      } catch {
        /* not installed or not answering: left out */
      }
    }),
  );
  return { fingerprint: fingerprintOf(tools), tools };
}
