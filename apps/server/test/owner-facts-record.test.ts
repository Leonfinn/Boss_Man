// BOS-1596: owner-side facts come from the record. The CEO said a check worker was "set up but idle" while none had
// ever connected; the record (check_workers.last_seen_at) says what is true, and text that contradicts it is held.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { checkWorkers, projects, settings } from "../src/db/schema.js";
import { buildBrief } from "../src/services/brief.js";
import { checkAsk } from "../src/services/decisions.js";
import { fillOwnerSetupTokens, gitTokenActionsProbe, ownerFactHeld, ownerFactHeldLive, ownerSetupFacts, workersLine, type GitTokenProbe } from "../src/services/owner-record.js";

let ctx: Awaited<ReturnType<typeof setup>>;
async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const co = (await built.app.inject({ method: "POST", url: "/api/companies", headers: { cookie }, payload: { name: "App Co" } })).json() as { company: { id: string } };
  const addWorker = (lastSeenAt: Date | null, companyIds: string[] = [co.company.id]) => db.insert(checkWorkers).values({ name: `w-${randomUUID().slice(0, 4)}`, tokenHash: randomUUID(), lastSeenAt, companyIds });
  return { ...built, db, close, companyId: co.company.id, addWorker };
}
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await ctx.app.close();
  await ctx.close();
});

const IDLE = "Your existing check worker is set up but idle; it needs redoing.";

describe("owner's setup facts", () => {
  it("counts a worker as installed only once it has been seen", async () => {
    expect((await ownerSetupFacts(ctx.db, ctx.companyId)).checkWorkers).toMatchObject({ added: 0, everConnected: 0, online: 0 });
    await ctx.addWorker(null);
    expect((await ownerSetupFacts(ctx.db, ctx.companyId)).checkWorkers).toMatchObject({ added: 1, everConnected: 0 });
    await ctx.addWorker(new Date());
    const f = await ownerSetupFacts(ctx.db, ctx.companyId);
    expect(f.checkWorkers).toMatchObject({ added: 2, everConnected: 1 });
    expect(workersLine(f)).toMatch(/^Check workers: 2 added · 1 ever connected · 0 online$/);
  });

  it("is in server_status and in the CEO brief", async () => {
    await ctx.addWorker(null);
    const status = (await ctx.serverStatus.status(ctx.companyId)) as { ownerSetup: { checkWorkers: { added: number; everConnected: number } } };
    expect(status.ownerSetup.checkWorkers).toMatchObject({ added: 1, everConnected: 0 });
    const brief = await buildBrief(ctx.db, { companyId: ctx.companyId, agentId: null, role: "ceo", since: null, now: new Date(), plain: true });
    expect(brief).toContain("Check workers: 1 added · 0 ever connected · 0 online");
  });
});

describe("contradiction hold", () => {
  it("holds a worker claim the record contradicts, with the live value", async () => {
    const held = await ownerFactHeld(ctx.db, ctx.companyId, IDLE);
    expect(held).toMatch(/Not sent/);
    expect(held).toContain("Check workers: 0 added · 0 ever connected · 0 online");
    await ctx.addWorker(null); // added but never connected: still not installed
    expect(await ownerFactHeld(ctx.db, ctx.companyId, "Your worker is idle.")).toMatch(/1 added · 0 ever connected/);
    expect(await ownerFactHeld(ctx.db, ctx.companyId, "The second machine is ready.")).toMatch(/Not sent/);
  });

  it("lets first-install wording about a second machine through", async () => {
    expect(await ownerFactHeld(ctx.db, ctx.companyId, "Add a second machine in Settings.")).toBeNull();
    expect(await ownerFactHeld(ctx.db, ctx.companyId, "Do you have a second machine free?")).toBeNull();
  });

  it("holds a step asking to open Boss Man from outside the network until a public address is set", async () => {
    const STEP = "On your phone, switch off Wi-Fi and open Boss Man from outside your Tailscale network.";
    expect(await ownerFactHeld(ctx.db, ctx.companyId, STEP)).toMatch(/no public address is set/);
    expect(await ownerFactHeld(ctx.db, ctx.companyId, "Open Boss Man on mobile data.")).toMatch(/Not sent/);
    expect(await ownerFactHeld(ctx.db, ctx.companyId, "Open Boss Man on your home network.")).toBeNull();
    await ctx.db.insert(settings).values({ key: "notifications", value: { publicUrl: "https://boss.example.com" } });
    expect(await ownerFactHeld(ctx.db, ctx.companyId, STEP)).toBeNull();
  });

  it("counts only workers granted to this company", async () => {
    await ctx.addWorker(new Date(), ["00000000-0000-0000-0000-000000000000"]); // another company's worker
    await ctx.addWorker(new Date(), []); // granted to nobody
    expect((await ownerSetupFacts(ctx.db, ctx.companyId)).checkWorkers).toMatchObject({ added: 0, everConnected: 0 });
    expect(await ownerFactHeld(ctx.db, ctx.companyId, IDLE)).toMatch(/Not sent/);
    await ctx.addWorker(new Date());
    expect(await ownerFactHeld(ctx.db, ctx.companyId, IDLE)).toBeNull();
  });

  it("lets the text through when the record agrees, the claim is an instruction, or it is about something else", async () => {
    expect(await ownerFactHeld(ctx.db, ctx.companyId, "Add your worker in Settings, then press Start.")).toBeNull();
    expect(await ownerFactHeld(ctx.db, ctx.companyId, "The runner is idle and the queue is empty.")).toBeNull();
    expect(await ownerFactHeld(ctx.db, ctx.companyId, undefined, "")).toBeNull();
    await ctx.addWorker(new Date());
    expect(await ownerFactHeld(ctx.db, ctx.companyId, IDLE)).toBeNull();
  });
});

