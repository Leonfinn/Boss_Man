// Lessons learned from sent-back reviews (R-review-lessons): a reviewer may attach one line when
// sending a ticket back; the owner decides whether it lands in the project brief's Lessons section.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, wakes, wikiRevisions, wikiPages } from "../src/db/schema.js";
import { briefCommitLine, briefSlug, LESSON_DONT_ADD, lessonsFrom } from "../src/services/project-brief.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Customer app" })).json() as { id: string; name: string };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const ticket = (await req("POST", `/api/projects/${project.id}/tickets`, { title: "Add rate limiting", assigneeAgentId: worker.id })).json() as { id: string };
  const sendBack = (lesson?: string) => req("POST", `/api/tickets/${ticket.id}/review`, { verdict: "changes_requested", summary: "Add tests.", ...(lesson !== undefined ? { lesson } : {}) });
  const open = async () => db.select().from(decisions).where(and(eq(decisions.companyId, company.id), eq(decisions.status, "open"))).orderBy(desc(decisions.createdAt));
  const answered = async () => db.select().from(decisions).where(and(eq(decisions.companyId, company.id), eq(decisions.status, "answered"))).orderBy(desc(decisions.createdAt));
  const answer = (id: string, a: string, note?: string) => req("POST", `/api/decisions/${id}/answer`, note === undefined ? { answer: a } : { answer: a, note });
  const brief = async () => (await db.select().from(wikiPages).where(and(eq(wikiPages.companyId, company.id), eq(wikiPages.slug, briefSlug(project.id)))))[0];
  const writeBrief = (body: string) => built.wiki.write(company.id, { slug: briefSlug(project.id), title: "Customer app — project brief", body, agentId: ceo.id, runId: null });
  return { ...built, db, close, req, company, ceo, project, worker, ticket, sendBack, open, answered, answer, brief, writeBrief };
}

const sendBackDecision = async () => (await ctx!.open()).find((d) => (d.context as { type: string }).type === "lesson")!;

