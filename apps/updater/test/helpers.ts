import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
import type { Raw, Transport } from "../src/docker.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The real, signed release.json and signature of v0.1.0-beta.1 (repository Leonfinn/Boss_Man, signed by release.yml on main). */
export const FIXTURE_DIR = path.join(here, "fixtures/beta1");
export const fixture = (name: "release.json" | "release.json.sigstore.json") => readFileSync(path.join(FIXTURE_DIR, name));
export const FIXTURE_REPO = "Leonfinn/Boss_Man";
export const FIXTURE_REGISTRY = "ghcr.io/leonfinn";

export const tmpDir = (prefix = "bm-updater-") => mkdtempSync(path.join(tmpdir(), prefix));

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({
    UPDATER_REPO: FIXTURE_REPO,
    UPDATER_REGISTRY: FIXTURE_REGISTRY,
    UPDATER_INSTALL_LABEL: "boss-man.install=test",
    UPDATER_CURRENT_VERSION: "0.0.9",
    UPDATER_PACK_VOLUME: "test-claude-pack",
    UPDATER_NETWORK: "test_default",
    UPDATER_NAME_PREFIX: "test-updater",
    UPDATER_STATE_DIR: tmpDir(),
    UPDATER_ARCH: "arm64",
    ...over,
  });
}

/** Serves files from memory on a local port, like GitHub's release downloads. `redirects` maps a path to another URL. */
export async function startFileServer(files: Record<string, Buffer | string>, redirects: Record<string, string> = {}) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? "");
    const r = redirects[req.url ?? ""];
    if (r) {
      res.writeHead(302, { location: r });
      return res.end();
    }
    const f = files[req.url ?? ""];
    if (f === undefined) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200);
    res.end(f);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export type Call = { method: string; path: string; body: unknown };

/** A recording Docker transport. `handler` answers; anything it does not handle is a 404. */
export function fakeTransport(handler: (c: Call) => Partial<Raw> | { json: unknown; status?: number } | undefined) {
  const calls: Call[] = [];
  const transport: Transport = async (method, p, body) => {
    const c = { method, path: p, body };
    calls.push(c);
    const r = handler(c);
    if (!r) return { status: 404, body: Buffer.from(JSON.stringify({ message: "no such thing" })) };
    if ("json" in r) return { status: r.status ?? 200, body: Buffer.from(JSON.stringify(r.json)) };
    return { status: r.status ?? 200, body: r.body ?? Buffer.alloc(0) };
  };
  return { calls, transport };
}

/** Docker's framed log output for one stdout line. */
export function framed(text: string): Buffer {
  const payload = Buffer.from(text);
  const head = Buffer.alloc(8);
  head[0] = 1;
  head.writeUInt32BE(payload.length, 4);
  return Buffer.concat([head, payload]);
}

export const sha = (c: string) => `sha256:${c.repeat(64)}`;
