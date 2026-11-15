// BOS-1388: posts, comments and votes count only after the visitor clicks an emailed link.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { feedbackCustomers, feedbackNotes, portalConfirmedAddresses } from "../src/db/schema.js";
import type { PortalLimits } from "../src/portal.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const PORTAL_URL = "https://feedback.example.com/";

type Mail = { to: string; subject: string; text: string };

/** A portal with "Confirm posts by email" on and a fake outgoing mailer that keeps what it was asked to send. */
async function setup(limits: Partial<PortalLimits> = {}) {
  t = await makeApp({ portalUrl: PORTAL_URL, portalLimits: limits });
  const sent: Mail[] = [];
  let configured = false;
  t.mailer.isConfigured = async () => configured;
  t.mailer.send = async (m) => {
    sent.push(m);
  };
  const { cookie } = await signIn(t);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const feature = (await req("POST", `/api/companies/${company.id}/features`, { title: "Dark mode", portalVisible: true, status: "considering", publicSummary: "A dark theme." })).json();
  const { portalToken } = (await req("PATCH", `/api/companies/${company.id}/portal`, { enabled: true })).json();
  return { req, company, feature, portalToken, sent, setConfigured: (v: boolean) => (configured = v) };
}

/** A browser: the portal token header plus whatever cookies the portal hands out. */
function browser(portalToken: string) {
  const jar = new Map<string, string>();
  return {
    jar,
    async call(method: "GET" | "POST", url: string, payload?: unknown, ip = "203.0.113.7") {
      const res = await t!.app.inject({ method, url, remoteAddress: ip, headers: { "x-portal-token": portalToken, cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") }, ...(payload !== undefined ? { payload: payload as object } : {}) });
      for (const c of res.cookies) jar.set(c.name, c.value);
      return res;
    },
  };
}

const tokenIn = (m: Mail) => /confirm\.html#([A-Za-z0-9_-]{43})/.exec(m.text)![1]!;
const demand = async (c: Awaited<ReturnType<typeof setup>>) => ((await c.req("GET", `/api/companies/${c.company.id}/features`)).json().features[0] as { demand: number; insightCount: number });

describe("confirm posts by email (BOS-1388)", () => {
  it("can't be switched on until outgoing email is set up, and is off by default", async () => {
    const c = await setup();
    const before = (await c.req("GET", `/api/companies/${c.company.id}/feedback-settings`)).json();
    expect(before).toMatchObject({ confirmByEmail: false, confirmLinkHours: 24, rememberAddressDays: 90, emailReady: false });
    const refused = await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { confirmByEmail: true });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().message).toMatch(/outgoing email/i);
    c.setConfigured(true);
    expect((await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { confirmByEmail: true, confirmLinkHours: 2, rememberAddressDays: 30 })).json()).toMatchObject({ confirmByEmail: true, confirmLinkHours: 2, rememberAddressDays: 30 });
  });

  it("with it off, posting works as before and asks for no email", async () => {
    const c = await setup();
    const v = browser(c.portalToken);
    expect((await v.call("POST", "/api/portal/votes", { featureId: c.feature.id, importance: "important" })).statusCode).toBe(200);
    expect(c.sent).toHaveLength(0);
    expect((await demand(c)).insightCount).toBe(1);
  });

  it("asks for an email, saves the vote hidden and mails a single-use link", async () => {
    const c = await setup();
    c.setConfigured(true);
    await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { confirmByEmail: true });
    const v = browser(c.portalToken);
    expect((await v.call("GET", "/api/portal")).json()).toMatchObject({ confirmByEmail: true, rememberedEmail: null });

    const noEmail = await v.call("POST", "/api/portal/votes", { featureId: c.feature.id, importance: "critical" });
    expect(noEmail.statusCode).toBe(422);
    expect(c.sent).toHaveLength(0);

    const res = await v.call("POST", "/api/portal/votes", { featureId: c.feature.id, importance: "critical", email: "Visitor@Example.com" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ needsConfirm: true });
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0]!.to).toBe("Visitor@Example.com");
    expect(c.sent[0]!.text).toContain("https://feedback.example.com/confirm.html#");

    // Hidden from everyone: the owner's inbox and lists, scoring, and the visitor's own view of their vote.
    expect(await t!.db.select().from(feedbackNotes)).toHaveLength(1);
    expect((await c.req("GET", `/api/companies/${c.company.id}/feedback`)).json()).toEqual([]);
    expect((await c.req("GET", "/api/feedback/unprocessed")).json()).toEqual({});
    expect(await demand(c)).toMatchObject({ demand: 0, insightCount: 0 });
    expect((await v.call("GET", "/api/portal")).json().features[0].myVote).toBeNull();
    const [row] = await t!.db.select().from(feedbackNotes);
    expect(t!.db && (await c.req("GET", `/api/feedback/${row!.id}`)).statusCode).toBe(404);
    // Only the hash of the token is stored, never the token.
    expect(row!.confirmTokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.confirmTokenHash).not.toContain(tokenIn(c.sent[0]!));
    // No customer exists yet either.
    expect(await t!.db.select().from(feedbackCustomers)).toHaveLength(0);
  });

  it("counts the vote once the link is clicked, sets a safe cookie, and the link works only once", async () => {
    const c = await setup();
    c.setConfigured(true);
    await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { confirmByEmail: true });
    const v = browser(c.portalToken);
    await v.call("POST", "/api/portal/votes", { featureId: c.feature.id, importance: "critical", name: "Vic", email: "vic@example.com" });
    const token = tokenIn(c.sent[0]!);

    const clicked = await t!.app.inject({ method: "POST", url: "/api/portal/confirm", remoteAddress: "198.51.100.9", payload: { token } });
    expect(clicked.statusCode).toBe(200);
    const cookie = clicked.cookies.find((x) => x.name === "bm_portal_confirmed")!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Strict", path: "/api/portal" });
    expect(cookie.maxAge).toBe(90 * 86_400);
    expect((await demand(c)).insightCount).toBe(1);
    const [row] = await t!.db.select().from(feedbackNotes);
    expect(row).toMatchObject({ confirmTokenHash: null, confirmEmail: null, confirmName: null });
    // The name and address become the customer only now.
    expect((await t!.db.select().from(feedbackCustomers))[0]).toMatchObject({ name: "Vic", email: "vic@example.com" });
    // The remembered-browser table holds hashes only.
    const [mine] = await t!.db.select().from(portalConfirmedAddresses);
    expect(JSON.stringify(mine)).not.toContain("vic@example.com");
    expect(cookie.value).not.toContain(mine!.secretHash);

    for (const again of [token, "A".repeat(43), "short", token.slice(0, 42) + (token.endsWith("A") ? "B" : "A")]) {
      const r = await t!.app.inject({ method: "POST", url: "/api/portal/confirm", payload: { token: again } });
      expect(r.statusCode).toBe(404);
      expect(r.json().message).toMatch(/already been used or has run out/);
    }
  });

  it("refuses an expired link, and deletes unconfirmed posts when they expire", async () => {
    const c = await setup();
    c.setConfigured(true);
    await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { confirmByEmail: true });
    const v = browser(c.portalToken);
    await v.call("POST", "/api/portal/ideas", { title: "Offline", text: "Work offline please", email: "idea@example.com" });
    const token = tokenIn(c.sent[0]!);
    await t!.db.update(feedbackNotes).set({ confirmExpiresAt: new Date(Date.now() - 1000) });
    expect((await t!.app.inject({ method: "POST", url: "/api/portal/confirm", payload: { token } })).statusCode).toBe(404);
    expect(await t!.db.select().from(feedbackNotes)).toHaveLength(1);
    expect(await t!.feedback.purgeUnconfirmed()).toMatchObject({ notes: 1 });
    expect(await t!.db.select().from(feedbackNotes)).toHaveLength(0);
  });

  it("lets a confirmed browser post straight away, but not with another address or a forged cookie", async () => {
    // The per-address email cap would stop the later posts here; it has its own test below.
    const c = await setup({ confirmEmailsPerEmailPerHour: 50 });
    c.setConfigured(true);
    await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { confirmByEmail: true });
    const v = browser(c.portalToken);
    await v.call("POST", "/api/portal/ideas", { title: "First", text: "First idea", email: "me@example.com" });
    const first = await t!.app.inject({ method: "POST", url: "/api/portal/confirm", payload: { token: tokenIn(c.sent[0]!) } });
    v.jar.set("bm_portal_confirmed", first.cookies.find((x) => x.name === "bm_portal_confirmed")!.value);
    expect((await v.call("GET", "/api/portal")).json().rememberedEmail).toBe("me@example.com");

    // Same address, same browser: counted at once, nothing mailed.
    const res = await v.call("POST", "/api/portal/ideas", { title: "Second", text: "Second idea", email: "ME@example.com" });
    expect(res.json()).toEqual({ ok: true });
    expect(c.sent).toHaveLength(1);
    expect(await t!.db.select().from(feedbackNotes).where(eq(feedbackNotes.title, "Portal idea: Second"))).toMatchObject([{ confirmTokenHash: null }]);

    // Another address needs its own confirmation.
    await v.call("POST", "/api/portal/ideas", { title: "Third", text: "Third idea", email: "other@example.com" });
    expect(c.sent).toHaveLength(2);

    // Forged cookies: a guessed secret, an edited secret, and one for an address that was never confirmed.
    const good = v.jar.get("bm_portal_confirmed")!;
    const [addr, secret] = good.split(".") as [string, string];
    const forged = [`${addr}.${"A".repeat(43)}`, `${addr}.${secret.slice(0, 42)}${secret.endsWith("A") ? "B" : "A"}`, `${Buffer.from("victim@example.com").toString("base64url")}.${secret}`];
    for (const [i, f] of forged.entries()) {
      const stranger = browser(c.portalToken);
      stranger.jar.set("bm_portal_confirmed", f);
      const email = i === 2 ? "victim@example.com" : "me@example.com";
      const before = c.sent.length;
      await stranger.call("POST", "/api/portal/ideas", { title: `Forged ${i}`, text: "Try to skip it", email });
      expect(c.sent.length).toBe(before + 1);
      expect((await t!.db.select().from(feedbackNotes).where(eq(feedbackNotes.title, `Portal idea: Forged ${i}`)))[0]!.confirmTokenHash).not.toBeNull();
    }
    // An expired remembered browser is no longer trusted.
    await t!.db.update(portalConfirmedAddresses).set({ expiresAt: new Date(Date.now() - 1000) });
    const before = c.sent.length;
    await v.call("POST", "/api/portal/ideas", { title: "Late", text: "After it ran out", email: "me@example.com" });
    expect(c.sent.length).toBe(before + 1);
  });

  it("caps confirmation emails per address and answers the same, so the form can't mail someone's inbox", async () => {
    const c = await setup();
    c.setConfigured(true);
    await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { confirmByEmail: true });
    // Different visitors and addresses, so only the per-address cap can be what stops it.
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      const v = browser(c.portalToken);
      const r = await v.call("POST", "/api/portal/votes", { featureId: c.feature.id, importance: "important", email: "victim@example.com" }, `203.0.113.${10 + i}`);
      results.push(r.statusCode);
      expect(r.json()).toMatchObject({ needsConfirm: true });
    }
    expect(results).toEqual([200, 200, 200, 200, 200]);
    expect(c.sent).toHaveLength(3);
    expect(await t!.db.select().from(feedbackNotes)).toHaveLength(3);
  });

  it("limits ideas per address per day", async () => {
    const c = await setup({ ideasPerEmailPerDay: 2, confirmEmailsPerEmailPerHour: 50 });
    c.setConfigured(true);
    await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { confirmByEmail: true });
    for (let i = 0; i < 4; i++) await browser(c.portalToken).call("POST", "/api/portal/ideas", { title: `Idea ${i}`, text: "x", email: "chatty@example.com" }, `203.0.113.${20 + i}`);
    expect(c.sent).toHaveLength(2);
  });

  it("refuses to take posts when email stopped working, instead of saving ones that can never be confirmed", async () => {
    const c = await setup();
    c.setConfigured(true);
    await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { confirmByEmail: true });
    c.setConfigured(false);
    const r = await browser(c.portalToken).call("POST", "/api/portal/votes", { featureId: c.feature.id, importance: "important", email: "a@example.com" });
    expect(r.statusCode).toBe(503);
    expect(await t!.db.select().from(feedbackNotes)).toHaveLength(0);
  });

  it("keeps the address out of what agents read, and an unconfirmed comment out of the agent inbox", async () => {
    const c = await setup();
    c.setConfigured(true);
    await c.req("PATCH", `/api/companies/${c.company.id}/portal`, { confirmByEmail: true });
    await browser(c.portalToken).call("POST", "/api/portal/votes", { featureId: c.feature.id, importance: "important", comment: "Please add it", email: "secret@example.com" });
    expect(await t!.feedback.untriaged(c.company.id)).toEqual([]);
    expect(JSON.stringify(await t!.feedback.notes(c.company.id))).not.toContain("secret@example.com");
    await t!.app.inject({ method: "POST", url: "/api/portal/confirm", payload: { token: tokenIn(c.sent[0]!) } });
    const inbox = await t!.feedback.untriaged(c.company.id);
    expect(inbox).toHaveLength(1);
    // Anonymous after confirming: the address is kept nowhere on the note.
    expect(JSON.stringify(inbox)).not.toContain("secret@example.com");
  });
});
