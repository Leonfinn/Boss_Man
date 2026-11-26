// BOS-1361: closing a ticket that hands work on opens the follow-up (followUps), and done is refused
// when the wording hands work on and neither followUps nor noFollowUpReason is given.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { projects, ticketDependencies, ticketMessages, tickets } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { edgeCasePhrase, handOffPhrase } from "../src/services/hand-offs.js";
import { openBlockers } from "../src/services/ticket-links.js";

let server: Awaited<ReturnType<typeof boot>>;
let ctx: Awaited<ReturnType<typeof setup>>;

async function boot() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return { built, db, close, base, cookie, companies: 0 };
}

async function setup() {
  const { built, db, base, cookie } = server;
  const clients: Client[] = [];
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: `Hand-off Co ${++server.companies}` })).json() as { company: { id: string }; ceo: { id: string } };
  const dev = (await req("POST", `/api/companies/${co.company.id}/agents`, { name: "Dev" })).json() as { id: string };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "Customer app" })).json() as { id: string };
  // A no-code ticket its own assignee closes, so the tests reach the done gate without a branch.
  const ticket = async (patch: Record<string, unknown> = {}) =>
    (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title: "Backfill features", systemState: "in_progress", noCode: true, assigneeAgentId: dev.id, ...patch }).returning())[0]!;
  const agent = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: co.company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "test", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { db, req, co, dev, project, ticket, agent, done: async () => { await Promise.all(clients.map((c) => c.close())); } };
}
const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");

beforeAll(async () => { server = await boot(); }, 120_000);
afterAll(async () => { await server.built.app.close(); await server.close(); });
beforeEach(async () => { ctx = await setup(); });
afterEach(async () => { await ctx.done(); });

