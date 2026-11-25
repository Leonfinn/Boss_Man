// BOS-1227 (941c), the skew rule, launcher side: a launcher one release newer than the server (or older, while the updater moves the
// server first) must keep every route and response key the previous release's server calls. The previous surface is the recorded
// fixture, replaced at each release. The server's own half is apps/server/test/launcher-skew.test.ts.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { launcher, launcherServer } from "../src/launcher.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, "fixtures/launcher-api-previous.json"), "utf8")) as { routes: { method: string; path: string; responseKeys?: string[] }[] };
const KEY = "k".repeat(43);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** The real launcher object with a docker that is never called for the two routes whose keys are checked; others get a stub. */
async function serve() {
  const real = launcher({ dataRoot: "/tmp/bm-skew-unused", network: "n", serverUrl: "ws://server:3100/api/runner/connect", memoryBytes: 1, pidsLimit: 1 }, {} as never);
  const stub = new Proxy(real, { get: (t, k) => (k === "netguard" || k === "cpu" ? Reflect.get(t, k) : async () => ({})) });
  const server = launcherServer(stub as typeof real, Buffer.from(KEY), () => undefined);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => new Promise((r) => server.close(() => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("the skew rule: launcher N serves what the previous server calls (BOS-1227)", () => {
  it("every recorded route exists (never 404 or 405) and checks the key first", async () => {
    const base = await serve();
    for (const r of fixture.routes) {
      const p = r.path.replace(":slug", "acme");
      const body = r.method === "PUT" && r.path === "/checks" ? { slots: 1 } : r.method === "PUT" && r.path === "/runners/:slug" ? { token: `bmr_${"x".repeat(43)}` } : r.method === "PUT" ? { allow: [] } : undefined;
      const res = await fetch(base + p, { method: r.method, headers: { authorization: `Bearer ${KEY}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
      expect([404, 405], `${r.method} ${r.path} answered ${res.status}`).not.toContain(res.status);
      expect((await fetch(base + p, { method: r.method })).status, `${r.method} ${r.path} without the key`).toBe(401);
    }
  });
  it("keeps every response key the previous server reads", async () => {
    const base = await serve();
    for (const r of fixture.routes.filter((x) => x.responseKeys)) {
      const j = (await (await fetch(base + r.path, { headers: { authorization: `Bearer ${KEY}` } })).json()) as Record<string, unknown>;
      expect(Object.keys(j), `${r.path}`).toEqual(expect.arrayContaining(r.responseKeys!));
    }
  });
});
