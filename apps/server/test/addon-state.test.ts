import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions, notifications } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { addonsService, EDGE_FRESH_MS, unknownAddons, type AddonFacts, type AddonState } from "../src/services/addons.js";
import { checkAsk } from "../src/services/decisions.js";
import { DEFAULT_NOTIFY_SETTINGS, type NotifySettings } from "../src/services/notifications.js";
import { lintOwnerSteps, sh, step } from "../src/services/steps.js";

// Add-on state and card lint R9 (DR-023 ticket 1, BOS-521). The 5 Nov Stage 5 card asked the owner to log in
// over Tailscale and check a test push on their phone, though neither had ever been set up.

const TRIED = "Checked the host from the runner; agents have no access to the owner's machine.";
const facts = (s: Partial<Record<keyof AddonFacts, AddonState>>): AddonFacts => {
  const f = unknownAddons("test");
  for (const [k, v] of Object.entries(s)) f[k as keyof AddonFacts] = { state: v, since: null, source: `test says ${v}` };
  return f;
};
const r9 = (steps: string[], f: AddonFacts, setsUp?: keyof AddonFacts) => lintOwnerSteps(steps, { addons: f, setsUp });
const STAGE5 = ["On your phone, open https://bossman.tailnet.ts.net and log in.", "Check the test push arrived on your phone."];

describe("lintOwnerSteps R9", () => {
  it("refuses the Stage 5 card when Tailscale and ntfy were never set up", () => {
    const { refuse } = r9(STAGE5, facts({ tailscale: "not_set_up", ntfy: "not_set_up" }));
    expect(refuse.map((f) => `${f.step}:${f.rule}`)).toEqual(["1:R9", "2:R9"]);
    expect(refuse[0]!.problem).toMatch(/relies on Tailscale \("tailnet"\), which is not set up \(test says not_set_up\)\. Set Tailscale up first .*setsUp: "tailscale"/);
    expect(refuse[1]!.problem).toMatch(/relies on ntfy \("test push"\), which is not set up/);
  });

  it("refuses stopped and needs_login, warns on unknown, and passes running", () => {
    const s = ["Open Penpot and export the frame."];
    expect(r9(s, facts({ penpot: "stopped" })).refuse.map((f) => f.rule)).toEqual(["R9"]);
    expect(r9(s, facts({ penpot: "needs_login" })).refuse[0]!.problem).toMatch(/waiting for a login/);
    const unknown = r9(s, facts({ penpot: "unknown" }));
    expect(unknown.refuse).toEqual([]);
    expect(unknown.warn).toEqual([expect.objectContaining({ step: 1, rule: "warn", problem: expect.stringMatching(/can't confirm is running .*Don't tell the owner it carries over/) })]);
    const running = r9(s, facts({ penpot: "running" }));
    expect([...running.refuse, ...running.warn]).toEqual([]);
  });

  it("matches every word in the table, in sentences and in commands, and nothing else", () => {
    const off = facts({ tailscale: "not_set_up", ntfy: "not_set_up", penpot: "not_set_up" });
    for (const s of ["Run tailscale status.", "Open the ts.net address.", "Your tailnet admin page.", step("Check it:", sh("tailscale status"))]) expect(r9([s], off).refuse.map((f) => f.problem), s).toEqual([expect.stringMatching(/Tailscale/)]);
    for (const s of ["Open the ntfy app.", "Send a test push.", "Wait for the phone notification."]) expect(r9([s], off).refuse.map((f) => f.problem), s).toEqual([expect.stringMatching(/ntfy/)]);
    expect(r9(["Open PENPOT."], off).refuse).toHaveLength(1);
    // Words that only contain them aren't a match, and neither is a plain push or notification.
    expect(r9(["Push the button, then check notifications in Boss Man.", "Open the tailscaled folder."], off).refuse).toEqual([]);
  });

  it("exempts the add-on a card sets up, and only that one", () => {
    const off = facts({ tailscale: "not_set_up", ntfy: "not_set_up" });
    expect(r9(["Install Tailscale and log in to your tailnet."], off, "tailscale").refuse).toEqual([]);
    expect(r9(["Install Tailscale, then send a test push."], off, "tailscale").refuse.map((f) => f.problem)).toEqual([expect.stringMatching(/ntfy/)]);
  });

  it("is not checked when no facts are given", () => {
    expect(lintOwnerSteps(STAGE5)).toEqual({ refuse: [], warn: [] });
  });
});

describe("checkAsk with R9", () => {
  const off = facts({ tailscale: "not_set_up" });
  it("refuses an agent, and lets the CEO override with a reason", () => {
    expect(checkAsk({ triedFirst: TRIED, ownerMustDo: true, steps: STAGE5.slice(0, 1), addons: off }).error).toMatch(/Step 1: relies on Tailscale/);
    const over = checkAsk({ triedFirst: TRIED, ownerMustDo: true, steps: STAGE5.slice(0, 1), addons: off, byCeo: true, lintOverride: "The owner set it up an hour ago by hand." });
    expect(over.error).toBeNull();
    expect(over.lint?.override?.findings).toEqual([expect.objectContaining({ rule: "R9" })]);
    expect(checkAsk({ triedFirst: TRIED, ownerMustDo: true, steps: STAGE5.slice(0, 1), addons: off, setsUp: "tailscale" }).error).toBeNull();
  });
});

