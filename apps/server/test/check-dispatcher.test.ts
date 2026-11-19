import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { CHECK_QUEUE_MODE_KEY, checkQueue } from "../src/services/check-queue.js";
import { checkDispatcher } from "../src/services/check-dispatcher.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

async function setup(
  mode: "server" | "legacy" = "server",
  scanList?: () => Promise<string | null>,
  warning?: { log?: (m: string) => void; notify?: (n: { level: string; title: string; body: string; link: string }) => Promise<unknown>; isSet?: () => Promise<boolean> },
) {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(settings);
  if (mode === "server") await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
  const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
  const [r] = await db.insert(runners).values({ companyId: co!.id, tokenHash: `h${Math.random()}` } as never).returning();
  const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude", instructions: "x" } as never).returning();
  let n = 0;
  const ticket = async () => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: co!.id, projectId: p!.id, title: `T${n}`, number: n }).returning();
    return t!.id;
  };
  const sent: Array<{ runnerId: string; command: any }> = [];
  const woken: Array<{ agentId: string; note: string }> = [];
  let connected = true;
  let drain = false;
  const d = checkDispatcher(db, {
    drainPending: async () => drain,
    send: (runnerId, command) => (connected ? (sent.push({ runnerId, command }), true) : false),
    isConnected: () => connected,
    can: () => true,
    scanList,
    scanListWarning: warning,
    wake: async (agentId, w) => void woken.push({ agentId, note: w.note }),
  });
  const q = checkQueue(db);
  const req = async (tree: string, extra: Record<string, unknown> = {}) =>
    (await q.enqueue({ companyId: co!.id, projectId: p!.id, ticketId: await ticket(), kind: "pre_review", scope: "quick", commit: `c-${tree}`, tree, requestedBy: a!.id, ...extra } as never)).job;
  return { db, d, q, req, sent, woken, runner: r!, setConnected: (v: boolean) => (connected = v), setDrain: (v: boolean) => (drain = v) };
}