describe("git token fact (R34, BOS-1670)", () => {
  const OFFER = "Do you want to give the GitHub token Actions access so Boss Man can read CI test logs?";
  const yes: GitTokenProbe = async () => "yes";

  it("holds an offer to change the token while the live probe says it can read Actions", async () => {
    const held = await ownerFactHeldLive(ctx.db, ctx.companyId, yes, [OFFER]);
    expect(held).toMatch(/^Not sent/);
    expect(held).toContain("can read GitHub Actions runs");
    expect(await ownerFactHeldLive(ctx.db, ctx.companyId, yes, ["The token has no Actions permission, so CI can't be read."])).toMatch(/Not sent/);
    expect(await ownerFactHeldLive(ctx.db, ctx.companyId, yes, ["Give Actions: Read access to the token."])).toMatch(/Not sent/);
  });

  it("lets the ask through when the probe says no, can't tell, or is absent", async () => {
    expect(await ownerFactHeldLive(ctx.db, ctx.companyId, async () => "no", [OFFER])).toBeNull();
    expect(await ownerFactHeldLive(ctx.db, ctx.companyId, async () => "unknown", [OFFER])).toBeNull();
    expect(await ownerFactHeldLive(ctx.db, ctx.companyId, async () => { throw new Error("boom"); }, [OFFER])).toBeNull();
    expect(await ownerFactHeldLive(ctx.db, ctx.companyId, undefined, [OFFER])).toBeNull();
  });

  it("lets true statements and unrelated token talk through, and doesn't call the probe for them", async () => {
    let calls = 0;
    const probe: GitTokenProbe = async () => (calls++, "yes");
    expect(await ownerFactHeldLive(ctx.db, ctx.companyId, probe, ["The token can read Actions runs and CI logs."])).toBeNull();
    expect(await ownerFactHeldLive(ctx.db, ctx.companyId, probe, ["Please paste a new database password."])).toBeNull();
    expect(calls).toBe(0);
  });

  it("the real probe reads GitHub once, caches the answer, and says unknown when the read is refused", async () => {
    await ctx.db.insert(projects).values({ companyId: ctx.companyId, name: "Site", repoUrl: "https://github.com/example/site", gitHost: "github", gitApiBase: "https://api.github.com" });
    let reads = 0;
    let result: { ok: boolean; canReadChecks?: boolean } = { ok: true, canReadChecks: true };
    let at = 1_000_000;
    const probe = gitTokenActionsProbe({ db: ctx.db, gitHosts: { checkAccess: async () => (reads++, result) }, gitToken: async () => "ghp_made_up", now: () => new Date(at) });
    expect(await probe(ctx.companyId)).toBe("yes");
    expect(await probe(ctx.companyId)).toBe("yes");
    expect(reads).toBe(1); // cached
    at += 11 * 60_000;
    result = { ok: true, canReadChecks: false };
    expect(await probe(ctx.companyId)).toBe("no");
    at += 11 * 60_000;
    result = { ok: false };
    expect(await probe(ctx.companyId)).toBe("unknown");
    const noToken = gitTokenActionsProbe({ db: ctx.db, gitHosts: { checkAccess: async () => result }, gitToken: async () => undefined });
    expect(await noToken(ctx.companyId)).toBe("unknown");
  });
});

describe("card placeholders", () => {
  it("fills {{checkWorkers.…}} from the record and refuses an unknown key", async () => {
    await ctx.addWorker(new Date());
    const facts = await ownerSetupFacts(ctx.db, ctx.companyId);
    expect(fillOwnerSetupTokens(["Workers: {{checkWorkers.added}} added, {{checkWorkers.everConnected}} seen, {{ checkWorkers.online }} online"], facts)).toEqual({ steps: ["Workers: 1 added, 1 seen, 0 online"], missing: [] });
    expect(fillOwnerSetupTokens(["{{checkWorkers.bogus}}"], facts).missing).toEqual(["bogus"]);
    const tried = "Looked at server_status and the Settings page myself; only the owner can add a machine.";
    const ok = checkAsk({ triedFirst: tried, why: "The owner sees the worker count.", minutes: 2, steps: ["Open Settings → Server and runner → Checks. It lists {{checkWorkers.added}} workers."], ownerSetup: facts, options: ["Done"] });
    expect(ok.steps?.[0]).toContain("lists 1 workers");
    expect(checkAsk({ triedFirst: tried, why: "The owner sees the worker count.", minutes: 2, steps: ["{{checkWorkers.bogus}}"], ownerSetup: facts, options: ["Done"] }).error).toMatch(/worker facts Boss Man doesn't have/);
  });
});
