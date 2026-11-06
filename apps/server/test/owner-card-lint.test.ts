import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { decisions } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { checkAsk } from "../src/services/decisions.js";
import { lintOwnerSteps, sh, step, type CardLint } from "../src/services/steps.js";

// The owner-step lint (BOS-417, DR-008 Q1): cards with steps for the owner are checked when they are raised.

const TRIED = "Checked the host from the runner; agents have no access to the owner's machine.";
const rules = (steps: string[]) => lintOwnerSteps(steps).refuse.map((f) => `${f.step}:${f.rule}`);

describe("lintOwnerSteps", () => {
  it("refuses a step that points to another document (the 14:45 card)", () => {
    expect(rules(["Follow docs/06 with changes for the new host."])).toEqual(["1:R1"]);
    for (const s of ["See the install guide for the folder.", "The folder is in docs/06-install-truenas.md.", "Do it as before.", "Repeat step 3 of the move runbook.", "Use the commands on the previous card.", "Follow [[engineering/move]]."])
      expect(rules([s]), s).toContain("1:R1");
  });

  it("refuses a variable no step up to there sets (the $BOSSMAN_HOME card)", () => {
    expect(rules([step("Go to the install folder:", sh("cd $BOSSMAN_HOME"))])).toEqual(["1:R2"]);
    expect(rules([step("Go there:", sh("cd ${BOSSMAN_HOME}/src"))])).toEqual(["1:R2"]);
    // Unfenced, in a sentence, it is still a command the owner will paste.
    expect(rules(["Run sudo ls $BOSSMAN_HOME on the new host."])).toEqual(["1:R2"]);
    // Set later is set too late.
    expect(rules([step("Go:", sh("cd $DIR")), step("Set it:", sh("DIR=/srv/bm"))])).toEqual(["1:R2"]);
  });

  it("accepts variables the card sets, inline assignments, and shell text that isn't a variable", () => {
    const ok = [
      step("Set the folder:", sh("export DIR=/srv/bm")),
      step("Go there:", sh("cd $DIR/src && ls")),
      step("Build with a flag set just for this command:", sh("DOCKER_BUILDKIT=1 docker compose build")),
      step("Same command, inline:", sh("COMPOSE_FILE=a.yml docker compose ps && echo $COMPOSE_FILE")),
      step("Print the second column:", sh("docker ps | awk '{print $2}'")),
      step("Count:", sh("for f in a b; do echo $f; done")),
      step("Show home, the exit code and a default:", sh('echo "$HOME $? ${PORT:-3100} $(date) $1"')),
      step("Ask for it:", sh("read -r NAME && echo $NAME")),
      "Open Settings → Server and runner → Updates and press Build and update runners. It costs $5 a month.",
      "Follow the instructions on the screen to sign in.",
    ];
    expect(lintOwnerSteps(ok).refuse).toEqual([]);
  });

  it("refuses a command the owner would have to edit, and an unfilled {{token}}", () => {
    expect(rules(["Run this:\n\n```sh\nssh root@<host-ip>\n```"])).toEqual(["1:R3"]);
    expect(rules(["Run `scp YOUR_KEY root@nas:/x` on the old host."])).toEqual(["1:R3"]);
    expect(rules(["Run this:\n\n```sh\n$ ls\n```"])).toEqual(["1:R3"]);
    expect(rules(["Go there:\n\n```sh\ncd {{host.srcDir}}\n```"])).toEqual(["1:R4"]);
  });

  it("only warns about links, several commands in one step, hedging and long cards", () => {
    const r = lintOwnerSteps([
      "Background is on BOS-276; open Settings → Server and runner.",
      step("Check it:", sh("docker ps"), "Then:", sh("docker logs server-blue")),
      step("It should be green by now:", sh("docker ps")),
    ]);
    expect(r.refuse).toEqual([]);
    expect(r.warn.map((f) => f.step)).toEqual([1, 2, 3]);
    expect(lintOwnerSteps(Array.from({ length: 13 }, () => "Open Settings.")).warn).toHaveLength(1);
  });
});

