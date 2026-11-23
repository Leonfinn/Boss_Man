// Design test 1: the instruction's refusals over real HTTP, and a whole move against a fake Docker and a local release host.
import { writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { dockerClient } from "../src/docker.js";
import { recover, runMove } from "../src/move.js";
import { createServer } from "../src/server.js";
import { stateStore } from "../src/state.js";
import type { VerifyFn } from "../src/verify.js";
import { fakeTransport, fixture, framed, sha, startFileServer, testConfig, tmpDir } from "./helpers.js";

const KEY = "k".repeat(40);
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

const D_SERVER = sha("7");
const HASH = "0123456789abcdef01234567";
const rel = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  version: "0.2.0",
  commit: "a".repeat(40),
  registries: ["ghcr.io/leonfinn"],
  images: ["boss-man-server", "boss-man-launcher", "boss-man-netguard", "boss-man-runner", "boss-man-updater"].map((name, i) => ({ name, digest: name === "boss-man-server" ? D_SERVER : sha(String(i)), platforms: { "linux/arm64": sha("2"), "linux/amd64": sha("1") } })),
  packHash: HASH,
  installLayout: 1,
  ...over,
});

async function setup(opts: { release?: object | null; verifyFn?: VerifyFn; docker?: Parameters<typeof fakeTransport>[0] } = {}) {
  const files: Record<string, Buffer | string> = {};
  if (opts.release !== null) {
    files["/Leonfinn/Boss_Man/releases/download/v0.2.0/release.json"] = JSON.stringify(opts.release ?? rel());
    files["/Leonfinn/Boss_Man/releases/download/v0.2.0/release.json.sigstore.json"] = fixture("release.json.sigstore.json");
  }
  const gh = await startFileServer(files);
  closers.push(gh.close);
  const cfg = testConfig({ UPDATER_GITHUB_BASE: gh.base, UPDATER_ALLOWED_HOSTS: "127.0.0.1" });
  const t = fakeTransport(
    opts.docker ??
      ((c) => {
        if (c.method === "POST" && c.path.startsWith("/images/create")) return { body: Buffer.from("{}\n") };
        if (c.method === "GET" && c.path.startsWith("/images/")) {
          const ref = decodeURIComponent(c.path.slice("/images/".length, -"/json".length));
          return { json: { Id: "sha256:i", Architecture: "arm64", RepoDigests: [ref] } };
        }
        if (c.method === "POST" && c.path.startsWith("/containers/create")) return { status: 201, json: { Id: "pk" } };
        if (c.path === "/containers/pk/start") return { status: 204 };
        if (c.method === "GET" && c.path === "/containers/pk/json") return { json: { Id: "pk", Config: { Labels: { "boss-man.install": "test" } }, State: { Running: false, ExitCode: 0 } } };
        if (c.path.startsWith("/containers/pk/logs")) return { body: framed(`[claude-pack] ready: /opt/bossman-claude/${HASH} (Claude Code 2.1.0)\n`) };
        if (c.method === "DELETE") return { status: 204 };
        return undefined;
      }),
  );
  const docker = dockerClient(t.transport, { installLabel: cfg.installLabel, volume: cfg.packVolume, network: cfg.network });
  const state = stateStore(cfg.stateDir);
  state.load();
  const deps = { cfg, docker, state, release: { verifyFn: opts.verifyFn ?? (async () => undefined) }, pull: { sleep: async () => undefined }, pack: { sleep: async () => undefined } };
  const u = createServer(deps, KEY);
  await new Promise<void>((r) => u.server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => u.server.close(() => r())));
  const port = (u.server.address() as AddressInfo).port;
  const call = (method: string, path: string, body?: string, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) =>
    new Promise<{ status: number; json: Record<string, unknown> | null }>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: res.statusCode ?? 0, json: text ? (JSON.parse(text) as Record<string, unknown>) : null });
        });
      });
      req.on("error", reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  return { call, u, cfg, docker, state, t, gh, deps };
}

const ins = (over: Record<string, unknown> = {}) => JSON.stringify({ version: "0.2.0", serverDigest: D_SERVER, ...over });