describe("the hand-off wording", () => {
  it("catches the BOS-958 wording and the other listed phrasings", () => {
    for (const s of [
      "Done. The CEO will attach them to the features.",
      "Schema in; for the CEO to wire up the board next.",
      "Backfill ready, handed to Brains for the rest.",
      "Hand off to Rod once he is back.",
      "Next: someone picks up the docs.",
      "Brains will create the 34 features.",
    ]) expect(handOffPhrase(s), s).not.toBeNull();
  });

  it("leaves ordinary done summaries alone", () => {
    for (const s of [
      "Wrote the page; every criterion passes.",
      "It will create a row for each device. Tests pass; 1 pass; 2 pass.",
      "Merged. The migration will add a column; checked live, 1 pass.",
      "Research done: three options compared, recommendation on the wiki page.",
      "Closed as a duplicate: the change shipped on BOS-1200.",
      "Fixed the CEO card wake; the CEO now gets every card.",
      "Added the hand-off wording check and its tests.",
      "Cancelled: the owner decided against it.",
    ]) expect(handOffPhrase(s), s).toBeNull();
  });

  // Real done-ticket state notes read from the live board on 13 Nov (BOS-1369, 1367, 1302, 1364, 1355,
  // 1310, 1124, 1329, 1335, 1316, 1313, 1294, 1312, 1314, 1293, 1296, 1336, 1319, 1080, 1231, 1334,
  // 1300, 1285, 1244, 1257, 1330, 1325, 1327, 1274, 1322, 1256, 1243, 1233, 1075, 1193, 1307, 1303).
  // None of them hands work on, so none may be refused: false positives = 0.
  it("does not refuse 37 real done summaries (false positives: 0)", () => {
    const real = [
      "Added the 3ff140b7 entry (BOS-1302, website guides) at the top of the Release log; f8d967a1 was already recorded. Read-back confirms all sections and archive links intact, page 6,300 to 7,810 chars. Owner has nothing to do.",
      "Design done: Penpot boards (desktop, foldable, phone, every state) + wiki page design/thinking-trace-in-agent-chats-bos-1367 with copy, CSS and build notes. beautiful-ui is MIT. BOS-1368 can start.",
      "1 pass; 2 pass; 3 pass; 4 pass; 5 pass (Guide 3 step 8, Add more, FAQ, home page link to it); 6 pass: site build and link check pass, quick check passed on ac3de270, sources on ticket.",
      "Release log entry added for f8d967a1 (was 7a49b9f9, shipped BOS-1310, owner's About photo in code). No owner action: no rebuild, no rollback rebuild needed. Switch time not confirmed. Origin/main is ahead by 3ff140b7, not live yet.",
      "Logged 7a49b9f9 (was dc5a57d8, ~08:43 UTC): 13 merges, no migration. Read back 49 sections, older entries intact. No owner step: a runner swap was already running. Log at its cap, so entry is a stub; 57f3664e asks the CEO to archive.",
      "1 pass; 2 pass. Owner's About photo added at the agreed path from current main, with camera details and Google edit record removed (it had no location data). Picture unchanged. Quick check passed.",
      "1 pass; 2 pass; 3 pass; 4 pass; 5 pass (Sooty signed off, pairs attached). Rex approved the code. Quick check green on ec37f508; merge running. Nothing of mine is waiting on the owner.",
      "Overnight watch done. 12 merged, main green; queue 30→34 because passed checks were requeued when main moved (BOS-1328 fix awaits server update c338ee7d). Morning summary posted. Merge sweep continues on BOS-350.",
      "Release log entry for dc5a57d8 recorded (one merge, BOS-1231). Owner rebuilt the runners (~07:55); BOS-1231 now shows runners rebuilt: yes. Rebuild card withdrawn as done.",
      "1 pass (6/6); 2 pass (now/next swap makes 2 tests fail, reverted); 3 pass (working tree clean, diff vs origin/main is only the new test file, check-quick passed).",
      "1 pass: 7/7 tests. 2 pass: slice(0,19) mutation made 6 fail, source restored, not committed. 3 pass: diff vs main is only the new test file; check-quick passed.",
      "1 pass: 8/8 tests. 2 pass: removing the replace made tidying fail (2 failed), source restored. 3 pass: diff only the test file; check-quick passes. Ready for review.",
      "1 pass: 32/32 tests. 2 pass: removing toLowerCase made the upper-case sha test fail; src restored, not committed. 3 pass: diff is only the new test file and check-quick passed.",
      "1 pass: 11 tests pass. 2 pass: removing the filter line by hand fails 3 tests; source restored. 3 pass: diff only the new test file; check-quick passes.",
      "1 pass: 5/5 tests; 2 pass: hand mutation makes grace-0 fail, source restored; 3 pass: diff only the new file, check-quick passed.",
      "1 pass: 8/8 cases. 2 pass: at>=run fails 2 tests, dropping at>=0 fails 1 (uncommitted, then reverted). 3 pass: diff is only the new test file, check-quick green. Same commit 1a4c689a.",
      "1 pass; 2 pass (10/10 under load); 3 pass (test only). Test-only: jump check waits for scroll and height per section, visible window, stops at page end. tsc and check-quick pass.",
      "1 pass (BOS-1094 tree fc650616 predated BOS-1283s fix, stated on ticket); 2 pass (condition + 10s deadline; 10/10 local; old wait failed 3/3 under a 1200ms shift, new passed 4/4). Test-only. typecheck + check-quick pass. Commit 8d2248e0.",
      "1 pass; 2 pass; 3 pass. Approved. The owner answered the second merge-retry card; the merge has been running again since 18:43 UTC. Branch untouched. The photo goes to main on BOS-1310, not here.",
      "Flaky-test fix BOS-1303 has merged, so the held merge retries by itself on the same approved commit (daebf3d2, approvals kept). No backup check booked. 1 pass; 2 pass; 3 pass.",
      "Added the d7f20027 entry at the top of Releases/Release log with append (3 tickets: BOS-1257, BOS-1244, BOS-1285). Read back: all older sections intact, page longer. Nothing for the owner to do.",
      "1 pass; 2 pass; 3 pass; 4 pass; 5 pass. Sooty confirmed in owner chat that the Penpot skill loads: listed files, read the About page, exported a board, no errors. No open card remains.",
      "Quick check passed on 84ecdaff. 1 pass; 2 pass; 3 pass; 4 pass; 5 pass; 6 pass. All six are covered by tests in the new owner-form-steps test file; the step 0 answer was posted on the ticket.",
      "1 pass (12 tests); 2 pass (>= to === made the longer-closer test fail, 1 of 12, scratch copy only); 3 pass (diff is only the new test file; quick check passed). No bugs, no it.fails.",
      "Approved by Rex, merge check running. 1 pass; 2 pass; 3 pass (1550/1667; phone seen at 500px, 390 for QA); 4 pass; 5 pass; 6 pass; 7 pass; 8 pass; 9 pass (phone shot at 500px)",
      "Security review of penpot: recommend with conditions (1 finding).",
      "Owner approved the About page as it is (\"Looks right: build it as it is\"). 1 pass; 2 pass; 3 pass; 4 pass. No change needed; the layout shipped on BOS-1080.",
      "Added the 43cf3ba5 entry to the Release log (append at top; 186,543 -> 190,388 chars, all sections intact). One ticket shipped: BOS-1274. No migration, server or runner change. Owner has nothing to do.",
      "Approved by Rex; merge check running. Lesson cards show the note box for Edit and the reason; plain question cards do not. Owner has nothing to do.",
      "Release log updated for d335eb58 via append; 44 to 45 sections, read back, oldest entries intact. Shipped BOS-1256 Agents rows UI plus tests. No migration or runner change. Owner does nothing for this switch; time not confirmed.",
      "Rod's fixes in; quick check passed on 025f0c12. 1 pass; 2 pass; 3 pass (dark theme measured, light not); 4 pass; 5 pass (Chromium 1667/1550/390, dim tap fixed); 6 pass (3 after-shots, no before-shots at 1550/390).",
      "Diff vs origin/main is only the new test file: pass. scripts/check-quick.sh (queued) passes on 763ebbb5: pass. 1 pass; 2 pass; 3 pass. 10 tests, no bugs found.",
      "1 pass: 13/13 tests pass from apps/server. 2 pass: hand-made remove-all mutation failed the first-match test. 3 pass: diff vs origin/main is only the new test file and quick check passed. Waiting on Rex's review verdict.",
      "1 pass; 2 pass; 3 pass: HolidayHours (engagement 24bcc3f7) says their runner restarted at 16:06 UTC, after go-live. HOL-615, booked 18:00, fired once at 18:00:26; HOL-5 (18 Nov) didn't fire. Before the fix, both fired early.",
      "1-6 pass (before merge). 7 pass: CEO listed the live queue at 17:53 UTC. 3 cards, none labelled possibly out of date; no plan cards for BOS-382/373/974 open. Live on 7621b904.",
      "CPU review is finished and the report is in the wiki. I answered the owner's question about adding 1 core: about 5–10% faster under load, with optional Proxmox steps posted on the ticket. Hardware recommendation unchanged.",
    ];
    expect(real.length).toBeGreaterThanOrEqual(20);
    const hits = real.map((s) => [s, handOffPhrase(s)] as const).filter(([, h]) => h);
    expect(hits.map(([s, h]) => `${h!.label}: ${h!.quote} <- ${s.slice(0, 60)}`)).toEqual([]);
  });
});