describe("checkAsk with the lint", () => {
  const bad = ["Follow docs/06 for the folder."];
  it("returns the refusal with the step and the reason", () => {
    const r = checkAsk({ triedFirst: TRIED, ownerMustDo: true, steps: bad });
    expect(r.error).toMatch(/Step 1: points to a doc in docs\/ \("docs\/06"\)/);
    expect(r.error).not.toMatch(/lintOverride/);
  });

  it("lets only the CEO override, with a reason, and keeps what it let through", () => {
    expect(checkAsk({ triedFirst: TRIED, steps: bad, lintOverride: "The doc is right this time." }).error).toMatch(/Only the CEO/);
    expect(checkAsk({ triedFirst: TRIED, steps: bad, lintOverride: "ok", byCeo: true }).error).toMatch(/at least 10/);
    expect(checkAsk({ triedFirst: TRIED, steps: bad, byCeo: true }).error).toMatch(/pass lintOverride/);
    const r = checkAsk({ triedFirst: TRIED, steps: bad, lintOverride: "  The owner asked for the doc  reference. ", byCeo: true });
    expect(r.error).toBeNull();
    expect(r.lint?.override).toEqual({ reason: "The owner asked for the doc reference.", findings: [expect.objectContaining({ step: 1, rule: "R1" })] });
  });

  it("never lets an override through a command that isn't copy-safe", () => {
    const r = checkAsk({ triedFirst: TRIED, steps: ["Run `ssh root@<host-ip>`."], lintOverride: "Urgent, the owner knows the address.", byCeo: true });
    expect(r.error).toMatch(/placeholder/);
  });
});

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  ctx?.clients.forEach((c) => void c.close());
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "POST", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company, ceo } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string }; ceo: { id: string } };
  const worker = (await req("POST", `/api/companies/${company.id}/agents`, { name: "Engineer" })).json() as { id: string };
  const clients: Client[] = [];
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId: company.id, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  return { ...built, db, close, company, ceo, worker, mcp, clients };
}

const textOf = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]?.text ?? "");
const isError = (r: unknown) => (r as { isError?: boolean }).isError === true;

describe("raise_decision checks the owner's steps", () => {
  const card = (steps: string[], extra: Record<string, unknown> = {}) => ({ question: "Move Boss Man to the new host?", options: ["Done", "It failed"], recommended: "Done", triedFirst: TRIED, ownerMustDo: true, steps, ...extra });

  it("refuses an agent's card that says follow docs/06 or uses an unset variable, and raises nothing", async () => {
    const c = (ctx = await setup());
    const m = await c.mcp(c.worker.id);
    const doc = await m.callTool({ name: "raise_decision", arguments: card(["Follow docs/06 with changes on the new host."]) });
    expect(isError(doc)).toBe(true);
    expect(textOf(doc)).toMatch(/Step 1: points to a doc/);
    const unset = await m.callTool({ name: "raise_decision", arguments: card([step("Copy the backups:", sh("sudo cp -a $BOSSMAN_HOME/backups /mnt/new"))]) });
    expect(isError(unset)).toBe(true);
    expect(textOf(unset)).toMatch(/\$BOSSMAN_HOME, which no step up to here sets/);
    // An agent that isn't the CEO can't override.
    const forced = await m.callTool({ name: "raise_decision", arguments: card(["Follow docs/06."], { lintOverride: "I am sure the doc is right." }) });
    expect(textOf(forced)).toMatch(/Only the CEO/);
    expect(await c.db.select().from(decisions)).toHaveLength(0);
  });

  it("raises a good card with its warnings stored, and a CEO override with its reason", async () => {
    const c = (ctx = await setup());
    const w = await c.mcp(c.worker.id);
    const ok = await w.callTool({ name: "raise_decision", arguments: card([step("On the new host, list the containers (background on BOS-276):", sh("DOCKER_HOST=unix:///run/docker.sock docker ps"))]) });
    expect(isError(ok)).toBe(false);
    const ceo = await c.mcp(c.ceo.id);
    const over = await ceo.callTool({ name: "raise_decision", arguments: card(["Follow docs/06 on the new host."], { question: "Install on the new host?", lintOverride: "The owner asked to be pointed at the guide." }) });
    expect(isError(over)).toBe(false);
    const rows = await c.db.select().from(decisions);
    const lintOf = (q: string) => (rows.find((d) => d.question === q)!.context as { lint?: CardLint }).lint;
    expect(lintOf("Move Boss Man to the new host?")!.warn).toEqual([expect.objectContaining({ step: 1, rule: "warn", problem: expect.stringMatching(/links to a wiki page or ticket/) })]);
    expect(lintOf("Install on the new host?")!.override).toMatchObject({ reason: "The owner asked to be pointed at the guide.", findings: [{ step: 1, rule: "R1" }] });
    // The CEO's list shows both.
    const list = textOf(await ceo.callTool({ name: "decisions", arguments: { action: "list" } }));
    expect(list).toMatch(/Boss Man flagged its steps/);
    expect(list).toMatch(/Lint overridden by the CEO: [\s\S]*The owner asked to be pointed at the guide\./);
  });
});
