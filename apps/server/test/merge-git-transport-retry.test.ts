// BOS-1860: an approved merge whose push or fetch to the git host fails on the network retries once by itself; a second
// failure raises one merge card on the CEO's rung of the alert ladder; a real refusal (non-fast-forward, protected branch)
// is handled as before. The fake runner answers workspace.merge with git's own stderr.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { RunnerCommand } from "@boss-man/shared";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { createLeader } from "../src/leader.js";
import { activity, decisions, reviewRequests, tickets, wakes } from "../src/db/schema.js";
import { setInfraRetryBase } from "../src/services/review.js";
import { GIT_RETRY_CARD_NOTE, GIT_RETRY_NOTE } from "../src/services/git-transport-fault.js";

let ctx: { close: () => Promise<void> } | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const DIFF = { baseCommit: "a".repeat(40), head: "b".repeat(40), commits: [{ sha: "b".repeat(40), subject: "Work" }], files: [{ path: "src/a.ts", added: 1, removed: 0 }], diff: "diff --git a/x b/x", truncated: false };
const MIN = 60_000;
// The BOS-1844 text, as the runner sent it on 19 Nov (the URL shortened to the repo's host).
const BLIP = "Couldn't push the merge commit to bossman-ci/fc5ce221 for the git host's CI: fatal: unable to access 'https://github.com/example/repo.git/': Could not resolve host: github.com";
const FETCH_BLIP = "Command failed: git fetch --quiet origin\nerror: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502\nfatal: expected flush after ref listing";
const NON_FF = "Couldn't push the merge to main: To https://github.com/example/repo.git\n ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs to 'https://github.com/example/repo.git'";
const PROTECTED = "Couldn't push the merge to main: remote: error: GH006: Protected branch update failed for refs/heads/main.\nTo https://github.com/example/repo.git\n ! [remote rejected] main -> main (protected branch hook declined)";

async function setup() {
  setInfraRetryBase(1);
  const { db, close } = await openPglite();
  const lead = { on: true };
  const leader = { ...createLeader(), isLeader: () => lead.on };
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", leader });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  ctx = { close: async () => (await built.app.close(), await close()) };
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json();
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json();
  await req("PATCH", `/api/projects/${project.id}`, { repoUrl: "https://github.com/Leonfinn/customer-app.git" });
  const reg = (await req("POST", `/api/companies/${company.id}/runner`)).json();
  const sent: RunnerCommand[] = [];
  /** The runner's next answers to workspace.merge, taken in order: an error text fails that request; an empty list merges. */
  const mergeAnswers: Array<string | null> = [];
  /** Runs when the runner receives a merge request, before it answers (a hook for the "handed over while waiting" test). */
  const onMerge: { hook: (n: number) => void } = { hook: () => undefined };
  built.runners.connect(reg.runnerId, (c) => {
    sent.push(c);
    const requestId = (c as { requestId: string }).requestId;
    const reply = (r: { ok: boolean; data?: unknown; error?: string }) => queueMicrotask(() => built.runners.resolveReply({ requestId, ...r }));
    if (c.type === "workspace.diff") reply({ ok: true, data: DIFF });
    if (c.type === "workspace.carried") reply({ ok: true, data: { carried: [] } });
    if (c.type === "workspace.migrations") reply({ ok: true, data: { needed: false, reason: "none" } });
    if (c.type === "workspace.verify") reply({ ok: true, data: { ok: true, exitCode: 0, timedOut: false, output: "ok", ms: 1 } });
    if (c.type === "workspace.merge") {
      const n = sent.filter((x) => x.type === "workspace.merge").length;
      onMerge.hook(n);
      const err = mergeAnswers.shift() ?? null;
      reply(err ? { ok: false, error: err } : { ok: true, data: { status: "merged", commit: "c".repeat(40) } });
    }
    return true;
  }, ["carried-check"]);
  /** A ticket in review whose only review passed `agoMs` ago, with an agent's note on it. */
  const approved = async (agoMs = MIN) => {
    const t = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id })).json() as { id: string };
    await db.update(tickets).set({ branch: `bossman/${t.id}`, systemState: "review", stateNote: "1 pass; 2 pass. Approved, merging.", stateNoteAt: new Date() }).where(eq(tickets.id, t.id));
    await db.insert(reviewRequests).values({ ticketId: t.id, kind: "code", reviewerAgentId: worker.id, round: 1, seq: 0, status: "approved", decidedAt: new Date(Date.now() - agoMs) });
    return t;
  };
  const row = async (id: string) => (await db.select().from(tickets).where(eq(tickets.id, id)))[0]!;
  const merges = () => sent.filter((x) => x.type === "workspace.merge").length;
  const cards = async (ticketId: string) => (await db.select().from(decisions)).filter((d) => (d.context as { ticketId?: string }).ticketId === ticketId);
  const wakesFor = async (agentId: string) => (await db.select().from(wakes)).filter((w) => w.agentId === agentId);
  const failReasons = async (ticketId: string) =>
    (await db.select().from(activity)).filter((a) => a.ticketId === ticketId && (a.detail as { event?: string } | null)?.event === "attempt_failed").map((a) => (a.detail as { reason: string }).reason);
  const lines = async (ticketId: string) => (await db.select().from(activity)).filter((a) => a.ticketId === ticketId).map((a) => a.summary);
  return { db, built, lead, company, ceo, worker, approved, row, merges, mergeAnswers, onMerge, cards, wakesFor, failReasons, lines };
}

