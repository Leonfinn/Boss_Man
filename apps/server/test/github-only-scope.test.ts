// BOS-2764: the database reads behind R40's GitHub-only reds.
// githubOnlyScope turns a project's main-CI failures into the scope of the red a fix ticket is for; waitsOnFix
// then decides whether a waiting ticket's stored diff files touch that scope. Short reads against the in-memory
// test database. mainCiFailures is already named in main-ci.test.ts, so it is not repeated here.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPglite, type Db } from "../src/db/client.js";
import { companies, projects, settings, tickets } from "../src/db/schema.js";
import { githubOnlyScope, waitsOnFix } from "../src/services/review-holds.js";

let db: Db;
let close: () => Promise<void>;

beforeEach(async () => {
  const opened = await openPglite();
  db = opened.db;
  close = opened.close;
});

afterEach(async () => {
  await close();
});

type Failure = { ticketId: string; workflow: string; runs: string[]; scope: string[] | null };

async function makeProject(mainState = "unknown") {
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev", mainState }).returning();
  return { companyId: co!.id, projectId: p!.id };
}

async function makeTicket(companyId: string, projectId: string, diffFiles: string[] = []) {
  const [t] = await db.insert(tickets).values({ companyId, projectId, title: "T", diffFiles }).returning();
  return t!.id;
}

/** Writes the project's main-CI state: one open failure per entry, the way the watcher stores it. */
async function setFailures(projectId: string, failures: Failure[]) {
  const open: Record<string, Failure> = {};
  failures.forEach((f, i) => {
    open[`failure-${i}`] = f;
  });
  await db.insert(settings).values({ key: `main_ci:${projectId}`, value: { open } });
}

const failure = (ticketId: string, scope: string[] | null): Failure => ({ ticketId, workflow: "CI", runs: ["1"], scope });

describe("githubOnlyScope", () => {
  it("gives null when the project does not exist", async () => {
    expect(await githubOnlyScope(db, randomUUID(), randomUUID())).toBeNull();
  });

  it("gives null when the project's main state is red", async () => {
    const { projectId } = await makeProject("red");
    const fixId = randomUUID();
    await setFailures(projectId, [failure(fixId, ["apps/server/"])]);
    expect(await githubOnlyScope(db, projectId, fixId)).toBeNull();
  });

  it("gives null when no open failure names the fix ticket", async () => {
    const { projectId } = await makeProject("green");
    const fixId = randomUUID();
    await setFailures(projectId, [failure(randomUUID(), ["apps/server/"])]);
    expect(await githubOnlyScope(db, projectId, fixId)).toBeNull();
  });

  it("gives null when a failure for the fix has no scope recorded", async () => {
    const { projectId } = await makeProject("green");
    const fixId = randomUUID();
    await setFailures(projectId, [failure(fixId, ["apps/server/"]), failure(fixId, null)]);
    expect(await githubOnlyScope(db, projectId, fixId)).toBeNull();
  });

  it("gives null when a failure for the fix has an empty scope", async () => {
    const { projectId } = await makeProject("green");
    const fixId = randomUUID();
    await setFailures(projectId, [failure(fixId, ["apps/server/"]), failure(fixId, [])]);
    expect(await githubOnlyScope(db, projectId, fixId)).toBeNull();
  });

  it("gives the union of the fix's scopes, with duplicates removed and sorted", async () => {
    const { projectId } = await makeProject("green");
    const fixId = randomUUID();
    await setFailures(projectId, [failure(fixId, ["apps/server/", "packages/shared/"]), failure(fixId, ["apps/server/", ".github/workflows/ci.yml"])]);
    expect(await githubOnlyScope(db, projectId, fixId)).toEqual([".github/workflows/ci.yml", "apps/server/", "packages/shared/"]);
  });

  it("does not count a failure filed on another ticket", async () => {
    const { projectId } = await makeProject("green");
    const fixId = randomUUID();
    // The other ticket's failure has an unknown scope: it must neither widen the fix's scope nor make it null.
    await setFailures(projectId, [failure(fixId, ["apps/server/"]), failure(randomUUID(), null)]);
    expect(await githubOnlyScope(db, projectId, fixId)).toEqual(["apps/server/"]);
  });
});

describe("waitsOnFix", () => {
  async function projectWithScope(scope: string[] | null = ["apps/server/"]) {
    const { companyId, projectId } = await makeProject("green");
    const fixId = randomUUID();
    await setFailures(projectId, [failure(fixId, scope)]);
    return { companyId, projectId, fixId };
  }

  it("waits when there is no known scope", async () => {
    // A red project makes githubOnlyScope null, so every ticket waits, whatever its files.
    const { companyId, projectId } = await makeProject("red");
    const fixId = randomUUID();
    await setFailures(projectId, [failure(fixId, ["apps/server/"])]);
    const ticketId = await makeTicket(companyId, projectId, ["apps/web/src/page.tsx"]);
    expect(await waitsOnFix(db, { id: ticketId, projectId }, fixId)).toBe(true);
  });

  it("waits when a stored diff file is under a scope prefix", async () => {
    const { companyId, projectId, fixId } = await projectWithScope(["apps/server/"]);
    const ticketId = await makeTicket(companyId, projectId, ["apps/server/src/services/review-holds.ts"]);
    expect(await waitsOnFix(db, { id: ticketId, projectId }, fixId)).toBe(true);
  });

  it("waits when a stored diff file is at the repo root", async () => {
    const { companyId, projectId, fixId } = await projectWithScope(["apps/server/"]);
    const ticketId = await makeTicket(companyId, projectId, ["package.json"]);
    expect(await waitsOnFix(db, { id: ticketId, projectId }, fixId)).toBe(true);
  });

  it("waits when a stored diff file is under .github/", async () => {
    const { companyId, projectId, fixId } = await projectWithScope(["apps/server/"]);
    const ticketId = await makeTicket(companyId, projectId, [".github/workflows/ci.yml"]);
    expect(await waitsOnFix(db, { id: ticketId, projectId }, fixId)).toBe(true);
  });

  it("does not wait when the stored diff files are outside the scope", async () => {
    const { companyId, projectId, fixId } = await projectWithScope(["apps/server/"]);
    const ticketId = await makeTicket(companyId, projectId, ["apps/web/src/page.tsx"]);
    expect(await waitsOnFix(db, { id: ticketId, projectId }, fixId)).toBe(false);
  });

  it("waits when the stored diff files are empty (unknown)", async () => {
    const { companyId, projectId, fixId } = await projectWithScope(["apps/server/"]);
    const ticketId = await makeTicket(companyId, projectId, []);
    expect(await waitsOnFix(db, { id: ticketId, projectId }, fixId)).toBe(true);
  });
});
