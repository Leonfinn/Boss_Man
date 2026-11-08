import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dockerClient } from "../src/docker.js";

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup) c();
  cleanup = [];
});

/** A Docker socket whose DELETE answers 409 "already in progress" until `goneAfter` inspects. */
function fakeSocket(opts: { deleteStatus: number; deleteMessage?: string; goneAfter?: number }) {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-dock-"));
  const sock = path.join(dir, "d.sock");
  const seen: string[] = [];
  let inspects = 0;
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const send = (st: number, b?: unknown) => {
      res.statusCode = st;
      res.end(b === undefined ? "" : JSON.stringify(b));
    };
    if (req.method === "POST") return send(204);
    if (req.method === "DELETE") return send(opts.deleteStatus, opts.deleteMessage ? { message: opts.deleteMessage } : undefined);
    inspects++;
    return opts.goneAfter !== undefined && inspects > opts.goneAfter ? send(404, { message: "no such container" }) : send(200, { Id: "x" });
  });
  server.listen(sock);
  cleanup.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { sock, seen };
}

describe("docker remove", () => {
  it("waits out a concurrent removal ('already in progress') and carries on", async () => {
    const f = fakeSocket({ deleteStatus: 409, deleteMessage: "removal of container ab23 is already in progress", goneAfter: 2 });
    await dockerClient(f.sock, { pollMs: 5, maxMs: 5000 }).remove("ab23");
    expect(f.seen.filter((l) => l.startsWith("GET")).length).toBe(3);
  });

  it("gives a plain message if the other removal never finishes", async () => {
    const f = fakeSocket({ deleteStatus: 409, deleteMessage: "removal of container ab23 is already in progress" });
    await expect(dockerClient(f.sock, { pollMs: 5, maxMs: 40 }).remove("ab23")).rejects.toThrow(/still removing the old container/);
  });

  it("still fails on other errors", async () => {
    const f = fakeSocket({ deleteStatus: 500, deleteMessage: "boom" });
    await expect(dockerClient(f.sock).remove("ab23")).rejects.toThrow("Removing the runner failed: boom");
  });
});

/** A Docker socket that answers every call with one status and message, and records the calls and bodies. */
function fixedSocket(status: number, message?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-dock-net-"));
  const sock = path.join(dir, "d.sock");
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${body}`);
      res.statusCode = status;
      res.end(message ? JSON.stringify({ message }) : "");
    });
  });
  server.listen(sock);
  cleanup.push(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { sock, seen };
}

describe("docker network hold calls (BOS-576)", () => {
  it("connects, disconnects and signals with the right calls", async () => {
    const ok = fixedSocket(200);
    const d = dockerClient(ok.sock);
    await d.disconnect("boss-man_default", "ab23");
    await d.connect("boss-man_default", "ab23");
    expect(ok.seen).toEqual(['POST /networks/boss-man_default/disconnect {"Container":"ab23","Force":false}', 'POST /networks/boss-man_default/connect {"Container":"ab23"}']);
    const killed = fixedSocket(204);
    await dockerClient(killed.sock).signal("g1", "USR1");
    expect(killed.seen).toEqual(["POST /containers/g1/kill?signal=USR1 "]);
  });

  it("treats 'already on it' and 'not on it' as done, and fails on anything else", async () => {
    await dockerClient(fixedSocket(403, "endpoint with name boss-man-runner-a already exists in network boss-man_default").sock).connect("boss-man_default", "a");
    await dockerClient(fixedSocket(500, "container a is not connected to network boss-man_default").sock).disconnect("boss-man_default", "a");
    await expect(dockerClient(fixedSocket(404, "network boss-man_default not found").sock).connect("boss-man_default", "a")).rejects.toThrow("Connecting the runner to its network failed: network boss-man_default not found");
    await expect(dockerClient(fixedSocket(500, "boom").sock).disconnect("boss-man_default", "a")).rejects.toThrow("Taking the runner off its network failed: boom");
    await expect(dockerClient(fixedSocket(409, "container g1 is not running").sock).signal("g1", "USR1")).rejects.toThrow("Signalling");
  });
});

/** A Docker socket whose /events answers the given lines, then holds the stream open until told to end it. */
function fakeEvents(lines: string[], status = 200) {
  const dir = mkdtempSync(path.join(tmpdir(), "bm-dock-ev-"));
  const sock = path.join(dir, "d.sock");
  const seen: string[] = [];
  let end: (() => void) | undefined;
  const server = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    res.statusCode = status;
    if (status !== 200) return res.end("no");
    for (const l of lines) res.write(`${l}\n`);
    end = () => res.end();
  });
  server.listen(sock);
  cleanup.push(() => {
    end?.();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { sock, seen, end: () => end?.() };
}

describe("docker events (BOS-335)", () => {
  it("asks for just the given filters, with a Unix-second since", async () => {
    const f = fakeEvents([]);
    const abort = new AbortController();
    const done = dockerClient(f.sock).events({ type: "container", action: ["start", "restart", "die"], label: "boss-man.launcher=1" }, 1_700_000_000, () => undefined, () => undefined, abort.signal);
    await new Promise((r) => setTimeout(r, 20));
    const filters = decodeURIComponent(f.seen[0]!);
    expect(filters).toContain("since=1700000000");
    expect(filters).toContain('"type":["container"]');
    expect(filters).toContain('"event":["start","restart","die"]');
    expect(filters).toContain('"label":["boss-man.launcher=1"]');
    abort.abort();
    await done;
  });

  it("reads newline-delimited events and skips a broken line", async () => {
    const f = fakeEvents(['{"Type":"container","Action":"restart"}', "not json", '{"Type":"container","Action":"start"}']);
    const abort = new AbortController();
    const got: string[] = [];
    const done = dockerClient(f.sock).events({ type: "container" }, 0, (e) => got.push(e.Action ?? "?"), () => undefined, abort.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual(["restart", "start"]);
    abort.abort();
    await done;
  });

  it("takes its abort listener off when the stream ends, so reconnects don't pile them up", async () => {
    const f = fakeEvents([]);
    const abort = new AbortController();
    const docker = dockerClient(f.sock);
    // Twelve reconnects on the one signal: if the listener stayed, Node would warn past ten.
    for (let i = 0; i < 12; i++) {
      const open = docker.events({ type: "container" }, 0, () => undefined, () => undefined, abort.signal);
      await new Promise((r) => setTimeout(r, 5));
      f.end();
      await open;
    }
    expect(getEventListeners(abort.signal, "abort").length).toBe(0);
  });

  it("reports a non-200 answer to onError and resolves", async () => {
    const f = fakeEvents([], 500);
    const abort = new AbortController();
    const errors: string[] = [];
    await dockerClient(f.sock).events({ type: "container" }, 0, () => undefined, (e) => errors.push(e.message), abort.signal);
    expect(errors.join(" ")).toContain("HTTP 500");
  });
});
