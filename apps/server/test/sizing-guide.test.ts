// BOS-2810: sizingGuideText writes the sizing guide every planner reads before create_ticket
// (docs/19-workflow-retros.md part 6). This reads a real PGlite database directly, without buildApp,
// as check-hold.test.ts does: finished sized tickets under each size, the company's retro-made
// sizing playbook only when an agent still holds it, and the two length cuts.
import { afterAll, describe, expect, it } from "vitest";
import { TASK_SIZES } from "@boss-man/shared";
import { openPglite } from "../src/db/client.js";
import { agentSkills, agents, companies, projects, skills, tickets } from "../src/db/schema.js";
import { SIZING_PLAYBOOK_PREFIX, sizingGuideText } from "../src/services/sizing.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

const NOW = new Date("2026-11-27T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const D = 86_400_000;

let seq = 0;
const unique = (prefix: string) => `${prefix} ${++seq}`;

/** A company, a project and an agent, so finished tickets can carry a role. */
async function makeCompany() {
  const { db } = await shared;
  const [co] = await db.insert(companies).values({ name: unique("Sizing Co"), ticketPrefix: "TST" }).returning();
  const [project] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [agent] = await db.insert(agents).values({ companyId: co!.id, name: unique("Agent"), role: "worker", agentKind: "claude", template: "engineer" }).returning();
  return { db, companyId: co!.id, projectId: project!.id, agentId: agent!.id };
}

/** A finished, sized ticket: done one day ago, so it is inside the 90-day window. */
async function finishedTicket(
  db: Awaited<typeof shared>["db"],
  where: { companyId: string; projectId: string; agentId: string },
  patch: Partial<typeof tickets.$inferInsert> = {},
) {
  const [row] = await db
    .insert(tickets)
    .values({
      companyId: where.companyId,
      projectId: where.projectId,
      assigneeAgentId: where.agentId,
      number: ++seq,
      title: unique("A finished task"),
      systemState: "done",
      stateChangedAt: ago(D),
      size: 2,
      ...patch,
    })
    .returning();
  return row!;
}

/** A skill row whose SKILL.md holds `markdown`; source and name are what the playbook lookup reads. */
function skillRow(companyId: string, name: string, source: "written" | "retro", markdown: string, sizeBytes = markdown.length) {
  return {
    companyId,
    name,
    description: "A sizing playbook",
    source,
    files: [{ path: "SKILL.md", content: Buffer.from(markdown, "utf8").toString("base64") }],
    sizeBytes,
  };
}

const text = (db: Awaited<typeof shared>["db"], companyId: string) => sizingGuideText(db, companyId, () => NOW);

describe("sizingGuideText with no finished tickets", () => {
  it("gives a heading for every size, each saying there is no finished ticket of that size yet", async () => {
    const { db, companyId } = await makeCompany();
    const out = await text(db, companyId);
    for (const size of TASK_SIZES) {
      expect(out).toContain(`## Size ${size}`);
      expect(out).toContain("- No finished ticket of this size yet.");
    }
    expect(out).not.toContain("<untrusted source=\"ticket titles\">");
  });
});

describe("finished sized tickets", () => {
  it("puts a finished sized ticket under its own size, with its ref and title inside an untrusted block", async () => {
    const c = await makeCompany();
    const t = await finishedTicket(c.db, c, { size: 2, number: 42, title: "Wire the widget" });
    const out = await text(c.db, c.companyId);
    const sizeTwo = out.slice(out.indexOf("## Size 2"), out.indexOf("## Size 3"));
    expect(sizeTwo).toContain("<untrusted source=\"ticket titles\">");
    expect(sizeTwo).toContain(`TST-${t.number}`);
    expect(sizeTwo).toContain("Wire the widget");
    // Not under any other size.
    for (const size of TASK_SIZES.filter((s) => s !== 2)) {
      const start = out.indexOf(`## Size ${size}`);
      const next = TASK_SIZES[TASK_SIZES.indexOf(size) + 1];
      const end = next === undefined ? out.length : out.indexOf(`## Size ${next}`);
      expect(out.slice(start, end)).not.toContain("Wire the widget");
    }
  });

  it("leaves a ticket from another company out", async () => {
    const mine = await makeCompany();
    const other = await makeCompany();
    await finishedTicket(other.db, other, { size: 3, title: "The other company's secret task" });
    const out = await text(mine.db, mine.companyId);
    expect(out).not.toContain("The other company's secret task");
    expect(out).toContain("- No finished ticket of this size yet.");
  });
});

describe("the sizing playbook", () => {
  it("includes a retro skill whose name starts with the prefix and that an agent holds", async () => {
    const c = await makeCompany();
    const [skill] = await c.db
      .insert(skills)
      .values(skillRow(c.companyId, `${SIZING_PLAYBOOK_PREFIX}-engineer-playbook`, "retro", "Size a task by comparing it with BOS-7."))
      .returning();
    await c.db.insert(agentSkills).values({ agentId: c.agentId, skillId: skill!.id });
    const out = await text(c.db, c.companyId);
    expect(out).toContain(`## Sizing playbook "${SIZING_PLAYBOOK_PREFIX}-engineer-playbook"`);
    expect(out).toContain("Size a task by comparing it with BOS-7.");
  });

  it("leaves out the same skill when no agent holds it, and a non-retro skill named sizing...", async () => {
    const c = await makeCompany();
    await c.db.insert(skills).values(skillRow(c.companyId, `${SIZING_PLAYBOOK_PREFIX}-reverted-playbook`, "retro", "Nobody holds this any more."));
    const [written] = await c.db
      .insert(skills)
      .values(skillRow(c.companyId, `${SIZING_PLAYBOOK_PREFIX}-written-tips`, "written", "A written skill, not from a retro."))
      .returning();
    await c.db.insert(agentSkills).values({ agentId: c.agentId, skillId: written!.id });
    const out = await text(c.db, c.companyId);
    expect(out).not.toContain("Nobody holds this any more.");
    expect(out).not.toContain("A written skill, not from a retro.");
    expect(out).not.toContain("## Sizing playbook");
  });

  it("cuts a playbook longer than 2,500 characters at the mark", async () => {
    const c = await makeCompany();
    const long = "x".repeat(2600);
    const [skill] = await c.db
      .insert(skills)
      .values(skillRow(c.companyId, `${SIZING_PLAYBOOK_PREFIX}-long`, "retro", long))
      .returning();
    await c.db.insert(agentSkills).values({ agentId: c.agentId, skillId: skill!.id });
    const out = await text(c.db, c.companyId);
    expect(out).toContain("… cut");
    expect(out).not.toContain(long);
    expect(out).not.toContain("… cut: the rest is left out");
  });
});

describe("the output cap", () => {
  it("ends with the left-out line when the whole guide is longer than 6,000 characters", async () => {
    const c = await makeCompany();
    for (let i = 0; i < 3; i++) {
      const [skill] = await c.db
        .insert(skills)
        .values(skillRow(c.companyId, `${SIZING_PLAYBOOK_PREFIX}-bulk-${i}`, "retro", `${i} `.repeat(1300)))
        .returning();
      await c.db.insert(agentSkills).values({ agentId: c.agentId, skillId: skill!.id });
    }
    const out = await text(c.db, c.companyId);
    expect(out.length).toBeGreaterThan(6000);
    expect(out.endsWith("… cut: the rest is left out to keep this short.")).toBe(true);
  });
});
