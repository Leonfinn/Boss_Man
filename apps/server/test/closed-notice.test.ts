import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { signedInOwner } from "./helpers/owner-session.js";
import { openPglite } from "../src/db/client.js";
import { companies, decisions } from "../src/db/schema.js";
import { ENGAGED_MS, leftBehind, liveNotice, markOwnerOpened, newerNotice, NOTICE_MS, reachedOwner, recentClosedNotices, switchedBackNotice, systemClosedNotice } from "../src/services/closed-notice.js";

// BOS-739: an owner hand-apply card Boss Man closes by itself leaves a notice where it was.
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const LAYOUT = { srcDir: "/srv/bm/src", deployerDir: "/srv/bm/deployer", bluegreen: true, liveColour: "green" };

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  if (ctx?.dir) await rm(ctx.dir, { recursive: true, force: true });
  ctx = undefined;
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-closed-"));
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  await writeFile(path.join(dir, "outbox", "host.json"), JSON.stringify({ version: 1, name: "nas01", writtenAt: "2026-10-20T12:00:00Z", ownership: [], deployer: { scriptSha: "1".repeat(64), repoSha: "1".repeat(64) } }));
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, deployerDir: dir });
  const cookie = await signedInOwner(db);
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  await req("POST", "/api/companies", { name: "App Co" });
  let stamp = Date.now() / 1000;
  const outbox = async (name: string, body: unknown) => {
    const file = path.join(dir, "outbox", name);
    await writeFile(file, JSON.stringify(body));
    stamp += 1;
    await utimes(file, stamp, stamp);
  };
  const available = (over: Record<string, unknown> = {}) =>
    outbox("available.json", { version: 1, checkedAt: "2026-10-20T12:00:00Z", deployed: A, tip: B, commits: [{ sha: B, subject: "Add rate limiting" }], paths: ["docker-compose.yml"], infraPaths: ["docker-compose.yml"], runnerChanged: false, ...over });
  const status = (over: Record<string, unknown>) =>
    outbox("status.json", { id: "", target: "server", result: "deployed", message: "Deployed.", from_commit: A, to_commit: B, started: "2026-10-20T12:01:00Z", ended: "2026-10-20T12:03:00Z", backup: "", ...over });
  const [co] = await db.select().from(companies);
  const row = async (id: string) => (await db.select().from(decisions).where(eq(decisions.id, id)))[0]!;
  return { ...built, db, close, dir, req, available, status, co: co!, row };
}

describe("closed notice text (BOS-739)", () => {
  it("says the update is live, you can stop, and names the backup file the host's own step wrote", () => {
    const steps = ['Run: x | gzip > db-backup-before-restart.sql.gz) && gzip -t "/srv/bm/src/db-backup-before-restart.sql.gz" && ls -l "/srv/bm/src/db-backup-before-restart.sql.gz"'];
    const n = liveNotice({ commit: B, liveAt: new Date("2026-11-08T13:47:44Z"), steps, now: new Date("2026-11-08T14:00:00Z") });
    expect(n.why).toBe("live");
    expect(n.commit).toBe(B);
    expect(n.text).toContain(`This update is already live (commit ${B.slice(0, 8)}, at 8 Nov, 13:47 UTC).`);
    expect(n.text).toContain("You don't need to finish these steps.");
    expect(n.text).toContain("Anything you already ran is safe.");
    expect(n.text).toContain("/srv/bm/src/db-backup-before-restart.sql.gz");
    expect(n.text).toContain("doesn't need undoing");
    expect(n.text).toContain("nothing left to press");
    // The notice stays for at least an hour.
    expect(Date.parse(n.until) - Date.parse(n.at)).toBe(NOTICE_MS);
    expect(NOTICE_MS).toBeGreaterThanOrEqual(3_600_000);
  });

  it("names the newer card to follow instead", () => {
    const n = newerNotice({ newerId: randomUUID(), label: "Main has moved to bbbbbbbb", steps: ["Apply it."], now: new Date() });
    expect(n.why).toBe("newer");
    expect(n.text).toContain('A newer update card covers this one: "Main has moved to bbbbbbbb".');
    expect(n.text).toContain("follow that card instead");
    expect(n.text).toContain("Nothing you ran needs undoing.");
  });

  it("reads no path when the card's steps never show one", () => {
    expect(leftBehind(["Apply it."])).toBe("Nothing you ran needs undoing.");
    expect(leftBehind(undefined)).toBe("Nothing you ran needs undoing.");
  });

  it("says a switched-back card's setup steps no longer apply, and nothing is left to press (BOS-740)", () => {
    const n = switchedBackNotice({ steps: ["Settings → Funding → Add account"], now: new Date("2026-11-08T14:00:00Z") });
    expect(n.why).toBe("switched-back");
    expect(n.text).toContain("switched back to an older version");
    expect(n.text).toContain("its setup steps no longer apply");
    expect(n.text).toContain("You can stop: there is nothing to finish.");
    expect(n.text).toContain("Nothing you ran needs undoing.");
    expect(n.text).toContain("nothing left to press");
    expect(Date.parse(n.until) - Date.parse(n.at)).toBe(NOTICE_MS);
  });
});

