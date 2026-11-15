// BOS-993: "Checks at once" reaches the runners with no host step. Saving a new number tells the launcher, and recreates the
// runners (the settings drain: each as its company goes idle, agents woken afterwards) only when one is on a different limit.
// The panel shows the limit in force and why it is lower than the setting.
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const KEY = "launcher-key-".padEnd(43, "x");
const GIB = 1024 ** 3;

/** A stand-in launcher: one runner, a plan it works out from `cap` (the most slots the host allows), and a recorded call order. */
function fakeLauncher() {
  const calls: string[] = [];
  // BOS-1498: `agents` is what the server last sent; `sized` turns on the agents formula (off: the old 13 GB base, as the tests
  // above expect); `old` makes it a launcher from before BOS-1498, which refuses any body but { slots }; `runnerBytes` overrides the runner's size.
  const st = { requested: null as number | null, cap: 8, runnerSlots: 1, current: false, agents: null as number | null, sized: false, old: false, runnerBytes: null as number | null, bodies: [] as unknown[] };
  const bytes = (slots: number) => (st.sized && st.agents !== null ? 2 + st.agents + 3 * slots : 13 + 3 * slots) * GIB;
  const plan = () => {
    const slots = st.requested === null ? 1 : Math.min(st.requested, st.cap);
    return { requested: st.requested, slots, memoryBytes: bytes(slots), reason: st.requested !== null && slots < st.requested ? `Not enough free memory for ${st.requested}.` : null, ...(st.old ? {} : { agents: st.agents, why: `${bytes(slots) / GIB} GB: ${st.agents} agents at once and ${slots} check.` }) };
  };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push(`${method} ${url.pathname}${method === "PUT" && url.pathname === "/checks" ? ` ${body.slots}` : ""}`);
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/runners") return json(200, [{ slug: "app-co", state: "running", status: "Up", image: "boss-man-runner:current", current: true }]);
    if (method === "GET" && url.pathname === "/checks") return json(200, { ...plan(), runners: [{ slug: "app-co", slots: st.runnerSlots, memoryBytes: st.runnerBytes ?? bytes(st.runnerSlots) }] });
    if (method === "PUT" && url.pathname === "/checks") {
      st.bodies.push(body);
      if (st.old && Object.keys(body).length !== 1) return json(400, { error: "Send { slots }." });
      st.requested = body.slots;
      if (body.agents !== undefined) st.agents = body.agents;
      return json(200, plan());
    }
    if (method === "PUT") return json(200, { slug: url.pathname.split("/")[2], id: "x" });
    if (method === "POST" && url.pathname === "/runners/app-co/recreate") return (st.runnerSlots = plan().slots), (st.runnerBytes = null), json(200, { slug: "app-co" });
    return json(404, { error: "unknown" });
  }) as typeof globalThis.fetch;
  return { fetch, calls, st };
}

async function setup() {
  const fake = fakeLauncher();
  const keyFile = path.join(mkdtempSync(path.join(tmpdir(), "bm-key-")), "key");
  writeFileSync(keyFile, `${KEY}\n`);
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, fetch: fake.fetch, launcher: { url: "http://launcher:3105", keyFile }, workspaceRoot: "/ws" } as never);
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "PUT" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  // Starting a company's runner sends PUT /runners/app-co then PUT /runners/app-co/allow; wait for the second, or a loaded
  // runner can land it after the clear below and it becomes calls[0] (BOS-1303).
  await vi.waitFor(() => expect(fake.calls).toContain("PUT /runners/app-co/allow"));
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json() as { runnerId: string };
  built.runners.connect(reg.runnerId, () => true, ["queued_checks"]);
  fake.calls.length = 0;
  return { ...built, db, close, req, fake };
}

