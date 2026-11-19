// BOS-1650: the go-live card opens with "why" and "if you skip it" (ownerSetupShapeProblem, raiseOwnerSetup); no
// prose branching in the owner's steps (R20); a `[when <fact>]` step is kept or dropped from Boss Man's own record
// at raise time, and a fact it can't settle goes to the CEO, never dropped. Every value is a made-up example.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { activity, decisions, tickets } from "../src/db/schema.js";
import { raiseOwnerSetup } from "../src/services/decisions.js";
import { checkOwnerSetup, NOT_GIVEN, ownerSetupShapeProblem } from "../src/services/owner-setup-check.js";
import { branchingIn, settleWhen } from "../src/services/owner-setup-when.js";
import { lintOwnerSteps } from "../src/services/steps.js";

const r20 = (steps: string[]) => {
  const c = checkOwnerSetup(steps, {}, "write");
  return [...c.hard, ...c.soft].filter((f) => f.rule === "R20");
};

describe("R20 prose branching: refused rows", () => {
  it.each([
    ["BOS-1582 wording: If no entry is marked", "If no entry is marked can go, there is nothing to do."],
    ["Only if", "Only if the entry is marked can go, remove the line from Settings → Server and runner."],
    ["If at the start", "If the old address is still listed, delete it."],
    ["Unless", "Unless the owner already did this, press Save."],
    ["nothing to do", "Open Settings → Server and runner. Otherwise there is nothing to do."],
    ["if it isn't there", "Add the entry if it isn't listed yet."],
    ["if there is no", "Press Save if there is no entry."],
    ["later sentence", "Open Settings → Server and runner. If the line is empty, press Save."],
  ])("%s", (_name, step) => {
    const found = r20([step]);
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toMatch(/\[when <fact>\]/);
  });
});

describe("R20 prose branching: passing rows", () => {
  it.each([
    ["plain step", "Open Settings → Server and runner and press Save."],
    ["a command with an if inside its block", "Run this. It prints nothing.\n```sh host=\"nas01\" as=\"login\"\nif [ -f /opt/example/x ]; then echo ok; fi\n```"],
    ["'whether', not a branch", "Check whether the page loads."],
    ["a [if company…] branch is DR-057's", "[if company.holiday-hours.deployTarget exists] Open Settings → Server and runner and press Save."],
  ])("%s", (_name, step) => {
    expect(r20([step])).toEqual([]);
  });

  it("a [when …] step passes the lint once Boss Man has settled it (marker off)", () => {
    const c = checkOwnerSetup(["[when network guard allow line can go] Open Settings → Server and runner and press Save."], {}, "write");
    expect([...c.hard, ...c.soft].filter((f) => f.rule === "R20" || f.rule === "R4")).toEqual([]);
  });

  it("branchingIn names the offending words", () => {
    expect(branchingIn("Only if the entry is marked, remove it.")).toMatch(/^Only if the entry/);
  });
});

describe("an agent's own card (raise_decision) is not R20-checked, and an unsettled marker on it is refused", () => {
  it("lintOwnerSteps leaves prose branching alone but refuses a leftover [when …]", () => {
    expect(lintOwnerSteps(["If the line is empty, press Save in Settings → Server and runner."]).refuse.filter((f) => f.rule === "R20")).toEqual([]);
    expect(lintOwnerSteps(["[when network guard allow line can go] Press Save."]).refuse).toEqual([expect.objectContaining({ step: 1, rule: "R4" })]);
  });
});

describe("settleWhen", () => {
  const STEP = "[when network guard allow line can go] Remove the entries from the line.";
  const KEY = "network guard allow line can go";
  it("true: marker comes off, step stays", () => {
    expect(settleWhen([STEP, "Press Save."], { [KEY]: true }, "raise")).toEqual({ steps: ["Remove the entries from the line.", "Press Save."], dropped: [], findings: [] });
  });
  it("false: the step is dropped and reported", () => {
    const s = settleWhen([STEP, "Press Save."], { [KEY]: false }, "raise");
    expect(s.steps).toEqual(["Press Save."]);
    expect(s.dropped).toEqual([{ step: 1, fact: KEY }]);
  });
  it.each([[undefined], [null]])("%s (can't be settled): kept as written with an R4 finding, so the CEO is asked", (value) => {
    const s = settleWhen([STEP], { [KEY]: value }, "raise");
    expect(s.dropped).toEqual([]);
    expect(s.findings).toEqual([expect.objectContaining({ step: 1, rule: "R4" })]);
    expect(settleWhen([STEP], undefined, "raise").findings).toHaveLength(1);
  });
  it("an unknown fact is refused when written, listing the known ones", () => {
    const s = settleWhen(["[when the moon is full] Press Save."], {}, "write");
    expect(s.findings).toEqual([expect.objectContaining({ rule: "R20", problem: expect.stringContaining(KEY) })]);
  });
  it("written: nothing is dropped, so the author's lint sees every step", () => {
    expect(settleWhen([STEP], { [KEY]: false }, "write").steps).toEqual(["Remove the entries from the line."]);
  });
  it("a marker is case and spacing tolerant", () => {
    expect(settleWhen(["[When Network  Guard allow-line CAN go] Do it."], { [KEY]: true }, "raise").steps).toEqual(["Do it."]);
  });
});