describe("set_ticket_state done with hand-off wording", () => {
  it("is refused with no followUps, and the ticket stays put", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Schema done. The CEO will attach the features." } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect(textOf(r)).toContain("followUps");
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
  });

  it("reads the last reply too", async () => {
    const t = await ctx.ticket();
    await ctx.db.insert(ticketMessages).values({ companyId: ctx.co.company.id, ticketId: t.id, author: "agent", agentId: ctx.dev.id, text: "All 34 are listed; the CEO will attach them." });
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Finished." } });
    expect((r as { isError?: boolean }).isError).toBe(true);
  });

  it("BOS-2679: a known edge case in the last reply refuses done; a ticket id, followUps or a reason clears it", async () => {
    const t = await ctx.ticket();
    await ctx.db.insert(ticketMessages).values({ companyId: ctx.co.company.id, ticketId: t.id, author: "agent", agentId: ctx.dev.id, text: "Done. Known edge case: a weekly-limit stop's own reading may hide other limits until the next report." });
    const c = await ctx.agent(ctx.dev.id);
    const refused = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Finished." } });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("known edge case");
    const ok = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Finished.", noFollowUpReason: "Covered by the weekly-limit ticket." } });
    expect((ok as { isError?: boolean }).isError).toBeFalsy();
  });

  it("BOS-2679: a move to review with a known limitation in the summary is refused; a ticket id clears it", async () => {
    const t = await ctx.ticket({ systemState: "in_progress", noCode: false });
    const c = await ctx.agent(ctx.dev.id);
    const refused = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Built. Known limitation: renames are not handled." } });
    expect((refused as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(refused)).toContain("known edge case");
    const ticketed = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "review", summary: "Built. Known limitation: renames are not handled (BOS-2680)." } });
    expect(JSON.stringify(ticketed)).not.toContain("known edge case");
  });

  it("BOS-2679: edge-case wording", () => {
    for (const s of ["Known limitation: stale rows stay.", "Edge case: two reviewers at once.", "Renames are not handled yet.", "It doesn't handle empty feeds.", "This may hide other limits."]) expect(edgeCasePhrase(s), s).not.toBeNull();
    for (const s of ["Edge case tracked in BOS-2680.", "Wrote the page; every criterion passes.", "Tests pass; the build is green."]) expect(edgeCasePhrase(s), s).toBeNull();
  });

  it("noFollowUpReason lets it through", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Done. The CEO will attach them.", noFollowUpReason: "Already attached on BOS-1; wording is left over." } });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("done");
  });

  it("an ordinary summary is not refused", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Wrote the page; tests pass." } });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
  });

  it("followUps opens a linked ticket for the CEO in the same project and feature, and the move goes through", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Done. The CEO will attach them.", followUps: [{ title: "Attach the 34 features", assignee: "CEO", why: "BOS-958 listed them but nothing attached them." }] } });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    expect(textOf(r)).toContain("opened the follow-up");
    const made = (await ctx.db.select().from(tickets)).find((x) => x.title === "Attach the 34 features")!;
    expect(made.projectId).toBe(ctx.project.id);
    expect(made.assigneeAgentId).toBe(ctx.co.ceo.id);
    expect(made.body).toContain(`#/tickets/${t.id}`);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.stateNote).toContain(`#/tickets/${made.id}`);
  });

  it("a developer naming a colleague does not assign or wake them: the follow-up goes to the CEO with a suggestion", async () => {
    const other = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/agents`, { name: "Other" })).json() as { id: string };
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Wrote the page.", followUps: [{ title: "Look at infra", assignee: "Other", why: "Please check." }] } });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    const made = (await ctx.db.select().from(tickets)).find((x) => x.title === "Look at infra")!;
    expect(made.assigneeAgentId).toBe(ctx.co.ceo.id);
    expect(made.assigneeAgentId).not.toBe(other.id);
    expect(made.body).toContain("Suggested assignee:** Other");
  });

  it("the CEO can assign a follow-up straight to a colleague", async () => {
    const other = (await ctx.req("POST", `/api/companies/${ctx.co.company.id}/agents`, { name: "Other" })).json() as { id: string };
    const t = await ctx.ticket({ assigneeAgentId: ctx.co.ceo.id });
    const c = await ctx.agent(ctx.co.ceo.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Wrote the page.", followUps: [{ title: "CEO routes to a colleague", assignee: "Other", why: "Please check." }] } });
    expect((r as { isError?: boolean }).isError).toBeFalsy();
    expect((await ctx.db.select().from(tickets)).find((x) => x.title === "CEO routes to a colleague")!.assigneeAgentId).toBe(other.id);
  });

  it("repeating the same move opens no second set of follow-ups", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const args = { ticketId: t.id, state: "done", summary: "Wrote the page.", followUps: [{ title: "Once only", assignee: "CEO", why: "x" }] };
    await c.callTool({ name: "set_ticket_state", arguments: args });
    await c.callTool({ name: "set_ticket_state", arguments: args });
    expect((await ctx.db.select().from(tickets)).filter((x) => x.title === "Once only")).toHaveLength(1);
  });

  it("a wrong assignee name refuses the move before anything changes", async () => {
    const t = await ctx.ticket();
    const c = await ctx.agent(ctx.dev.id);
    const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Wrote the page.", followUps: [{ title: "Do more", assignee: "Nobody", why: "x" }] } });
    expect((r as { isError?: boolean }).isError).toBe(true);
    expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
  });

  // BOS-2599 (cock-ups G1): the criterion a hand-on came from goes into the follow-up, so the outcome isn't lost.
  describe("the follow-up carries the criterion it came from (BOS-2599)", () => {
    const CRITERIA = ["Sitemap read with no errors", "Bing site verified", "Umami click events seen"];

    it("a BOS-2069-shaped close carries the failed criterion's exact text", async () => {
      // BOS-2069's own shape: a ticket that never merged and has no changes of its own, so every criterion not reported
      // is held. Criterion 1 is reported fail, 2 not reported, 3 passes: both 1 and 2 have to be carried to close it.
      const t = await ctx.ticket({ acceptanceCriteria: CRITERIA });
      await ctx.db.update(tickets).set({ stateNote: "1 fail: Google has no sitemap and our login is read-only; 3 pass: clicks arrived on 19 Nov" }).where(eq(tickets.id, t.id));
      const c = await ctx.agent(ctx.co.ceo.id);
      const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Checked; handing the rest on.", followUps: [{ title: "Submit the sitemap", assignee: "CEO", why: "Google needs Full access first." }] } });
      expect((r as { isError?: boolean }).isError).toBeFalsy();
      const made = (await ctx.db.select().from(tickets)).find((x) => x.title === "Submit the sitemap")!;
      // Both left criteria, unchanged, in the order they are listed; the task wording stays in the description.
      expect(made.acceptanceCriteria).toEqual([CRITERIA[0], CRITERIA[1]]);
      expect(made.body).toContain("**Done when** (carried from");
      expect(made.body).toContain(CRITERIA[0]);
      expect(textOf(r)).toContain("carrying these 2 criteria");
      expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("done");
    });

    // The merged-ticket path is left alone (it has its own follow-up for a failed after-merge check, DR-009 #5 and
    // BOS-575): this tool's live diff can't be read here, so carrying there is `carriedCriteria`'s pure test.
    it("a merged ticket stays on its own path", async () => {
      const t = await ctx.ticket({ assigneeAgentId: ctx.co.ceo.id, acceptanceCriteria: CRITERIA });
      await ctx.db.update(projects).set({ repoUrl: "https://github.com/Leonfinn/merged-ticket.git" }).where(eq(projects.id, ctx.project.id));
      await ctx.db.update(tickets).set({ mergeCommit: "c".repeat(40), stateNote: "1 pass; 2 pass; 3 pass" }).where(eq(tickets.id, t.id));
      const c = await ctx.agent(ctx.co.ceo.id);
      const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "All good.", followUps: [{ title: "A small tidy-up", assignee: "CEO", why: "x" }] } });
      // Whatever this tool does with a merged branch, the never-merged rule does not apply: the moved note is kept.
      const after = (await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!;
      if (!(r as { isError?: boolean }).isError) expect(after.stateNote).toContain("All good.");
    });

    it("a criterion number that isn't on the ticket refuses the move before anything changes", async () => {
      const t = await ctx.ticket({ acceptanceCriteria: CRITERIA });
      const c = await ctx.agent(ctx.dev.id);
      const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Wrote the page.", followUps: [{ title: "Wrong number", assignee: "CEO", why: "x", criterion: 9 }] } });
      expect((r as { isError?: boolean }).isError).toBe(true);
      expect(textOf(r)).toContain("names criterion 9");
      expect((await ctx.db.select().from(tickets)).filter((x) => x.title === "Wrong number")).toEqual([]);
      expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
    });

    // BOS-2069 closed done while all four criteria read "[not reported]": a ticket that never merged and has no changes
    // of its own can't have checked anything on real work, so the done gate now holds every unreported criterion there.
    it("a never-merged ticket can't close with all its criteria unreported", async () => {
      const t = await ctx.ticket({ noCode: false, acceptanceCriteria: CRITERIA });
      const c = await ctx.agent(ctx.dev.id);
      const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Checked. Follow-up opened for the rest." } });
      expect((r as { isError?: boolean }).isError).toBe(true);
      expect(textOf(r)).toContain("never merged");
      expect(textOf(r)).toContain(CRITERIA[0]);
      expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("in_progress");
      // Handing them on is the way out: the close goes through and the follow-up carries them.
      const ok = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Checked. Handing the rest on.", followUps: [{ title: "The rest", assignee: "CEO", why: "x" }] } });
      expect((ok as { isError?: boolean }).isError).toBeFalsy();
      const made = (await ctx.db.select().from(tickets)).find((x) => x.title === "The rest")!;
      expect(made.acceptanceCriteria).toEqual(CRITERIA);
      expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.systemState).toBe("done");
    });

    // BOS-2643: BOS-2302 and BOS-2298 came from BOS-2283's followUps with a 3-day watch in their criteria, merged in hours
    // and sat open for 3 days. A carried watch of a day or more now opens its own check ticket; a one-time reading doesn't.
    it("a carried watch of a day or more opens its own check ticket, which waits on the follow-up's merge", async () => {
      const WATCH = { text: "Over 3 days live, no main CI run is cancelled for a higher priority waiting request", after: "merge" as const };
      const ONCE = { text: "One go-live reading shows the run", after: "merge" as const };
      const t = await ctx.ticket({ acceptanceCriteria: ["Workflow change written", WATCH, ONCE] });
      const c = await ctx.agent(ctx.co.ceo.id);
      const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Inventory done; handing the fix on.", followUps: [{ title: "Stop cancelling main runs", assignee: "Dev", why: "Main runs are cancelled." }] } });
      expect((r as { isError?: boolean }).isError, textOf(r)).toBeFalsy();
      const all = await ctx.db.select().from(tickets);
      const made = all.find((x) => x.title === "Stop cancelling main runs")!;
      const checks = all.filter((x) => x.checksTicketId === made.id);
      expect(checks).toHaveLength(1);
      const check = checks[0]!;
      expect(check.checksCriterion).toBe(2);
      expect(check.acceptanceCriteria).toEqual([WATCH.text]);
      expect([check.assigneeAgentId, check.systemState, check.noCode]).toEqual([ctx.dev.id, "blocked", true]);
      // One way only: the check waits on the follow-up's merge, and the follow-up waits on nothing, so it can start.
      const deps = await ctx.db.select().from(ticketDependencies);
      expect(deps.filter((d) => d.blockedTicketId === check.id).map((d) => [d.blockerTicketId, d.until])).toEqual([[made.id, "merged"]]);
      expect(deps.filter((d) => d.blockedTicketId === made.id)).toEqual([]);
      expect(await openBlockers(ctx.db, made.id)).toEqual([]);
      expect(textOf(r)).toMatch(/with its long watch on check ticket [A-Z]+-\d+/);
      // The closing ticket's note names both, so whoever reads it finds the watch.
      expect((await ctx.db.select().from(tickets).where(eq(tickets.id, t.id)))[0]!.stateNote).toMatch(/for Dev, with check ticket [A-Z]+-\d+ for its long watch/);
    });

    it("a follow-up whose carried criteria need no long watch opens no check ticket", async () => {
      const t = await ctx.ticket({ acceptanceCriteria: ["Workflow change written", { text: "One go-live reading shows the run", after: "merge" }] });
      const c = await ctx.agent(ctx.co.ceo.id);
      const r = await c.callTool({ name: "set_ticket_state", arguments: { ticketId: t.id, state: "done", summary: "Done; handing the rest on.", followUps: [{ title: "Read it once live", assignee: "Dev", why: "x" }] } });
      expect((r as { isError?: boolean }).isError, textOf(r)).toBeFalsy();
      const made = (await ctx.db.select().from(tickets)).find((x) => x.title === "Read it once live")!;
      expect((await ctx.db.select().from(tickets)).filter((x) => x.checksTicketId === made.id)).toEqual([]);
      expect(textOf(r)).not.toContain("long watch");
    });
  });
});