describe("Checks at once reaches the runners (BOS-993)", () => {
  it("a changed number tells the launcher first, then recreates the out-of-date runner through the settings drain", async () => {
    const c = (ctx = await setup());
    const r = await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 2 });
    expect(r.json()).toMatchObject({ slots: 2, applying: true });
    expect(c.fake.calls[0]).toBe("PUT /checks 2");
    // The hold is the settings kind, so the panel says so and agents are woken when it ends.
    // The drain runs on a timer in production; one pass here swaps the idle company's runner.
    await c.maintenance.step();
    expect(c.fake.calls).toContain("POST /runners/app-co/recreate");
    // The recreate hook tells the launcher the number again, so a launcher that lost it still builds the runner right.
    const at = c.fake.calls.indexOf("POST /runners/app-co/recreate");
    expect(c.fake.calls.slice(0, at).filter((x) => x === "PUT /checks 2").length).toBeGreaterThanOrEqual(2);
  });

  it("an unchanged number, or runners already on the limit, start no restart", async () => {
    const c = (ctx = await setup());
    await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 1 }); // 1 is the default: nothing changed
    expect(c.fake.calls.filter((x) => x.startsWith("PUT /checks") || x.includes("recreate"))).toEqual([]);
    // A new number the runner already has (the host only allows 1): the launcher is told, nothing is restarted.
    c.fake.st.cap = 1;
    const r = await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 3 });
    expect(r.json()).toMatchObject({ slots: 3, applying: false });
    expect(c.fake.calls).toContain("PUT /checks 3");
    expect(c.fake.calls.some((x) => x.includes("recreate"))).toBe(false);
  });

  it("the panel's view carries the limit in force, why it is lower than the setting, and how many runners are still on the old one", async () => {
    const c = (ctx = await setup());
    c.fake.st.cap = 2;
    c.fake.st.requested = 4; // as if the launcher was already told
    await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 4 });
    const v = (await c.req("GET", "/api/settings/check-queue")).json() as { slots: number; runner: { slots: number; memoryBytes: number; reason: string | null; pending: number } };
    expect(v.slots).toBe(4);
    expect(v.runner).toMatchObject({ slots: 2, memoryBytes: 19 * GIB, reason: "Not enough free memory for 4." });
  });
});

describe("Agents at once sizes the runners (BOS-1498)", () => {
  it("a changed Agents at once tells the launcher both numbers and recreates a runner that would change; an unchanged one does nothing", async () => {
    const c = (ctx = await setup());
    c.fake.st.sized = true;
    c.fake.st.agents = 6; // the defaults: 4 in a company + 2 background
    c.fake.st.runnerBytes = 11 * GIB;
    // Same limits as the defaults: nothing is sent.
    await c.req("PUT", "/api/run-limits", { instance: 8, company: 4, background: 2 });
    expect(c.fake.st.bodies).toEqual([]);
    const r = await c.req("PUT", "/api/run-limits", { instance: 8, company: 2, background: 0 });
    expect(r.statusCode).toBe(200);
    expect(c.fake.st.bodies).toEqual([{ slots: 1, agents: 2 }]);
    expect((await c.req("GET", "/api/settings/check-queue")).json()).toMatchObject({ runner: { memoryBytes: 7 * GIB, pending: 1, memoryLine: "Has 11 GB now; from its next restart, 7 GB: 2 agents at once and 1 check." } });
    await c.maintenance.step();
    expect(c.fake.calls).toContain("POST /runners/app-co/recreate");
    expect((await c.req("GET", "/api/settings/check-queue")).json()).toMatchObject({ runner: { pending: 0, memoryLine: "7 GB: 2 agents at once and 1 check." } });
  });

  it("the wizard's runner view carries the same line", async () => {
    const c = (ctx = await setup());
    c.fake.st.sized = true;
    c.fake.st.agents = 3;
    const companyId = ((await c.req("GET", "/api/companies")).json() as { id: string }[])[0]!.id;
    expect((await c.req("GET", `/api/companies/${companyId}/runner`)).json()).toMatchObject({ memoryLine: "8 GB: 3 agents at once and 1 check." });
  });

  it("an older launcher that refuses the agents number still gets Checks at once", async () => {
    const c = (ctx = await setup());
    c.fake.st.old = true;
    const r = await c.req("PUT", "/api/settings/check-queue", { mode: "server", slots: 2 });
    expect(r.json()).toMatchObject({ slots: 2, applying: true });
    expect(c.fake.st.bodies).toEqual([{ slots: 2, agents: 6 }, { slots: 2 }]);
    expect(c.fake.st.requested).toBe(2);
  });
});