describe("ownerSetupShapeProblem", () => {
  it("needs both lines when there are steps", () => {
    expect(ownerSetupShapeProblem(["Press Save."], null, null)).toMatch(/ownerSetupWhy is missing.*ownerSetupIfSkipped is missing/);
    expect(ownerSetupShapeProblem(["Press Save."], "Lets you sign in.", "  ")).toMatch(/ownerSetupIfSkipped is missing/);
    expect(ownerSetupShapeProblem(["Press Save."], "Lets you sign in.", "Nothing breaks.")).toBeNull();
  });
  it("one line only", () => {
    expect(ownerSetupShapeProblem(["Press Save."], "Line one\nline two", "Nothing breaks.")).toMatch(/one line/);
    expect(ownerSetupShapeProblem(["Press Save."], "x".repeat(241), "Nothing breaks.")).toMatch(/one line/);
  });
  it("no steps, no requirement", () => {
    expect(ownerSetupShapeProblem([], null, null)).toBeNull();
  });
});

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});
async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const co = (await req("POST", "/api/companies", { name: "Card Co" })).json() as { company: { id: string } };
  const project = (await req("POST", `/api/companies/${co.company.id}/projects`, { name: "App" })).json() as { id: string };
  const ticket = async (title: string) => (await db.insert(tickets).values({ companyId: co.company.id, projectId: project.id, title, systemState: "done" }).returning())[0]!;
  return { ...built, db, close, companyId: co.company.id, ticket };
}
const cards = (c: NonNullable<typeof ctx>) => c.db.select().from(decisions).where(eq(decisions.companyId, c.companyId));
const KEY = "network guard allow line can go";