describe("lessons learned from sent-back reviews", () => {
  it("a lesson on a sent-back review raises exactly one owner decision, and nothing else changes", async () => {
    const c = (ctx = await setup());
    await c.sendBack("Run the migration check locally before approving.");
    const [d] = await c.open();
    expect(d).toMatchObject({
      kind: "question",
      tier: "ceo",
      options: ["Add", "Edit", "Drop"],
      recommendedOption: "Add",
    });
    expect(d!.question).toContain(`Add this lesson to Customer app's brief? "Run the migration check locally before approving."`);
    expect(d!.question).toContain('ticket "Add rate limiting"');
    expect(d!.question).toContain("Current Lessons section (0 of 20)");
    // The CEO is woken once, with the decision.
    const woken = (await c.db.select().from(wakes)).filter((x) => x.agentId === c.ceo.id && JSON.stringify(x).includes("Run the migration check"));
    expect(woken).toHaveLength(1);
    // One decision: sending the exactly same lesson again can't double it.
    await c.db.execute(`update tickets set system_state = 'review'`);
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { state: "review" });
    await c.sendBack("Run the migration check locally before approving.");
    expect((await c.open()).filter((d) => (d.context as { type: string }).type === "lesson")).toHaveLength(1);
    // A different lesson on the same ticket is its own decision.
    await c.sendBack("Read the config from the environment, not from a file.");
    expect((await c.open()).filter((d) => (d.context as { type: string }).type === "lesson")).toHaveLength(2);
  });

  it("a sent-back review without a lesson behaves as today, and a lesson on an approval is refused", async () => {
    const c = (ctx = await setup());
    await c.sendBack();
    expect(await c.open()).toHaveLength(0);
    expect((await c.sendBack("Run the migration check locally before approving.").then((r) => r.statusCode))).toBe(200);
  });

  it("a lesson is one line, bounded, and goes with changes requested only", async () => {
    const c = (ctx = await setup());
    // A multiline lesson is folded to one line, not refused.
    let r = await c.sendBack("One line.\nSecond line.");
    expect(r.statusCode).toBe(200);
    expect((await sendBackDecision())!.question).toContain(`"One line. Second line."`);
    // Too long is refused outright (the owner route's schema stops it before the review service).
    r = await c.sendBack("x".repeat(241));
    expect(r.statusCode).toBe(400);
    // ...and it can't ride on an approval.
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { state: "review" });
    r = await c.req("POST", `/api/tickets/${c.ticket.id}/review`, { verdict: "approved", lesson: "x" });
    expect(r.statusCode).toBe(422);
    expect(r.json().message).toMatch(/goes with changes requested/);
  });

  it("Add writes the lesson into a stub brief when none exists; Drop adds nothing", async () => {
    const c = (ctx = await setup());
    await c.sendBack("Run the migration check locally before approving.");
    const d = await sendBackDecision();
    await c.answer(d!.id, "Add");
    let page = await c.brief();
    expect(page).toBeTruthy();
    expect(page!.folder).toBe("Projects/Customer app");
    expect(lessonsFrom(page!.body)).toEqual(["Run the migration check locally before approving."]);
    // The stub's first line is deliberately not a real commit line, so the upkeep loop ignores it.
    expect(page!.body.startsWith("Describes commit unknown on unknown.")).toBe(true);
    // The write is kept as a revision.
    expect(await c.db.select().from(wikiRevisions).where(eq(wikiRevisions.pageId, page!.id))).toHaveLength(1);

    await c.sendBack("Read the config from the environment.");
    const d2 = await sendBackDecision();
    await c.answer(d2!.id, "Drop");
    page = await c.brief();
    expect(lessonsFrom(page!.body)).toEqual(["Run the migration check locally before approving."]);
  });

  it("Edit uses the owner's note as the new wording, and an empty note adds nothing", async () => {
    const c = (ctx = await setup());
    await c.sendBack("Read the config from a file.");
    const d = await sendBackDecision();
    const refused = await c.answer(d!.id, "Edit");
    expect(refused.statusCode).toBe(422);
    expect(await c.brief()).toBeUndefined();
    await c.answer(d!.id, "Edit", "Read the config from the environment.");
    expect(lessonsFrom((await c.brief())!.body)).toEqual(["Read the config from the environment."]);
  });

  it("an already-present lesson is not written twice", async () => {
    const c = (ctx = await setup());
    await c.writeBrief(`${briefCommitLine("abc1234", "main")}\n\n## Gotchas\nBeware.\n\n## Lessons\n\n- Read the config from the environment.\n`);
    await c.sendBack("Read the config from the environment.");
    const d = await sendBackDecision();
    await c.answer(d!.id, "Add");
    const page = await c.brief();
    expect(lessonsFrom(page!.body)).toEqual(["Read the config from the environment."]);
    // The rest of the brief is untouched, and the Lessons section sits after the others.
    expect(page!.body.indexOf("## Gotchas")).toBeGreaterThan(-1);
  });

  it("the 21st lesson asks which one to drop, and the answer swaps them", async () => {
    const c = (ctx = await setup());
    const lines = Array.from({ length: 20 }, (_, i) => `- Lesson ${i + 1}`).join("\n");
    await c.writeBrief(`${briefCommitLine("abc1234", "main")}\n\n## Lessons\n\n${lines}\n`);
    await c.sendBack("Lesson 21");
    const d = await sendBackDecision();
    await c.answer(d!.id, "Add");
    // Full: no new line yet, and a follow-up choice is open instead.
    expect(lessonsFrom((await c.brief())!.body)).toHaveLength(20);
    expect((await c.brief())!.body).not.toContain("Lesson 21");
    const [replace] = (await c.open()).filter((d) => (d.context as { type: string }).type === "lesson_replace");
    expect(replace).toMatchObject({ tier: "ceo" });
    expect(replace!.question).toContain("is full (20)");
    expect(replace!.options).toEqual([...Array.from({ length: 20 }, (_, i) => `Replace #${i + 1}: Lesson ${i + 1}`), LESSON_DONT_ADD]);
    await c.answer(replace!.id, "Replace #3");
    const body = (await c.brief())!.body;
    expect(body).toContain("- Lesson 21");
    expect(body).not.toContain("- Lesson 3\n");
    // "Don't add it" leaves the section as it is.
    await c.sendBack("Lesson 22");
    const d22 = await sendBackDecision();
    await c.answer(d22!.id, "Add");
    const [replace2] = (await c.open()).filter((d) => (d.context as { type: string }).type === "lesson_replace");
    await c.answer(replace2!.id, LESSON_DONT_ADD);
    expect((await c.brief())!.body).not.toContain("- Lesson 22");
  });

  it("drop-one decisions take a number, and stop offering a lesson another one removed (BOS-108)", async () => {
    const long = "L".repeat(300);
    const c = (ctx = await setup());
    const lines = [`- ${long}`, ...Array.from({ length: 19 }, (_, i) => `- Lesson ${i + 2}`)].join("\n");
    await c.writeBrief(`${briefCommitLine("abc1234", "main")}\n\n## Lessons\n\n${lines}\n`);
    for (const l of ["New A", "New B"]) {
      await c.sendBack(l);
      await c.answer((await sendBackDecision())!.id, "Add");
    }
    const [a, b] = (await c.open()).filter((d) => (d.context as { type: string }).type === "lesson_replace");
    // The 300-character lesson is chosen by its number.
    expect((await c.answer(a!.id, "Replace #1")).statusCode).toBe(200);
    expect((await c.brief())!.body).not.toContain(long);
    const [left] = (await c.open()).filter((d) => d.id === b!.id);
    expect(left!.options).not.toContain(`Replace #1: ${long}`);
    expect((await c.answer(b!.id, `Replace #1: ${long}`)).statusCode).toBe(422);
    expect((await c.answer(b!.id, "Replace #1")).statusCode).toBe(422);
  });

  it("after a hand edit, the refusal lists the decision's own numbers, so following it drops the lesson meant (BOS-108)", async () => {
    const c = (ctx = await setup());
    const lines = Array.from({ length: 20 }, (_, i) => `- Lesson ${i + 1}`).join("\n");
    await c.writeBrief(`${briefCommitLine("abc1234", "main")}\n\n## Lessons\n\n${lines}\n`);
    await c.sendBack("New A");
    await c.answer((await sendBackDecision())!.id, "Add");
    const [rep] = (await c.open()).filter((d) => (d.context as { type: string }).type === "lesson_replace");
    // The owner edits Lesson 1 out of the brief by hand.
    const cur = (await c.brief())!;
    await c.db.update(wikiPages).set({ body: cur.body.replace("- Lesson 1\n", "") }).where(eq(wikiPages.id, cur.id));
    const refused = await c.answer(rep!.id, "Replace #1");
    expect(refused.statusCode).toBe(422);
    const msg = refused.body;
    expect(msg).toContain("Replace #3: Lesson 3");
    expect(msg).not.toContain("Replace #1: Lesson 1 ");
    expect(msg).not.toMatch(/Replace #2: Lesson 3/);
    expect((await c.answer(rep!.id, "Replace #3")).statusCode).toBe(200);
    const body = (await c.brief())!.body;
    expect(body).not.toContain("- Lesson 3\n");
    expect(body).toContain("- Lesson 2\n");
    expect(body).toContain("- New A");
  });

  it("the Wiki Maintainer's rewrite of the brief can't touch the Lessons section", async () => {
    const c = (ctx = await setup());
    await c.writeBrief(`${briefCommitLine("abc1234", "main")}\n\n## Gotchas\nBeware.\n\n## Lessons\n\n- Read the config from the environment.\n`);
    // Rewriting other sections passes, with the Lessons section byte-for-byte.
    const kept = await c.writeBrief(`${briefCommitLine("def5678", "main")}\n\n## Gotchas\nDifferent.\n\n## Lessons\n\n- Read the config from the environment.\n`);
    expect(kept.created).toBe(false);
    // Dropping or changing the section is refused.
    await expect(c.writeBrief(`${briefCommitLine("def5678", "main")}\n\n## Gotchas\nDifferent.\n`)).rejects.toThrow(/Lessons/);
    await expect(c.writeBrief(`${briefCommitLine("def5678", "main")}\n\n## Gotchas\nDifferent.\n\n## Lessons\n\n- Something else.\n`)).rejects.toThrow(/Lessons/);
    // A brief that never had a Lessons section can still be written at all.
    const c2 = (ctx = await setup());
    const fresh = await c2.writeBrief(`${briefCommitLine("abc1234", "main")}\n\n## Gotchas\nBeware.\n`);
    expect(fresh.created).toBe(true);
  });
});
describe("lessons learned: QA edge cases", () => {
  it("a resubmitted identical lesson after the owner already answered raises no new decision (dedupeKey persists)", async () => {
    const c = (ctx = await setup());
    await c.sendBack("Run the migration check locally before approving.");
    const d = await sendBackDecision();
    await c.answer(d!.id, "Drop");
    await c.db.execute(`update tickets set system_state = 'review'`);
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { state: "review" });
    await c.sendBack("Run the migration check locally before approving.");
    // The answered decision keeps its dedupeKey, so the resubmit can't raise a second one.
    expect((await c.open()).filter((x) => (x.context as { type: string }).type === "lesson")).toHaveLength(0);
    expect(await c.brief()).toBeUndefined();
  });

  it("a different lesson on the same ticket after a first lesson was answered still raises its decision", async () => {
    const c = (ctx = await setup());
    await c.sendBack("Read the config from a file.");
    await c.answer((await sendBackDecision())!.id, "Drop");
    await c.db.execute(`update tickets set system_state = 'review'`);
    await c.req("PATCH", `/api/tickets/${c.ticket.id}`, { state: "review" });
    await c.sendBack("Read the config from the environment, not from a file.");
    expect((await c.open()).filter((x) => (x.context as { type: string }).type === "lesson")).toHaveLength(1);
  });

  it("a whitespace-only lesson on a send-back is refused and raises no decision", async () => {
    const c = (ctx = await setup());
    // A whitespace-only lesson is treated as no lesson: the send-back passes without one.
    const r = await c.sendBack("   \n\t  ");
    expect(r.statusCode).toBe(200);
    expect((await c.open()).filter((x) => (x.context as { type: string }).type === "lesson")).toHaveLength(0);
  });

  it("a lessons-cap replace answer must use the exact prefixed line or Don't add it", async () => {
    const c = (ctx = await setup());
    const lines = Array.from({ length: 20 }, (_, i) => `- Lesson ${i + 1}`).join("\n");
    await c.writeBrief(`${briefCommitLine("abc1234", "main")}\n\n## Lessons\n\n${lines}\n`);
    await c.sendBack("Lesson 21");
    const d = await sendBackDecision();
    await c.answer(d!.id, "Add");
    const [replace] = (await c.open()).filter((x) => (x.context as { type: string }).type === "lesson_replace");
    const bare = await c.answer(replace!.id, "Lesson 3");
    expect(bare.statusCode).toBe(422);
    expect(lessonsFrom((await c.brief())!.body)).toHaveLength(20);
  });

  it("a lessons-cap replace answered in free text keeps the lesson pending and wakes the CEO with it", async () => {
    const c = (ctx = await setup());
    const lines = Array.from({ length: 20 }, (_, i) => `- Lesson ${i + 1}`).join("\n");
    await c.writeBrief(`${briefCommitLine("abc1234", "main")}\n\n## Lessons\n\n${lines}\n`);
    await c.sendBack("Lesson 21");
    const d = await sendBackDecision();
    await c.answer(d!.id, "Add");
    const [replace] = (await c.open()).filter((x) => (x.context as { type: string }).type === "lesson_replace");
    const r = await c.req("POST", `/api/decisions/${replace!.id}/answer`, { answer: "Check the document first, raise the cap to 25 if needed.", custom: true });
    expect(r.statusCode).toBe(200);
    expect(lessonsFrom((await c.brief())!.body)).toHaveLength(20);
    // The CEO gets a follow-up lesson decision carrying the owner's words, and answers it through the normal path.
    const [follow] = (await c.open()).filter((x) => (x.context as { type: string }).type === "lesson_replace");
    expect(follow!.tier).toBe("ceo");
    expect(follow!.question).toContain("raise the cap to 25");
    const w = (await c.db.select().from(wakes)).filter((x) => x.agentId === c.ceo.id);
    expect(JSON.stringify(w)).toContain(follow!.question.slice(0, 40));
    const done = await c.answer(follow!.id, "Replace #3");
    expect(done.statusCode).toBe(200);
    const kept = lessonsFrom((await c.brief())!.body);
    expect(kept).toContain("Lesson 21");
    expect(kept).not.toContain("Lesson 3");
    expect(kept).toHaveLength(20);
  });
});

