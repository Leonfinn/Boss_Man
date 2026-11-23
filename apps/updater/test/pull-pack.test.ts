// Design tests 3 and 4: pull by digest (retries, read-back, mismatch deletes) and the pack install (aborts before any swap).
import { describe, expect, test } from "vitest";
import type { UpdaterError } from "../src/config.js";
import { dockerClient } from "../src/docker.js";
import { installPack, readyFolder } from "../src/pack.js";
import { pullByDigest } from "../src/pull.js";
import { fakeTransport, framed, sha, testConfig, type Call } from "./helpers.js";

const cfg = testConfig();
const opts = { installLabel: cfg.installLabel, volume: cfg.packVolume, network: cfg.network };
const REG = "ghcr.io/leonfinn";
const D = sha("a");
const REF = `${REG}/boss-man-server@${D}`;
const refuse = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as UpdaterError;
  }
  throw new Error("expected a refusal");
};
const noSleep = async () => undefined;

describe("pull by digest", () => {
  const pulled = (c: Call) => c.method === "POST" && c.path.startsWith("/images/create");
  const image = (over: Record<string, unknown> = {}) => ({ json: { Id: "sha256:img", Architecture: "arm64", RepoDigests: [REF], ...over } });

  test("pulls the exact reference, then reads the digest back", async () => {
    const { calls, transport } = fakeTransport((c) => (pulled(c) ? { body: Buffer.from('{"status":"ok"}\n') } : image()));
    await pullByDigest(dockerClient(transport, opts), REG, "boss-man-server", D, { arch: "arm64", sleep: noSleep });
    expect(calls.map((c) => `${c.method} ${decodeURIComponent(c.path)}`)).toEqual([`POST /images/create?fromImage=${REF}`, `GET /images/${REF}/json`]);
  });

  test("retries 5 times with delays, then says nothing was changed", async () => {
    const waits: number[] = [];
    const { calls, transport } = fakeTransport(() => ({ status: 500, json: { message: "registry busy" } }));
    const e = await refuse(pullByDigest(dockerClient(transport, opts), REG, "boss-man-server", D, { arch: "arm64", sleep: async (ms) => void waits.push(ms) }));
    expect(e.code).toBe("pull_failed");
    expect(e.message).toMatch(/Nothing was changed/);
    expect(calls.filter(pulled)).toHaveLength(5);
    expect(waits).toHaveLength(4);
    expect(waits).toEqual([...waits].sort((a, b) => a - b));
  });

  test("a pull that works on the third try is fine", async () => {
    let n = 0;
    const { transport } = fakeTransport((c) => (pulled(c) ? (++n < 3 ? { status: 500, json: { message: "busy" } } : { body: Buffer.from("{}\n") }) : image()));
    await pullByDigest(dockerClient(transport, opts), REG, "boss-man-server", D, { arch: "arm64", sleep: noSleep });
    expect(n).toBe(3);
  });

  test("an image the registry does not have is not retried", async () => {
    const { calls, transport } = fakeTransport(() => ({ status: 404, json: { message: "manifest unknown" } }));
    const e = await refuse(pullByDigest(dockerClient(transport, opts), REG, "boss-man-server", D, { arch: "arm64", sleep: noSleep }));
    expect(e.code).toBe("pull_failed");
    expect(calls.filter(pulled)).toHaveLength(1);
  });

  test("a digest that does not read back is deleted and the update stops", async () => {
    const { calls, transport } = fakeTransport((c) => (pulled(c) ? { body: Buffer.from("{}\n") } : c.method === "DELETE" ? { json: [] } : image({ RepoDigests: [`${REG}/boss-man-server@${sha("b")}`] })));
    const e = await refuse(pullByDigest(dockerClient(transport, opts), REG, "boss-man-server", D, { arch: "arm64", sleep: noSleep }));
    expect(e.code).toBe("digest_mismatch");
    expect(calls.some((c) => c.method === "DELETE" && decodeURIComponent(c.path) === "/images/sha256:img")).toBe(true);
  });

  test("an image built for another processor is deleted and refused", async () => {
    const { calls, transport } = fakeTransport((c) => (pulled(c) ? { body: Buffer.from("{}\n") } : c.method === "DELETE" ? { json: [] } : image({ Architecture: "amd64" })));
    const e = await refuse(pullByDigest(dockerClient(transport, opts), REG, "boss-man-server", D, { arch: "arm64", sleep: noSleep }));
    expect(e.code).toBe("digest_mismatch");
    expect(calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  test("a digest that is not sha256:64-hex never reaches Docker", async () => {
    const { calls, transport } = fakeTransport(() => undefined);
    expect((await refuse(pullByDigest(dockerClient(transport, opts), REG, "boss-man-server", "latest", { arch: "arm64" }))).code).toBe("bad_release");
    expect(calls).toEqual([]);
  });
});

describe("pack install", () => {
  const HASH = "0123456789abcdef01234567";
  const RUNNER = `${REG}/boss-man-runner@${sha("c")}`;
  const ours = (running: boolean, exit = 0) => ({ Id: "pk", Config: { Labels: { "boss-man.install": "test" } }, State: { Running: running, ExitCode: exit } });
  const isCreateOrAlias = (c: Call) => c.method === "POST" && (c.path.startsWith("/containers/create") || c.path.includes("/networks/") || c.path.includes("/rename"));

  /** A Docker where the installer container behaves as `how` says. */
  function docker(how: { exit?: number; running?: boolean; log?: string }) {
    const t = fakeTransport((c) => {
      if (c.method === "POST" && c.path.startsWith("/containers/create")) return { status: 201, json: { Id: "pk" } };
      if (c.method === "POST" && c.path === "/containers/pk/start") return { status: 204 };
      if (c.method === "GET" && c.path === "/containers/pk/json") return { json: ours(how.running ?? false, how.exit ?? 0) };
      if (c.method === "GET" && c.path.startsWith("/containers/pk/logs")) return { body: framed(how.log ?? `[claude-pack] ready: /opt/bossman-claude/${HASH} (Claude Code 2.1.0)\n`) };
      if (c.method === "DELETE") return { status: 204 };
      return undefined;
    });
    return { ...t, docker: dockerClient(t.transport, opts) };
  }
  const run = (d: ReturnType<typeof docker>, hash: string | null = HASH, timeoutMs = 1000) => installPack(d.docker, cfg, RUNNER, hash, { timeoutMs, sleep: async () => undefined, now: (() => { let t = 0; return () => (t += 600); })() });

  test("a ready pack with the signed hash passes; the container is created from the NEW runner digest and removed", async () => {
    const d = docker({});
    await run(d);
    const create = d.calls.find((c) => c.path.startsWith("/containers/create"))!;
    expect((create.body as { Image: string }).Image).toBe(RUNNER);
    expect(d.calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  test("the pack folder differs from the signed packHash: aborted, no other create or alias call", async () => {
    const d = docker({ log: `[claude-pack] ready: /opt/bossman-claude/${"f".repeat(24)} (Claude Code 2.1.0)\n` });
    const e = await refuse(run(d));
    expect(e.code).toBe("pack_mismatch");
    expect(e.message).toMatch(/nothing was changed/);
    expect(d.calls.filter(isCreateOrAlias)).toHaveLength(1); // only the installer's own create
  });

  test("the installer says nothing about being ready: aborted", async () => {
    expect((await refuse(run(docker({ log: "[claude-pack] the Claude pack couldn't be installed\n" })))).code).toBe("pack_not_ready");
  });

  test("a non-zero exit is aborted and the container is still removed", async () => {
    const d = docker({ exit: 1 });
    expect((await refuse(run(d))).code).toBe("pack_not_ready");
    expect(d.calls.at(-1)).toMatchObject({ method: "DELETE" });
  });

  test("a timeout is aborted with the container removed (force)", async () => {
    const d = docker({ running: true });
    expect((await refuse(run(d))).code).toBe("pack_timeout");
    expect(d.calls.at(-1)?.path).toBe("/containers/pk?force=1&v=1");
  });

  test("a release without a packHash is refused before Docker is touched", async () => {
    const d = docker({});
    expect((await refuse(run(d, null))).code).toBe("pack_unknown");
    expect(d.calls).toEqual([]);
  });

  test("readyFolder reads only the installer's own ready line", () => {
    expect(readyFolder(`x\n[claude-pack] ready: /opt/bossman-claude/${HASH} (Claude Code 2.1.0)\n`)).toBe(HASH);
    expect(readyFolder("ready: /opt/bossman-claude/etc")).toBeNull();
  });
});