describe("leaveClosedNotice and the opened beacon (BOS-739)", () => {
  it("puts the notice on a closed card and tells the feed when the owner opened it recently", async () => {
    const c = (ctx = await setup());
    const todo = (await c.db.insert(decisions).values({ companyId: c.co.id, kind: "question", tier: "owner", question: "Apply the last update by hand", options: ["Done"], recommendedOption: "Done", context: { type: "owner_todo", ofDecisionId: randomUUID(), steps: ["Apply it."], target: "server", commit: C, fromCommit: A } as never }).returning())[0]!;
    // The owner opened its steps: recorded on the open card.
    const opened = await c.req("POST", `/api/decisions/${todo.id}/opened`, {});
    expect(opened.statusCode).toBe(200);
    expect(opened.json()).toEqual({ ok: true });
    expect((await c.row(todo.id)).context).toMatchObject({ ownerOpenedAt: expect.any(String) });
    // Boss Man closes it as live.
    await c.db.update(decisions).set({ status: "answered", answer: "Marked done.", answeredAt: new Date() }).where(eq(decisions.id, todo.id));
    const notice = liveNotice({ commit: C, liveAt: new Date(), steps: ["Apply it."], now: new Date() });
    const { leaveClosedNotice } = await import("../src/services/closed-notice.js");
    expect(await leaveClosedNotice(c.db, todo.id, notice, { notify: async () => undefined })).toBe(true);
    expect((await c.row(todo.id)).context).toMatchObject({ closedNotice: { why: "live" } });
  });

  it("lists only notices still showing, and skips an open or non-owner card", async () => {
    const c = (ctx = await setup());
    const now = new Date();
    const live = await c.db.insert(decisions).values({ companyId: c.co.id, kind: "approval", tier: "owner", question: "Live", options: ["Done"], recommendedOption: "Done", status: "answered", answeredAt: now, context: { type: "self_deploy", target: "server", commit: B, fromCommit: A, handSteps: ["a"], closedNotice: liveNotice({ commit: B, liveAt: now, steps: ["a"], now }) } as never }).returning();
    await c.db.insert(decisions).values({ companyId: c.co.id, kind: "approval", tier: "owner", question: "Old", options: ["Done"], recommendedOption: "Done", status: "answered", answeredAt: now, context: { type: "self_deploy", target: "server", commit: C, fromCommit: A, handSteps: ["a"], closedNotice: { ...liveNotice({ commit: C, liveAt: now, steps: ["a"], now }), until: new Date(now.getTime() - 1000).toISOString() } } as never }).returning();
    await c.db.insert(decisions).values({ companyId: c.co.id, kind: "approval", tier: "owner", question: "Open", options: ["Done"], recommendedOption: "Done", context: { type: "self_deploy", target: "server", commit: C, fromCommit: A, handSteps: ["a"] } as never }).returning();
    const shown = await recentClosedNotices(c.db);
    expect(shown.map((r) => r.id)).toEqual([live![0]!.id]);
  });

  it("shows the notice and its steps to the owner's Decisions page", async () => {
    const c = (ctx = await setup());
    const now = new Date();
    const [d] = await c.db.insert(decisions).values({ companyId: c.co.id, kind: "approval", tier: "owner", question: "Main has moved", options: ["Approve"], recommendedOption: "Approve", status: "answered", answeredAt: now, context: { type: "self_deploy", target: "server", commit: B, fromCommit: A, handSteps: ["Step one", "Step two"], closedNotice: liveNotice({ commit: B, liveAt: now, steps: ["Step one"], now }) } as never }).returning();
    const res = await c.req("GET", "/api/decisions/closed-notices");
    expect(res.statusCode).toBe(200);
    // The whole context comes back (a hand-apply card keeps its steps as handSteps), so the page has them to read.
    expect(res.json()).toMatchObject([{ id: d!.id, companyId: c.co.id, question: "Main has moved", context: { handSteps: ["Step one", "Step two"] }, notice: { why: "live", text: expect.stringContaining(B.slice(0, 8)) } }]);
  });

  it("does not record the opened beacon on a card that is already closed", async () => {
    const c = (ctx = await setup());
    const [d] = await c.db.insert(decisions).values({ companyId: c.co.id, kind: "approval", tier: "owner", question: "Closed", options: ["Done"], recommendedOption: "Done", status: "answered", answeredAt: new Date(), context: { type: "self_deploy", target: "server", commit: B, fromCommit: A, handSteps: ["a"] } as never }).returning();
    expect(await markOwnerOpened(c.db, d!.id)).toBe(false);
  });
});