describe("a push or fetch that fails on the network retries once by itself (BOS-1860)", () => {
  it("day 1: one blip, then it merges: no card, nobody woken, no repeat alert, and the note flag is gone afterwards", async () => {
    const c = await setup();
    c.mergeAnswers.push(BLIP);
    const t = await c.approved();
    // Seen during the wait: the note says Boss Man is retrying.
    let flagged: string | null = null;
    c.onMerge.hook = (n) => {
      if (n === 2) void c.row(t.id).then((r) => (flagged = r.stateNoteStaleReason));
    };
    await c.built.review.landVisible(t.id, "the owner");
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    expect(c.merges()).toBe(2);
    await vi.waitFor(() => expect(flagged).toBe(GIT_RETRY_NOTE));
    expect(await c.cards(t.id)).toHaveLength(0);
    expect(await c.wakesFor(c.ceo.id)).toHaveLength(0);
    expect(await c.failReasons(t.id)).toEqual(["git_transport_retried"]);
    expect((await c.lines(t.id)).some((s) => /Retrying after a push\/fetch failure to the git host .*nothing to do/i.test(s))).toBe(true);
    // The "retrying" flag gave way to the merge's own line; the agent's note text is untouched.
    const after = await c.row(t.id);
    expect([GIT_RETRY_NOTE, GIT_RETRY_CARD_NOTE]).not.toContain(after.stateNoteStaleReason);
    expect(after.stateNote).toBe("1 pass; 2 pass. Approved, merging.");
  });

  it("three recovered blips in a row raise no 'Merges keep failing' alert", async () => {
    const c = await setup();
    for (let i = 0; i < 3; i++) {
      c.mergeAnswers.push(FETCH_BLIP);
      const t = await c.approved();
      await c.built.review.landVisible(t.id, "the owner");
      await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    }
    const alerts = (await c.db.select().from(decisions)).filter((d) => /keep failing/i.test(d.question));
    expect(alerts).toHaveLength(0);
  });

  it("a week on: an outage outlasting the retry ends in exactly one merge card, on the CEO's rung, not on the owner's queue; the sweep adds none", async () => {
    const c = await setup();
    c.mergeAnswers.push(BLIP, FETCH_BLIP);
    // Approved long enough ago that the unmerged-approvals sweep looks at it.
    const t = await c.approved(3 * 60 * MIN);
    await c.built.review.landVisible(t.id, "the owner").catch(() => undefined);
    await vi.waitFor(async () => expect(await c.cards(t.id)).toHaveLength(1));
    expect(c.merges()).toBe(2);
    const [card] = await c.cards(t.id);
    const ladder = (card!.context as { ladder?: { rung: string; minutes: number } }).ladder;
    expect(ladder?.rung).toBe("ceo");
    expect(ladder?.minutes).toBe(60);
    expect(card!.question).toMatch(/couldn't reach the git host twice/);
    // The owner's queue (their Decisions page) doesn't show it yet; the CEO's full list does.
    expect((await c.built.decisions.queue({ companyId: c.company.id })).map((d) => d.id)).not.toContain(card!.id);
    expect((await c.built.decisions.queue({ companyId: c.company.id, includeAll: true })).map((d) => d.id)).toContain(card!.id);
    expect((await c.wakesFor(c.ceo.id)).length).toBe(1);
    expect(await c.failReasons(t.id)).toEqual(["git_transport_retried", "git_transport"]);
    // The note says where it stands now, not "retrying".
    expect((await c.row(t.id)).stateNoteStaleReason).toBe(GIT_RETRY_CARD_NOTE);
    // No loop: the sweep skips a ticket with an open merge card, so there is still one card and no new merge.
    await c.built.sweeps.run();
    expect(await c.cards(t.id)).toHaveLength(1);
    expect(c.merges()).toBe(2);
  });

  it("a refused push (non-fast-forward, protected branch) is not retried: today's card at once, owner-visible as before", async () => {
    for (const refusal of [NON_FF, PROTECTED]) {
      const c = await setup();
      c.mergeAnswers.push(refusal);
      const t = await c.approved();
      await c.built.review.landVisible(t.id, "the owner").catch(() => undefined);
      await vi.waitFor(async () => expect(await c.cards(t.id)).toHaveLength(1));
      expect(c.merges()).toBe(1);
      const [card] = await c.cards(t.id);
      expect((card!.context as { ladder?: unknown }).ladder).toBeUndefined();
      expect(await c.failReasons(t.id)).toEqual(["gate_fault"]);
      expect((await c.row(t.id)).stateNoteStaleReason).toBeNull();
      await ctx?.close();
      ctx = undefined;
    }
  });

  it("handed over during the wait: the old copy sends no second merge and raises no card (the new copy resumes it)", async () => {
    const c = await setup();
    c.mergeAnswers.push(BLIP);
    // The copy loses charge as the first (failing) merge request goes out, so it is out of charge when the pause ends.
    c.onMerge.hook = (n) => {
      if (n === 1) c.lead.on = false;
    };
    const t = await c.approved();
    await c.built.review.landVisible(t.id, "the owner").catch(() => undefined);
    await vi.waitFor(async () => expect((await c.lines(t.id)).some((s) => /handed over|server now in charge/i.test(s ?? ""))).toBe(true));
    expect(c.merges()).toBe(1);
    expect(await c.cards(t.id)).toHaveLength(0);
    expect((await c.row(t.id)).systemState).toBe("review");
  });

  it("after a restart: the resume pass restarts the merge once (the retry isn't lost) and lands it", async () => {
    const c = await setup();
    const t = await c.approved(10 * MIN);
    // What a server that died mid-wait leaves behind: the flag, and an approved, unmerged ticket.
    await c.db.update(tickets).set({ stateNoteStaleAt: new Date(), stateNoteStaleReason: GIT_RETRY_NOTE }).where(eq(tickets.id, t.id));
    const promoted = new Date();
    expect(await c.built.sweeps.resumeMergesOnPromotion(promoted)).toEqual({ started: 1, waiting: 0 });
    // The next pass of the same promotion (main.ts asks every 10 s) starts nothing: the merge runs once.
    expect(await c.built.sweeps.resumeMergesOnPromotion(promoted)).toMatchObject({ started: 0 });
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    expect(c.merges()).toBe(1);
    expect((await c.row(t.id)).stateNoteStaleReason).not.toBe(GIT_RETRY_NOTE);
    expect(await c.cards(t.id)).toHaveLength(0);
  });

  it("after a restart: a ticket that left review while the server was down doesn't keep saying 'retrying'", async () => {
    const c = await setup();
    const t = await c.approved(10 * MIN);
    await c.db.update(tickets).set({ systemState: "in_progress", stateNoteStaleAt: new Date(), stateNoteStaleReason: GIT_RETRY_NOTE }).where(eq(tickets.id, t.id));
    await c.built.sweeps.resumeMergesOnPromotion(new Date());
    const r = await c.row(t.id);
    expect(r.stateNoteStaleReason).toBeNull();
    expect(r.stateNoteStaleAt).toBeNull();
    expect(c.merges()).toBe(0);
  });

  it("never clears or overwrites an owner-acted flag on the note", async () => {
    const c = await setup();
    c.mergeAnswers.push(BLIP);
    const t = await c.approved();
    await c.db.update(tickets).set({ stateNoteStaleAt: new Date(), stateNoteStaleReason: "the owner answered a card about it" }).where(eq(tickets.id, t.id));
    await c.built.review.landVisible(t.id, "the owner");
    await vi.waitFor(async () => expect((await c.row(t.id)).systemState).toBe("done"));
    expect((await c.row(t.id)).stateNoteStaleReason).toBe("the owner answered a card about it");
  });
});