describe("addonsService", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function make(trustedProxies: string[], ntfy: NotifySettings["ntfy"]) {
    const o = await openPglite();
    close = o.close;
    let t = new Date("2026-11-05T12:00:00Z");
    const svc = addonsService(o.db, { trustedProxies, notifySettings: async () => ({ ...DEFAULT_NOTIFY_SETTINGS, ntfy }), now: () => t });
    return { db: o.db, svc, advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
  }
  const NTFY = { url: "https://ntfy.example", topic: "bm", tokenSecretId: null };

  it("reads not_set_up when there is no edge and no ntfy server; Penpot is unknown", async () => {
    const { svc } = await make([], null);
    svc.noteRequest("100.64.0.1");
    const f = await svc.facts();
    expect(f.tailscale).toMatchObject({ state: "not_set_up", since: null, source: expect.stringMatching(/BOSSMAN_TRUSTED_PROXIES/) });
    expect(f.ntfy).toMatchObject({ state: "not_set_up" });
    expect(f.penpot).toMatchObject({ state: "unknown", source: expect.stringMatching(/BOS-419/) });
  });

  it("reads Tailscale running from a request whose peer is the edge, and unknown before one or after a day", async () => {
    const { svc, advance } = await make(["10.0.0.5"], NTFY);
    expect((await svc.facts()).tailscale.state).toBe("unknown");
    svc.noteRequest("10.0.0.9"); // someone else
    svc.noteRequest(undefined);
    expect((await svc.facts()).tailscale.state).toBe("unknown");
    svc.noteRequest("::ffff:10.0.0.5"); // the edge, on a dual-stack socket
    expect((await svc.facts()).tailscale).toEqual({ state: "running", since: "2026-11-05T12:00:00.000Z", source: expect.stringMatching(/trusted edge/) });
    advance(EDGE_FRESH_MS);
    expect((await svc.facts()).tailscale).toMatchObject({ state: "unknown", since: "2026-11-05T12:00:00.000Z", source: expect.stringMatching(/over a day/) });
  });

  it("reads ntfy from the last push: none yet is unknown, sent is running, failed is stopped", async () => {
    const { db, svc } = await make([], NTFY);
    expect((await svc.facts()).ntfy).toMatchObject({ state: "unknown", source: expect.stringMatching(/no phone push/) });
    const row = { requested: "page", level: "page", title: "x", link: "#/decisions" } as const;
    await db.insert(notifications).values({ ...row, createdAt: new Date("2026-11-05T09:00:00Z") }); // never pushed: ignored
    await db.insert(notifications).values({ ...row, createdAt: new Date("2026-11-05T10:00:00Z"), pushedAt: new Date("2026-11-05T10:00:01Z") });
    expect((await svc.facts()).ntfy).toMatchObject({ state: "running", since: "2026-11-05T10:00:01.000Z" });
    await db.insert(notifications).values({ ...row, createdAt: new Date("2026-11-05T11:00:00Z"), pushError: "ntfy answered 401" });
    expect((await svc.facts()).ntfy).toEqual({ state: "stopped", since: "2026-11-05T11:00:00.000Z", source: "the last phone push failed", detail: "ntfy answered 401" });
  });
});

describe("raise_decision and server_status use the add-on state", () => {
  let ctx: Awaited<ReturnType<typeof setup>> | undefined;
  afterEach(async () => {
    for (const c of ctx?.clients ?? []) await c.close().catch(() => undefined);
    await ctx?.app.close();
    await ctx?.close();
    ctx = undefined;
  });

  async function setup() {
    const { db, close } = await openPglite();
    // No trusted proxies and no ntfy server: neither add-on is set up, as on 5 Nov.
    const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
    await built.app.listen({ host: "127.0.0.1", port: 0 });
    const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
    const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
    const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
    const { company, ceo } = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string }; ceo: { id: string } };
    const worker = (await built.app.inject({ method: "POST", url: `/api/companies/${company.id}/agents`, headers: { cookie }, payload: { name: "Engineer" } })).json() as { id: string };
    const clients: Client[] = [];
    const mcp = async (agentId: string) => {
      const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
      const c = new Client({ name: "t", version: "0" });
      await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      clients.push(c);
      return c;
    };
    return { ...built, db, close, ceo, worker, mcp, clients };
  }
  const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
  const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;
  const card = (steps: string[], extra: Record<string, unknown> = {}) => ({ question: "Move to the new host?", options: ["Done", "It failed"], recommended: "Done", triedFirst: TRIED, ownerMustDo: true, steps, ...extra });

  it("refuses the Stage 5 card, raises the setup card with setsUp, and shows the add-ons", async () => {
    const c = (ctx = await setup());
    const w = await c.mcp(c.worker.id);
    const refused = await w.callTool({ name: "raise_decision", arguments: card(STAGE5) });
    expect(isError(refused)).toBe(true);
    expect(textOf(refused)).toMatch(/Step 1: relies on Tailscale [\s\S]*Step 2: relies on ntfy/);
    expect(await c.db.select().from(decisions)).toHaveLength(0);

    const setupCard = await w.callTool({ name: "raise_decision", arguments: card(["Install Tailscale on the host and log in to your tailnet."], { question: "Set up Tailscale?", setsUp: "tailscale" }) });
    expect(isError(setupCard)).toBe(false);

    const ceo = await c.mcp(c.ceo.id);
    const view = JSON.parse(textOf(await ceo.callTool({ name: "server_status", arguments: {} }))) as { addons: AddonFacts };
    expect(view.addons).toMatchObject({ tailscale: { state: "not_set_up" }, ntfy: { state: "not_set_up" }, penpot: { state: "unknown" } });
  });
});