describe("lesson decisions go to the CEO (BOS-105)", () => {
  it("the cap question is for the CEO, and the owner's feed says what was added, dropped and why", async () => {
    const c = (ctx = await setup());
    const lines = Array.from({ length: 20 }, (_, i) => `- Lesson ${i + 1}`).join("\n");
    await c.writeBrief(`${briefCommitLine("abc1234", "main")}\n\n## Lessons\n\n${lines}\n`);
    await c.sendBack("Lesson 21");
    await c.answer((await sendBackDecision())!.id, "Add", "Worth a line.");
    const [replace] = (await c.open()).filter((x) => (x.context as { type: string }).type === "lesson_replace");
    expect(replace).toMatchObject({ tier: "ceo" });
    expect(JSON.stringify(await c.db.select().from(wakes))).toContain("is full (20)");
    await c.answer(replace!.id, "Replace #3", "Overlaps lesson 4.");
    const feed = (await c.db.select().from(activity)).filter((a) => a.kind === "lesson_outcome").map((a) => a.summary);
    expect(feed.some((s) => s.includes('added "Lesson 21" and dropped "Lesson 3"') && s.includes("Overlaps lesson 4."))).toBe(true);
  });

  it("lesson decisions are not in the owner's queue, at the cap or not", async () => {
    const c = (ctx = await setup());
    const lines = Array.from({ length: 20 }, (_, i) => `- Lesson ${i + 1}`).join("\n");
    await c.writeBrief(`${briefCommitLine("abc1234", "main")}\n\n## Lessons\n\n${lines}\n`);
    await c.sendBack("Lesson 21");
    const lessonId = (await sendBackDecision())!.id;
    const queued = async () => ((await c.req("GET", "/api/decisions")).json() as Array<{ id: string }>).map((x) => x.id);
    expect(await queued()).not.toContain(lessonId);
    await c.answer(lessonId, "Add");
    const [replace] = (await c.open()).filter((x) => (x.context as { type: string }).type === "lesson_replace");
    expect(replace).toBeDefined();
    expect(await queued()).not.toContain(replace!.id);
  });
});