describe("systemClosedNotice (BOS-1691)", () => {
  const now = new Date("2026-11-22T10:00:00Z");
  const staysForAnHour = (n: { at: string; until: string }) => expect(Date.parse(n.until) - Date.parse(n.at)).toBe(NOTICE_MS);

  it("says why Boss Man closed the card, trimming the trailing full stop and spaces the close recorded", () => {
    const n = systemClosedNotice({ note: "its ticket BOS-42 finished.  ", now });
    expect(n.why).toBe("closed");
    expect(n.newer).toBeUndefined();
    expect(n.text).toBe("Closed by Boss Man because its ticket BOS-42 finished. It needs nothing from you any more.");
    expect(n.at).toBe(now.toISOString());
    staysForAnHour(n);
  });

  it("points at the newer card, its author and its label", () => {
    const id = randomUUID();
    const n = systemClosedNotice({ note: "a newer card covers it", newer: { id, author: "Florence", label: "Run it again" }, now });
    expect(n.why).toBe("newer");
    expect(n.newer).toEqual({ decisionId: id, label: "Run it again" });
    expect(n.text).toBe('Replaced by a newer card from Florence: "Run it again". Answer that one instead; this one needs nothing from you.');
    staysForAnHour(n);
  });

  it("leaves the author out when the newer card has none, and still names its label", () => {
    const id = randomUUID();
    const n = systemClosedNotice({ note: "a newer card covers it", newer: { id, author: null, label: "Run it again" }, now });
    expect(n.newer).toEqual({ decisionId: id, label: "Run it again" });
    expect(n.text).toBe('Replaced by a newer card: "Run it again". Answer that one instead; this one needs nothing from you.');
  });

  it("calls it \"the newer card\" when no label was given", () => {
    const withAuthor = systemClosedNotice({ note: "a newer card covers it", newer: { id: randomUUID(), author: "Florence" }, now });
    expect(withAuthor.newer?.label).toBe("the newer card");
    expect(withAuthor.text).toBe("Replaced by a newer card from Florence. Answer that one instead; this one needs nothing from you.");
    const bare = systemClosedNotice({ note: "a newer card covers it", newer: { id: randomUUID(), author: null }, now });
    expect(bare.newer?.label).toBe("the newer card");
    expect(bare.text).toBe("Replaced by a newer card. Answer that one instead; this one needs nothing from you.");
  });
});