describe("check dispatcher", () => {
  it("hands no new check to a runner while a drain is pending, and starts it once the drain ends (BOS-1471)", async () => {
    const s = await setup();
    await s.req("dr1");
    s.setDrain(true);
    await s.d.pump();
    expect(s.sent).toHaveLength(0);
    expect((await s.q.list(s.runner.companyId)).rows.some((r) => r.state === "waiting")).toBe(true);
    s.setDrain(false);
    await s.d.pump();
    expect(s.sent).toHaveLength(1);
  });

  it("starts at most min(check_slots, the runner's reported slots) checks (BOS-1471)", async () => {
    const s = await setup();
    await s.db.insert(settings).values({ key: "check_slots", value: 3 });
    await s.d.onHello(s.runner.id, [], 1); // the runner runs one at a time, the setting says three
    await s.req("sl-a");
    await s.req("sl-b");
    await s.req("sl-c");
    await s.d.pump();
    expect(s.sent).toHaveLength(1);
    expect(s.d.runnerSlots(s.runner.id)).toBe(1);
    // After the runner is recreated and says 3, the other two start.
    await s.d.onHello(s.runner.id, [s.sent[0]!.command.jobId], 3);
    expect(s.sent).toHaveLength(3);
    // A runner that reports nothing (older image) is not capped.
    await s.d.onHello(s.runner.id, s.sent.map((x) => x.command.jobId));
    expect(s.d.runnerSlots(s.runner.id)).toBeUndefined();
  });

  it("R46: a free runner slot held by the update pause is listed as idle with its reason, keeps its start time, and clears once the job starts", async () => {
    const s = await setup();
    const job = await s.req("idle1");
    await s.db.insert(settings).values({ key: "deploy_wait", value: { phase: "waiting", approvedAt: new Date().toISOString() } });
    await s.d.pump();
    const [first] = s.d.idleSlots(s.runner.companyId);
    expect(first).toMatchObject({ jobId: job.id, code: "update_hold", expected: true, machine: "the company runner" });
    await s.d.pump();
    expect(s.d.idleSlots(s.runner.companyId)[0]!.since.getTime()).toBe(first!.since.getTime());
    await s.db.delete(settings).where(eq(settings.key, "deploy_wait"));
    await s.d.pump();
    expect(s.sent).toHaveLength(1);
    expect(s.d.idleSlots(s.runner.companyId)).toEqual([]);
  });

  it("does nothing in legacy mode", async () => {
    const s = await setup("legacy");
    await s.req("t1");
    await s.d.pump();
    expect(s.sent).toHaveLength(0);
  });

  it("hands the owner's private-details list to the runner with the job (BOS-979), and still runs without one", async () => {
    const s = await setup("server", async () => "ip\t192.0.2.77");
    await s.req("sl1", { kind: "merge" });
    await s.d.pump();
    expect(s.sent[0]!.command.scanList).toBe("ip\t192.0.2.77");
    const none = await setup("server", async () => null);
    await none.req("sl2", { kind: "merge" });
    await none.d.pump();
    expect(none.sent[0]!.command).not.toHaveProperty("scanList");
    const broken = await setup("server", async () => Promise.reject(new Error("no key")));
    await broken.req("sl3", { kind: "merge" });
    await broken.d.pump();
    expect(broken.sent[0]!.command.type).toBe("check.run");
    expect(broken.sent[0]!.command).not.toHaveProperty("scanList");
  });

  it("says so once when a set private-details list can't be read (BOS-1093)", async () => {
    const logs: string[] = [];
    const told: Array<{ title: string; body: string }> = [];
    const s = await setup(
      "server",
      async () => {
        throw new Error("the master key does not match");
      },
      { log: (m) => void logs.push(m), notify: async (n) => void told.push(n), isSet: async () => true },
    );
    await s.req("w1", { kind: "merge" });
    await s.d.pump();
    expect(s.sent[0]!.command).not.toHaveProperty("scanList");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("could not be read");
    expect(logs[0]).toContain("the master key does not match");
    expect(told).toHaveLength(1);
    // A second merge in the same streak doesn't warn or tell again.
    await s.req("w2", { kind: "merge" });
    await s.d.pump();
    expect(logs).toHaveLength(1);
    expect(told).toHaveLength(1);
  });

  it("tells again after the list reads fine and then breaks once more (BOS-1093)", async () => {
    let broken = true;
    const told: unknown[] = [];
    const s = await setup(
      "server",
      async () => {
        if (broken) throw new Error("the master key does not match");
        return "ip\t192.0.2.77";
      },
      { notify: async (n) => void told.push(n), isSet: async () => true },
    );
    await s.req("r1", { kind: "merge" });
    await s.d.pump();
    expect(told).toHaveLength(1);
    broken = false;
    await s.req("r2", { kind: "merge" });
    await s.d.pump();
    expect(told).toHaveLength(1);
    broken = true;
    await s.req("r3", { kind: "merge" });
    await s.d.pump();
    expect(told).toHaveLength(2);
  });

  it("stays silent when no private-details list is set (BOS-1093)", async () => {
    const logs: string[] = [];
    const told: unknown[] = [];
    const s = await setup("server", async () => null, { log: (m) => void logs.push(m), notify: async (n) => void told.push(n), isSet: async () => false });
    await s.req("silent", { kind: "merge" });
    await s.d.pump();
    expect(s.sent[0]!.command).not.toHaveProperty("scanList");
    expect(logs).toHaveLength(0);
    expect(told).toHaveLength(0);
  });

  it("does not hand the list to an agent-requested check (BOS-1043: no guessing oracle)", async () => {
    const s = await setup("server", async () => "ip\t192.0.2.77");
    await s.req("sl4"); // kind pre_review
    await s.d.pump();
    expect(s.sent[0]!.command.type).toBe("check.run");
    expect(s.sent[0]!.command).not.toHaveProperty("scanList");
  });

  it("gives a full job a longer time limit than a quick one", async () => {
    const s = await setup();
    const quick = await s.req("q1");
    await s.d.pump();
    expect(s.sent[0]!.command.timeoutMs).toBe(30 * 60_000);
    await s.d.onDone(s.runner.id, { jobId: quick.id, commit: quick.commit, exitCode: 0, timedOut: false, tail: "" });
    await s.req("f1", { scope: "full", kind: "merge" });
    await s.d.pump();
    expect(s.sent.find((m) => m.command.type === "check.run" && m.command.commit === "c-f1")!.command.timeoutMs).toBe(90 * 60_000);
  });

  it("starts one job per slot, then the next when the first ends, and wakes the requester", async () => {
    const s = await setup();
    const a = await s.req("t1");
    const b = await s.req("t2");
    await s.d.pump();
    expect(s.sent.map((m) => m.command.jobId)).toEqual([a.id]);
    await s.d.onDone(s.runner.id, { jobId: a.id, commit: a.commit, exitCode: 0, timedOut: false, tail: "ok" });
    expect(s.woken).toHaveLength(1);
    expect(s.woken[0]!.note).toContain("passed");
    expect(s.sent.map((m) => m.command.type)).toEqual(["check.run", "check.ack", "check.run"]);
    expect(s.sent[2]!.command.jobId).toBe(b.id);
  });

  it("ignores an answer for another commit, and still acknowledges it", async () => {
    const s = await setup();
    const a = await s.req("t1");
    await s.d.pump();
    await s.d.onDone(s.runner.id, { jobId: a.id, commit: "other", exitCode: 0, timedOut: false, tail: "" });
    const [row] = await (await shared).db.select().from(checkJobs);
    expect(row!.state).toBe("running");
    expect(s.woken).toHaveLength(0);
  });

  it("puts back in line a job the runner no longer lists after a restart, with a reason", async () => {
    const s = await setup();
    const a = await s.req("t1");
    await s.d.pump();
    s.sent.length = 0;
    await s.d.onHello(s.runner.id, []);
    // Re-queued (the queue service test pins the reason), then started again by the pump.
    expect(s.sent.map((m) => m.command.jobId)).toEqual([a.id]);
  });

  it("keeps a job the runner still lists", async () => {
    const s = await setup();
    const a = await s.req("t1");
    await s.d.pump();
    s.sent.length = 0;
    await s.d.onHello(s.runner.id, [a.id]);
    expect(s.sent).toHaveLength(0);
  });

  it("a runner that can't be reached leaves the job queued with a reason", async () => {
    const s = await setup();
    await s.req("t1");
    s.setConnected(false);
    await s.d.pump();
    const [row] = await (await shared).db.select().from(checkJobs);
    expect(row!.state).toBe("queued");
  });

  it("stuck jobs are cancelled on the runner and their agent is told why", async () => {
    const s = await setup();
    await s.req("t1");
    await s.d.pump();
    s.sent.length = 0;
    const stuck = await s.d.sweep(new Date(Date.now() + 25 * 60_000));
    expect(stuck).toHaveLength(1);
    expect(s.sent[0]!.command.type).toBe("check.cancel");
    expect(s.woken[0]!.note).toMatch(/stuck/);
  });

  it("a server cancel records the reason and wakes the requester", async () => {
    const s = await setup();
    const a = await s.req("t1");
    await s.d.pump();
    await s.d.cancel(a.id, "Cancelled by the owner.");
    expect(s.woken[0]!.note).toMatch(/Cancelled by the owner/);
  });
});