describe("who may ask, and what", () => {
  test("no key, a wrong key, or a key in another place: 401 before the body is read, on every path", async () => {
    const s = await setup();
    const wrongHeaders: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: KEY }, { "x-api-key": KEY }];
    for (const headers of wrongHeaders) {
      for (const [m, p] of [["POST", "/move"], ["GET", "/status"], ["POST", "/ack"], ["GET", "/nothing"]] as const) {
        expect((await s.call(m, p, m === "POST" ? ins() : undefined, headers)).status, `${m} ${p}`).toBe(401);
      }
    }
    expect(s.t.calls).toEqual([]);
    expect(s.gh.hits).toEqual([]);
  });

  test("other paths are 404 and other methods 405", async () => {
    const s = await setup();
    expect((await s.call("GET", "/")).status).toBe(404);
    expect((await s.call("GET", "/move/extra")).status).toBe(404);
    expect((await s.call("POST", "/status")).status).toBe(405);
    expect((await s.call("GET", "/move")).status).toBe(405);
    expect((await s.call("DELETE", "/move")).status).toBe(405);
    expect((await s.call("PUT", "/ack")).status).toBe(405);
    expect((await s.call("POST", "/move?image=evil", ins())).status).toBe(400);
  });

  test.each([
    ["not JSON", "version=1"],
    ["a body over 1 KB", JSON.stringify({ version: "0.2.0", serverDigest: D_SERVER, pad: "x".repeat(2000) })],
    ["an extra field", ins({ image: "evil" })],
    ["a bad version", ins({ version: "latest" })],
    ["a bad digest", ins({ serverDigest: "sha256:zz" })],
  ])("400 for %s, and nothing starts", async (_n, body) => {
    const s = await setup();
    expect((await s.call("POST", "/move", body)).status).toBe(400);
    expect(s.state.get().stage).toBe("idle");
    expect(s.gh.hits).toEqual([]);
  });

  test("/ack takes no body", async () => {
    const s = await setup();
    expect((await s.call("POST", "/ack", "{}")).status).toBe(400);
    expect((await s.call("POST", "/ack")).status).toBe(200);
  });
});

describe("a move", () => {
  test("verifies, pulls all five images, installs the pack, and stops at ready-to-swap with nothing swapped", async () => {
    const s = await setup();
    const r = await s.call("POST", "/move", ins());
    expect(r.status).toBe(202);
    await s.u.idle();
    const st = (await s.call("GET", "/status")).json!;
    expect(st["stage"]).toBe("ready-to-swap");
    expect(st["error"]).toBeNull();
    expect(JSON.stringify(st)).toMatch(/ready to switch to/);
    const pulls = s.t.calls.filter((c) => c.path.startsWith("/images/create")).map((c) => decodeURIComponent(c.path));
    expect(pulls).toHaveLength(5);
    expect(pulls.every((p) => p.startsWith("/images/create?fromImage=ghcr.io/leonfinn/boss-man-"))).toBe(true);
    // Everything came from the verified release.json: the request carried no reference, and 941a never swaps.
    expect(s.t.calls.some((c) => c.path.includes("/networks/") || c.path.includes("/rename") || c.path.includes("/kill"))).toBe(false);
  });

  test("a second move while one runs is 409 and shows the state", async () => {
    const s = await setup();
    s.state.update({ stage: "pulling" });
    const r = await s.call("POST", "/move", ins());
    expect(r.status).toBe(409);
    expect((r.json!["state"] as { stage: string }).stage).toBe("pulling");
  });

  test("a serverDigest that is not the release's server digest is refused: 'not a published digest'", async () => {
    const s = await setup();
    await s.call("POST", "/move", ins({ serverDigest: sha("e") }));
    await s.u.idle();
    const st = s.state.get();
    expect(st.stage).toBe("failed");
    expect(st.error?.code).toBe("not_published");
    expect(s.t.calls).toEqual([]);
  });

  test("an older or the same version is refused", async () => {
    const s = await setup();
    await s.call("POST", "/move", ins({ version: "0.0.8" }));
    await s.u.idle();
    expect(s.state.get().error?.code).toBe("downgrade");
    await s.call("POST", "/move", ins({ version: "0.0.9" }));
    await s.u.idle();
    expect(s.state.get().error?.code).toBe("already_current");
    expect(s.gh.hits).toEqual([]);
  });

  test("a refused signature stops the move before any image is pulled", async () => {
    const s = await setup({ verifyFn: async () => Promise.reject(Object.assign(new Error("x"), { code: "UNTRUSTED_SIGNER_ERROR" })) });
    await s.call("POST", "/move", ins());
    await s.u.idle();
    expect(s.state.get().error?.code).toBe("not_signed");
    expect(s.t.calls).toEqual([]);
  });

  test("a release missing an image (like beta.1, no updater) is refused with the name", async () => {
    const s = await setup({ release: rel({ images: (rel().images as unknown[]).slice(0, 4) }) });
    await s.call("POST", "/move", ins());
    await s.u.idle();
    expect(s.state.get().error?.code).toBe("incomplete_release");
    expect(s.state.get().error?.message).toMatch(/boss-man-updater/);
    expect(s.t.calls).toEqual([]);
  });

  test("a failed pack install leaves a plain reason, and a fresh move can then be started", async () => {
    const s = await setup({ release: rel({ packHash: "f".repeat(24) }) });
    await s.call("POST", "/move", ins());
    await s.u.idle();
    expect(s.state.get().stage).toBe("failed");
    expect(s.state.get().error?.code).toBe("pack_mismatch");
    expect(s.state.get().report?.acknowledged).toBe(false);
    expect((await s.call("POST", "/ack")).status).toBe(200);
    expect(s.state.get().report?.acknowledged).toBe(true);
    expect((await s.call("POST", "/move", ins())).status).toBe(202);
    await s.u.idle();
  });
});