describe("reachedOwner (DR-058 A)", () => {
  it("reaches an owner card with no ladder, or with its ladder at the owner rung", () => {
    expect(reachedOwner({ tier: "owner", context: null })).toBe(true);
    expect(reachedOwner({ tier: "owner", context: {} })).toBe(true);
    expect(reachedOwner({ tier: "owner", context: { ladder: { rung: "owner" } } })).toBe(true);
  });

  it("does not reach an owner card still with the CEO or an agent in its handover", () => {
    expect(reachedOwner({ tier: "owner", context: { ladder: { rung: "ceo" } } })).toBe(false);
    expect(reachedOwner({ tier: "owner", context: { ladder: { rung: "author" } } })).toBe(false);
  });

  it("never reaches a card that is not owner-tier, whatever its ladder says", () => {
    expect(reachedOwner({ tier: "agent", context: null })).toBe(false);
    expect(reachedOwner({ tier: "agent", context: { ladder: { rung: "owner" } } })).toBe(false);
    expect(reachedOwner({ tier: null, context: { ladder: { rung: "owner" } } })).toBe(false);
  });
});

describe("self-deploy closes leave a notice (BOS-739)", () => {
  it("leaves a live notice where the open hand-apply card was when tip = deployed", async () => {
    const c = (ctx = await setup());
    // A hand-apply card is raised, then the host goes live on that commit by itself.
    await c.available({ ...LAYOUT });
    await c.selfDeploy.sync();
    const [card] = (await c.db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type: string }).type === "self_deploy");
    expect(card).toBeDefined();
    await c.available({ ...LAYOUT, deployed: B, tip: B });
    await c.selfDeploy.sync();
    const closed = await c.row(card!.id);
    expect(closed.status).toBe("withdrawn");
    const notice = (closed.context as { closedNotice?: { why: string; commit: string; text: string } }).closedNotice;
    expect(notice).toMatchObject({ why: "live", commit: B });
    expect(notice!.text).toContain("You don't need to finish these steps.");
    // And the owner's Decisions page can read it back.
    expect((await c.req("GET", "/api/decisions/closed-notices")).json()).toMatchObject([{ id: card!.id, notice: { why: "live" } }]);
  });

  it("leaves a newer-card notice where an older covered hand-apply to-do was", async () => {
    const c = (ctx = await setup());
    // An older hand-apply to-do, approved but not applied.
    const [old] = await c.db.insert(decisions).values({ companyId: c.co.id, kind: "question", tier: "owner", question: "Apply the last update by hand", options: ["Done"], recommendedOption: "Done", dedupeKey: `owner-todo:self-deploy:${C}`, context: { type: "owner_todo", ofDecisionId: randomUUID(), steps: ["Apply it."], target: "server", commit: C, fromCommit: A } as never }).returning();
    // Main moves again and the host offers the newer commit by hand.
    await c.available({ ...LAYOUT, tip: B });
    await c.selfDeploy.sync();
    const [newer] = (await c.db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type: string }).type === "self_deploy");
    expect(newer).toBeDefined();
    const closed = await c.row(old!.id);
    const notice = (closed.context as { closedNotice?: { why: string; newer?: { decisionId: string } } }).closedNotice;
    expect(notice).toMatchObject({ why: "newer", newer: { decisionId: newer!.id } });
    expect(NOTICE_MS).toBeGreaterThan(ENGAGED_MS);
  });

  it("leaves a live notice where the hand-apply to-do was when the host caught up by itself", async () => {
    const c = (ctx = await setup());
    await c.available({ ...LAYOUT });
    await c.selfDeploy.sync();
    const [card] = (await c.db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type: string }).type === "self_deploy");
    await c.req("POST", `/api/decisions/${card!.id}/answer`, { answer: "Approve" });
    const [todo] = (await c.db.select().from(decisions).where(eq(decisions.status, "open"))).filter((d) => (d.context as { type: string }).type === "owner_todo");
    expect(todo).toBeDefined();
    // The host caught up on its own: it reports the approved commit deployed.
    await c.status({ result: "deployed", to_commit: B, ended: "2026-10-20T12:03:00Z" });
    await c.available({ ...LAYOUT, deployed: B, tip: B });
    await c.selfDeploy.sync();
    const closed = await c.row(todo!.id);
    expect(closed.status).toBe("answered");
    const notice = (closed.context as { closedNotice?: { why: string; commit: string } }).closedNotice;
    expect(notice).toMatchObject({ why: "live", commit: B });
  });
});
