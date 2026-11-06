import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
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