describe("state and restart", () => {
  test("the state is written to the volume and read back after a restart", async () => {
    const dir = tmpDir();
    const a = stateStore(dir);
    a.begin("0.2.0", D_SERVER);
    a.update({ stage: "ready-to-swap" });
    const b = stateStore(dir);
    expect(b.load()).toMatchObject({ stage: "ready-to-swap", version: "0.2.0" });
  });

  test("a damaged state file is not trusted: idle", () => {
    const dir = tmpDir();
    stateStore(dir).update({ stage: "pulling" });
    writeFileSync(path.join(dir, "state.json"), '{"stage": "pulling", "ver');
    expect(stateStore(dir).load().stage).toBe("idle");
    writeFileSync(path.join(dir, "state.json"), '{"stage": "exploding"}');
    expect(stateStore(dir).load().stage).toBe("idle");
    expect(stateStore(tmpDir()).load().stage).toBe("idle");
  });

  test("a restart in the middle of a move removes the pack installer and records one plain reason", async () => {
    const s = await setup({ docker: (c) => (c.method === "GET" ? { json: { Id: "x", Config: { Labels: { "boss-man.install": "test" } }, State: { Running: true } } } : { status: 204 }) });
    s.state.begin("0.2.0", D_SERVER);
    s.state.update({ stage: "installing-pack" });
    await recover({ cfg: s.cfg, docker: s.docker, state: s.state });
    expect(s.state.get().stage).toBe("failed");
    expect(s.state.get().error?.code).toBe("interrupted");
    expect(s.t.calls.some((c) => c.method === "DELETE" && c.path.includes("test-updater-pack"))).toBe(true);
  });

  test("a restart when idle or ready does nothing", async () => {
    const s = await setup();
    s.state.update({ stage: "ready-to-swap" });
    await recover({ cfg: s.cfg, docker: s.docker, state: s.state });
    expect(s.state.get().stage).toBe("ready-to-swap");
    expect(s.t.calls).toEqual([]);
  });
});

test("runMove never throws: an unexpected error becomes a plain failure", async () => {
  const s = await setup();
  s.state.begin("0.2.0", D_SERVER);
  await runMove({ ...s.deps, cfg: { ...s.cfg, githubBase: "not a url" } }, { version: "0.2.0", serverDigest: D_SERVER });
  expect(s.state.get().stage).toBe("failed");
});