describe("raiseOwnerSetup (BOS-1650)", () => {
  it("opens with why and if-you-skip-it, then the steps", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Penpot over the network");
    const row = await raiseOwnerSetup(ctx.db, { companyId: ctx.companyId, tickets: [{ ticketId: t.id, title: t.title, why: "Lets Penpot open from your laptop.", ifSkipped: "Nothing breaks; Penpot stays reachable only from the server." }], steps: ["Open Settings → Server and runner and press Save."], commit: "a".repeat(40) });
    expect(row).not.toBeNull();
    const [card] = await cards(ctx);
    expect(card!.question).toBe(`"Penpot over the network" is live.\n\nWhy: Lets Penpot open from your laptop.\nIf you skip it: Nothing breaks; Penpot stays reachable only from the server.\nWhere: Step 1: Boss Man, in Settings\n\nSteps:\n\n1. Open Settings → Server and runner and press Save.`);
    expect(card!.question).not.toContain("To start using it");
  });

  it("fills a host token in the why line (BOS-1660) and sends the CEO a fix card, not the owner, when one has no value", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Tunnel config");
    const facts = { values: { "env.file": "/srv/bm/.env" }, serverHost: null, hosts: [] };
    const row = await raiseOwnerSetup(ctx.db, { companyId: ctx.companyId, tickets: [{ ticketId: t.id, title: t.title, why: "The tunnel reads {{host.env.file}}.", ifSkipped: "Nothing breaks." }], steps: ["Open Settings → Server and runner and press Save."], commit: "a".repeat(40), facts });
    expect(row).not.toBeNull();
    expect((await cards(ctx))[0]!.question).toContain("Why: The tunnel reads /srv/bm/.env.");
    const t2 = await ctx.ticket("Other config");
    const bad = await raiseOwnerSetup(ctx.db, { companyId: ctx.companyId, tickets: [{ ticketId: t2.id, title: t2.title, why: "Reads {{host.paths.nope}}.", ifSkipped: "Nothing breaks." }], steps: ["Open Settings → Server and runner and press Save."], commit: "b".repeat(40), facts });
    expect(bad).toBeNull();
    const all = await cards(ctx);
    expect(all.some((c) => c.question.includes("{{host.paths.nope}}") && c.tier !== "owner")).toBe(true);
    expect(all.filter((c) => c.tier === "owner" && c.question.includes("{{"))).toEqual([]);
  });

  it("a ticket written before the fields existed is still raised, with 'not given'", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Old ticket");
    await raiseOwnerSetup(ctx.db, { companyId: ctx.companyId, tickets: [{ ticketId: t.id, title: t.title, why: null, ifSkipped: null }], steps: ["Open Settings → Server and runner and press Save."], commit: "a".repeat(40) });
    const [card] = await cards(ctx);
    expect(card!.question).toContain(`Why: ${NOT_GIVEN}\nIf you skip it: ${NOT_GIVEN}`);
    expect(card!.tier).toBe("owner");
  });

  it("a card for several tickets gives each its own lines", async () => {
    ctx = await setup();
    const a = await ctx.ticket("First");
    const b = await ctx.ticket("Second");
    await raiseOwnerSetup(ctx.db, { companyId: ctx.companyId, tickets: [{ ticketId: a.id, title: a.title, why: "Reason A.", ifSkipped: "Skip A." }, { ticketId: b.id, title: b.title, why: null, ifSkipped: null }], steps: ["Open Settings → Server and runner and press Save."], commit: "a".repeat(40) });
    const [card] = await cards(ctx);
    expect(card!.question).toContain('"First"\nWhy: Reason A.\nIf you skip it: Skip A.');
    expect(card!.question).toContain(`"Second"\nWhy: ${NOT_GIVEN}`);
  });

  const STEPS = [`[when ${KEY}] Remove the entries from the line in Settings → Server and runner and press Save.`];
  const tk = (id: string, title: string) => ({ ticketId: id, title, why: "Tidies the network guard line.", ifSkipped: "Nothing breaks." });

  it("fact true: the step goes out without its marker", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Guard line");
    await raiseOwnerSetup(ctx.db, { companyId: ctx.companyId, tickets: [tk(t.id, t.title)], steps: STEPS, commit: "a".repeat(40), facts: { when: { [KEY]: true } } });
    const [card] = await cards(ctx);
    expect(card!.question).toContain("1. Remove the entries from the line");
    expect(card!.question).not.toContain("[when");
  });

  it("fact false: no card, and the ticket gets a note", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Guard line");
    const row = await raiseOwnerSetup(ctx.db, { companyId: ctx.companyId, tickets: [tk(t.id, t.title)], steps: STEPS, commit: "a".repeat(40), facts: { when: { [KEY]: false } } });
    expect(row).toBeNull();
    expect(await cards(ctx)).toEqual([]);
    const notes = await ctx.db.select().from(activity).where(eq(activity.ticketId, t.id));
    expect(notes.map((n) => n.summary).join("\n")).toContain(`"${KEY}" is not true`);
  });

  it("fact false on one step of two: the other step still goes out", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Guard line");
    await raiseOwnerSetup(ctx.db, { companyId: ctx.companyId, tickets: [tk(t.id, t.title)], steps: ["Open Settings → Server and runner.", ...STEPS], commit: "a".repeat(40), facts: { when: { [KEY]: false } } });
    const [card] = await cards(ctx);
    expect(card!.question).toContain("1. Open Settings → Server and runner.");
    expect(card!.question).not.toContain("2.");
  });

  it("fact that can't be settled: the CEO gets a card, the owner none", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Guard line");
    const row = await raiseOwnerSetup(ctx.db, { companyId: ctx.companyId, tickets: [tk(t.id, t.title)], steps: STEPS, commit: "a".repeat(40), facts: { when: { [KEY]: null } } });
    expect(row).toBeNull();
    const all = await cards(ctx);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ tier: "ceo", status: "open" });
    expect(all[0]!.question).toContain(KEY);
  });

  it("an unknown fact at go-live goes to the CEO too", async () => {
    ctx = await setup();
    const t = await ctx.ticket("Guard line");
    await raiseOwnerSetup(ctx.db, { companyId: ctx.companyId, tickets: [tk(t.id, t.title)], steps: ["[when the moon is full] Press Save."], commit: "a".repeat(40), facts: { when: {} } });
    expect((await cards(ctx)).map((c) => c.tier)).toEqual(["ceo"]);
  });
});
