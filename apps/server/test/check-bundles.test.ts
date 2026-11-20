// BOS-1436 (DR-060 part 2): a check job's code goes to its check worker as a git bundle through the server. Three layers:
// the bundle folder (caps, hashes, only its own files touched), the upload/download routes (who may put and get what), and
// the dispatcher's steps around them (pack, re-send in full once, give up to another machine). PGlite and the real queue;
// the runner's packing itself is covered with real git in apps/runner/test/check-bundle.test.ts.
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { CheckBundleInfo } from "@boss-man/shared";
import { openPglite } from "../src/db/client.js";
import { agents, checkJobs, checkWorkers, companies, projects, runners, settings, tickets } from "../src/db/schema.js";
import { CHECK_QUEUE_MODE_KEY, CHECK_SLOTS_KEY, checkQueue } from "../src/services/check-queue.js";
import { checkDispatcher } from "../src/services/check-dispatcher.js";
import { BUNDLE_FEATURE, checkWorkersService } from "../src/services/check-workers.js";
import { checkBundleStore } from "../src/services/check-bundles.js";
import { checkBundleRoutes } from "../src/routes/check-bundles.js";
import type { WaitKind } from "../src/services/update-waits.js";

const shared = openPglite();
afterAll(async () => (await shared).close());

const COMMIT = "a".repeat(40);
const dirs: string[] = [];
const scratchDir = () => {
  const d = mkdtempSync(path.join(tmpdir(), "bm-bundles-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("check bundle folder (BOS-1436)", () => {
  it("stores an upload, hands it back, and removes it", async () => {
    const store = checkBundleStore({ dir: scratchDir() });
    const id = randomUUID();
    const body = Buffer.from("bundle bytes");
    expect(await store.put(id, Readable.from([body]), { declared: body.length, sha256: sha(body) })).toEqual({ ok: true, bytes: body.length, sha256: sha(body) });
    expect(store.has(id)).toBe(true);
    const got = store.open(id)!;
    expect(got.bytes).toBe(body.length);
    const chunks: Buffer[] = [];
    for await (const c of got.stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("bundle bytes");
    store.remove(id);
    expect(store.open(id)).toBeNull();
  });

  it("refuses a bundle over the per-bundle cap, by its declared size and by what actually arrives, and leaves nothing behind", async () => {
    const dir = scratchDir();
    const store = checkBundleStore({ dir, maxBytes: 10, totalBytes: 1000 });
    expect(await store.put(randomUUID(), Readable.from([Buffer.alloc(11)]), { declared: 11 })).toMatchObject({ ok: false, status: 413 });
    // No (or a false) declared size: the count as it streams stops it.
    expect(await store.put(randomUUID(), Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), {})).toMatchObject({ ok: false, status: 413 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("refuses an upload that would take the folder over its total cap (507)", async () => {
    const store = checkBundleStore({ dir: scratchDir(), maxBytes: 100, totalBytes: 150 });
    expect((await store.put(randomUUID(), Readable.from([Buffer.alloc(100)]), { declared: 100 })).ok).toBe(true);
    expect(await store.put(randomUUID(), Readable.from([Buffer.alloc(60)]), { declared: 60 })).toMatchObject({ ok: false, status: 507 });
  });

  it("refuses a body whose hash or length isn't what the uploader said (400), keeping nothing", async () => {
    const dir = scratchDir();
    const store = checkBundleStore({ dir });
    const id = randomUUID();
    expect(await store.put(id, Readable.from([Buffer.from("abc")]), { sha256: "0".repeat(64) })).toMatchObject({ ok: false, status: 400 });
    expect(await store.put(id, Readable.from([Buffer.from("abc")]), { declared: 4 })).toMatchObject({ ok: false, status: 400 });
    expect(store.has(id)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("names files only by job id: anything else is refused, and the sweep and clear touch only its own files", async () => {
    const dir = scratchDir();
    const store = checkBundleStore({ dir });
    await expect(store.put("../etc/passwd", Readable.from([Buffer.from("x")]))).rejects.toThrow(/not a job id/);
    expect(() => store.open("../x")).toThrow(/not a job id/);
    store.remove("../x"); // a no-op, never a path
    const keep = randomUUID();
    const drop = randomUUID();
    await store.put(keep, Readable.from([Buffer.from("k")]));
    await store.put(drop, Readable.from([Buffer.from("d")]));
    writeFileSync(path.join(dir, `${randomUUID()}.bundle.part`), "half");
    // A folder pointed somewhere shared: other files stay.
    writeFileSync(path.join(dir, "someone-elses.txt"), "mine");
    const gone = store.sweep(new Set([keep]));
    expect(gone).toContain(drop);
    expect(readdirSync(dir).sort()).toEqual([`${keep}.bundle`, "someone-elses.txt"].sort());
    store.clear();
    expect(readdirSync(dir)).toEqual(["someone-elses.txt"]);
  });
});

/** A company with a runner, a project, a ticket, a worker, and one job running on that worker. */
async function world() {
  const { db } = await shared;
  await db.delete(checkJobs);
  await db.delete(checkWorkers);
  await db.delete(settings);
  await db.insert(settings).values({ key: CHECK_QUEUE_MODE_KEY, value: "server" });
  await db.insert(settings).values({ key: CHECK_SLOTS_KEY, value: 1 });
  const company = async () => {
    const [co] = await db.insert(companies).values({ name: `Co ${Math.random()}` }).returning();
    const [p] = await db.insert(projects).values({ companyId: co!.id, name: "Dev" }).returning();
    const [r] = await db.insert(runners).values({ companyId: co!.id, tokenHash: `h${Math.random()}`, imageCommit: COMMIT } as never).returning();
    const [a] = await db.insert(agents).values({ companyId: co!.id, name: "A", role: "worker", agentKind: "claude", instructions: "x" } as never).returning();
    return { id: co!.id, projectId: p!.id, runnerId: r!.id, agentId: a!.id };
  };
  const co = await company();
  const q = checkQueue(db);
  let n = 0;
  const req = async (c = co, extra: Record<string, unknown> = {}) => {
    n++;
    const [t] = await db.insert(tickets).values({ companyId: c.id, projectId: c.projectId, title: `T${n}`, number: n }).returning();
    return (await q.enqueue({ companyId: c.id, projectId: c.projectId, ticketId: t!.id, kind: "pre_review", scope: "quick", commit: `${n}`.padStart(40, "c"), tree: `tree-${n}-${Math.random()}`, requestedBy: c.agentId, ...extra } as never)).job;
  };
  const workers = checkWorkersService(db);
  const toWorker: Array<{ workerId: string; command: any }> = [];
  const worker = async (slots = 1) => {
    const { worker: w } = await workers.register({ name: `W${Math.random()}`, companyIds: [co.id], slots, checkThreads: null, checkMemoryMb: null, enabled: true });
    const features = ["check-jobs", BUNDLE_FEATURE];
    await workers.touch(w.id, { imageCommit: COMMIT, imageVersion: "1", features });
    workers.connect(w.id, (command) => (toWorker.push({ workerId: w.id, command }), true), () => {}, features);
    return { id: w.id, name: w.name };
  };
  const job = async (id: string) => (await db.select().from(checkJobs).where(eq(checkJobs.id, id)))[0]!;
  return { db, co, company, q, req, workers, worker, toWorker, job };
}

const INFO: CheckBundleInfo = { sha256: "f".repeat(64), bytes: 1, mainRef: "refs/remotes/origin/main", mainCommit: COMMIT, empty: false };
const ran = <T extends { command: any }>(sent: T[]) => sent.filter((s) => s.command.type === "check.run");

describe("check bundle dispatch (BOS-1436)", () => {
  /** The runner takes no checks itself (so jobs go to the worker) unless `runnerTakes`; packing is scripted per call. */
  async function setup(o: { pack?: (cmd: any) => Promise<CheckBundleInfo>; canPack?: boolean } = {}) {
    const w0 = await world();
    const packs: any[] = [];
    const removed: string[] = [];
    let runnerTakes = false;
    let drain: WaitKind | null = null;
    const toRunner: any[] = [];
    const d = checkDispatcher(w0.db, {
      drainPending: async () => drain,
      send: (_id, c) => (toRunner.push(c), true),
      isConnected: () => true,
      can: () => runnerTakes,
      workers: w0.workers,
      bundles: {
        store: { remove: (id) => void removed.push(id), sweep: () => [] },
        canPack: () => o.canPack ?? true,
        pack: async (_runnerId, cmd) => {
          packs.push(cmd);
          return o.pack ? o.pack(cmd) : INFO;
        },
      },
    });
    const pump = async () => {
      await d.pump();
      await d.settled();
    };
    return { ...w0, d, packs, removed, toRunner, pump, runnerTakes: (v: boolean) => (runnerTakes = v), setDrain: (k: WaitKind | null) => (drain = k) };
  }

  it("BOS-2108: during a runner drain the worker keeps taking quick checks; the runner, merge and full checks wait for the swap", async () => {
    const s = await setup();
    s.runnerTakes(true);
    const w = await s.worker(3);
    const merge = await s.req(s.co, { kind: "merge" });
    const full = await s.req(s.co, { scope: "full" });
    const quick = await s.req();
    for (const kind of ["runner-drain", "owner-force"] as const) {
      s.setDrain(kind);
      await s.pump();
      // Before BOS-2108 pump() returned at once: the worker's free slots sat idle for the whole drain (BOS-2106).
      expect(ran(s.toWorker)).toEqual([{ workerId: w.id, command: expect.objectContaining({ jobId: quick.id }) }]);
      expect(ran(s.toRunner.map((command) => ({ command })))).toEqual([]);
      expect((await s.job(merge.id)).state).toBe("queued");
      expect((await s.job(full.id)).state).toBe("queued");
    }
    // The worker's decline says why (R46), as an expected pause, not an idle-slot alarm.
    expect(s.d.idleSlots(s.co.id)).toEqual([expect.objectContaining({ machineKey: `worker:${w.id}`, code: "update_hold", expected: true, text: expect.stringMatching(/runner update/) })]);
    // The swap is done: the runner and the worker take the rest.
    s.setDrain(null);
    await s.pump();
    expect((await s.job(merge.id)).state).toBe("running");
    expect((await s.job(full.id)).state).toBe("running");
    expect(ran(s.toRunner.map((command) => ({ command }))).length).toBe(1);
  });

  it("packs the job's commit for the worker, then sends it the job with the bundle details; the upload is open only while it packs", async () => {
    let s!: Awaited<ReturnType<typeof setup>>;
    let openDuring: boolean | undefined;
    s = await setup({
      pack: async (cmd) => {
        openDuring = s.d.acceptsUpload(cmd.jobId, s.co.runnerId);
        return INFO;
      },
    });
    const w = await s.worker();
    const j = await s.req();
    await s.pump();
    expect(s.packs).toEqual([{ projectId: s.co.projectId, jobId: j.id, commit: j.commit, haves: [], full: false }]);
    expect(openDuring).toBe(true);
    expect(s.d.acceptsUpload(j.id, s.co.runnerId)).toBe(false);
    expect(ran(s.toWorker)).toEqual([{ workerId: w.id, command: expect.objectContaining({ type: "check.run", jobId: j.id, bundle: INFO }) }]);
    // No URL and no credential in what the worker is sent.
    expect(JSON.stringify(s.toWorker)).not.toMatch(/https?:|Bearer|bmr_|bmw_/);
  });

  it("names what the worker last said it holds as the bundle's base", async () => {
    const s = await setup();
    const w = await s.worker();
    s.d.onWorkerRepos(w.id, [{ projectId: s.co.projectId, haves: ["b".repeat(40)] }]);
    await s.req();
    await s.pump();
    expect(s.packs[0]).toMatchObject({ haves: ["b".repeat(40)], full: false });
  });

  it("gives a worker no job when the company runner can't pack code", async () => {
    const s = await setup({ canPack: false });
    await s.worker();
    const j = await s.req();
    await s.pump();
    expect(s.packs).toEqual([]);
    expect((await s.job(j.id)).state).toBe("queued");
    expect(await s.d.capacity(s.co.id)).toBe(1); // the runner's slot only
  });

  it("a pack that fails puts the job back in line (not a failed check) and leaves that worker out, so the runner takes it", async () => {
    const s = await setup({ pack: async () => Promise.reject(new Error("upload refused: 507")) });
    const w = await s.worker();
    const j = await s.req();
    await s.pump();
    const back = await s.job(j.id);
    expect(back).toMatchObject({ state: "queued", workerId: null });
    expect(back.reason).toMatch(/Couldn't get the code to the check worker/);
    expect(ran(s.toWorker)).toEqual([]);
    // The worker isn't handed it again; once the runner has room, it runs there.
    await s.pump();
    expect(s.packs).toHaveLength(1);
    s.runnerTakes(true);
    await s.pump();
    expect((await s.job(j.id)).state).toBe("running");
    expect((await s.job(j.id)).workerId).toBeNull();
    expect(s.toRunner.some((c) => c.type === "check.run" && c.jobId === j.id)).toBe(true);
    expect(w).toBeTruthy();
  });

  it("a worker missing the thin bundle's base gets the full history once; a second ask gives the job back", async () => {
    const s = await setup();
    const w = await s.worker();
    s.d.onWorkerRepos(w.id, [{ projectId: s.co.projectId, haves: ["b".repeat(40)] }]);
    const j = await s.req();
    await s.pump();
    await s.d.onWorkerNeedCode(w.id, j.id);
    await s.d.settled();
    expect(s.packs.map((p) => p.full)).toEqual([false, true]);
    expect(s.packs[1].haves).toEqual([]);
    expect(ran(s.toWorker)).toHaveLength(2);
    expect((await s.job(j.id)).state).toBe("running");
    await s.d.onWorkerNeedCode(w.id, j.id);
    await s.d.settled();
    expect(s.packs).toHaveLength(2);
    expect(await s.job(j.id)).toMatchObject({ state: "queued", workerId: null });
    expect(s.removed).toContain(j.id);
  });

  it("noCode from the worker puts the job back in line; a noCode or needCode from another worker changes nothing", async () => {
    const s = await setup();
    const w = await s.worker();
    const other = await s.worker();
    const j = await s.req();
    await s.pump();
    const on = (await s.job(j.id)).workerId!;
    const notOn = on === w.id ? other.id : w.id;
    await s.d.onWorkerNoCode(notOn, j.id, "x");
    await s.d.onWorkerNeedCode(notOn, j.id);
    await s.d.settled();
    expect((await s.job(j.id)).state).toBe("running");
    expect(s.packs).toHaveLength(1);
    await s.d.onWorkerNoCode(on, j.id, "git fetch failed");
    await s.d.settled();
    // Back in line (not ended as a failed check) and then handed to the other worker: the first is left out for this job.
    const back = await s.job(j.id);
    expect(back).toMatchObject({ state: "running", workerId: notOn });
    expect(s.packs).toHaveLength(2);
    expect(ran(s.toWorker).map((x) => x.workerId)).toEqual([on, notOn]);
  });

  it("a job cancelled while its code is packed is never sent to the worker, and its bundle goes", async () => {
    let release!: () => void;
    const s = await setup({ pack: () => new Promise((r) => (release = () => r(INFO))) });
    await s.worker();
    const j = await s.req();
    await s.d.pump();
    await s.d.cancel(j.id, "test");
    release();
    await s.d.settled();
    expect(ran(s.toWorker)).toEqual([]);
    expect(s.removed).toContain(j.id);
    expect(s.d.acceptsUpload(j.id, s.co.runnerId)).toBe(false);
  });

  it("a worker's hello while its code is still packed doesn't re-queue that job", async () => {
    let release!: () => void;
    const s = await setup({ pack: () => new Promise((r) => (release = () => r(INFO))) });
    const w = await s.worker();
    const j = await s.req();
    await s.d.pump();
    await s.d.onWorkerHello(w.id, []);
    expect((await s.job(j.id)).state).toBe("running");
    release();
    await s.d.settled();
    expect(ran(s.toWorker)).toHaveLength(1);
  });
});

describe("check bundle routes (BOS-1436)", () => {
  async function setup() {
    const w0 = await world();
    const w = await w0.worker();
    const otherWorker = await w0.worker();
    const j = await w0.req();
    await w0.db.update(checkJobs).set({ state: "running", workerId: w.id, startedAt: new Date() }).where(eq(checkJobs.id, j.id));
    const store = checkBundleStore({ dir: scratchDir(), maxBytes: 1024 });
    let accepting = true;
    const delivered: string[] = [];
    const app = Fastify();
    const tokens: Record<string, { id: string; companyId: string }> = { "runner-ok": { id: w0.co.runnerId, companyId: w0.co.id } };
    const other = await w0.company();
    tokens["runner-other"] = { id: other.runnerId, companyId: other.id };
    const workerTokens: Record<string, { id: string; enabled: boolean }> = { "worker-ok": { id: w.id, enabled: true }, "worker-other": { id: otherWorker.id, enabled: true }, "worker-off": { id: w.id, enabled: false } };
    await checkBundleRoutes(app, w0.db, {
      store,
      runners: { authenticate: async (t) => (t && tokens[t] ? (tokens[t] as never) : null) },
      workers: { authenticate: async (t) => (t && workerTokens[t] ? (workerTokens[t] as never) : null) },
      checks: { acceptsUpload: (jobId, runnerId) => accepting && jobId === j.id && runnerId === w0.co.runnerId, delivered: (id) => void delivered.push(id) },
    });
    await app.ready();
    const put = (token: string | null, body: Buffer, o: { id?: string; type?: string; sha?: string } = {}) =>
      app.inject({
        method: "PUT",
        url: `/api/check-bundles/${o.id ?? j.id}`,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": o.type ?? "application/octet-stream", ...(o.sha ? { "x-bundle-sha256": o.sha } : {}) },
        payload: body,
      });
    const get = (token: string | null, id = j.id) => app.inject({ method: "GET", url: `/api/check-bundles/${id}`, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { ...w0, app, store, j, put, get, delivered, stopAccepting: () => (accepting = false) };
  }

  it("the runner uploads, the job's worker downloads the same bytes, and the bundle is then gone", async () => {
    const s = await setup();
    const body = Buffer.from("PACK".repeat(50));
    const up = await s.put("runner-ok", body, { sha: sha(body) });
    expect(up.statusCode).toBe(201);
    expect(up.json()).toEqual({ bytes: body.length, sha256: sha(body) });
    const down = await s.get("worker-ok");
    expect(down.statusCode).toBe(200);
    expect(down.headers["cache-control"]).toBe("no-store");
    expect(down.rawPayload.equals(body)).toBe(true);
    expect(s.delivered).toEqual([s.j.id]);
    await s.app.close();
  });

  it("upload: no token 401; another company's runner, a job not being packed, or not a job id all 404; not octet-stream 415; too big 413", async () => {
    const s = await setup();
    const b = Buffer.from("x");
    expect((await s.put(null, b)).statusCode).toBe(401);
    expect((await s.put("nope", b)).statusCode).toBe(401);
    expect((await s.put("runner-other", b)).statusCode).toBe(404);
    expect((await s.put("runner-ok", b, { id: randomUUID() })).statusCode).toBe(404);
    expect((await s.put("runner-ok", b, { id: "..%2F..%2Fetc" })).statusCode).toBe(404);
    expect((await s.put("runner-ok", b, { type: "text/plain" })).statusCode).toBe(415);
    expect((await s.put("runner-ok", Buffer.alloc(2048))).statusCode).toBe(413);
    expect((await s.put("runner-ok", b, { sha: "0".repeat(64) })).statusCode).toBe(400);
    s.stopAccepting();
    expect((await s.put("runner-ok", b)).statusCode).toBe(404);
    expect(s.store.has(s.j.id)).toBe(false);
    await s.app.close();
  });

  it("download: only the worker the job runs on, while it runs, and only when it is turned on", async () => {
    const s = await setup();
    await s.put("runner-ok", Buffer.from("x"));
    expect((await s.get(null)).statusCode).toBe(401);
    expect((await s.get("worker-off")).statusCode).toBe(401);
    expect((await s.get("runner-ok")).statusCode).toBe(401); // a runner token isn't a worker token
    expect((await s.get("worker-other")).statusCode).toBe(404);
    expect((await s.get("worker-ok", randomUUID())).statusCode).toBe(404);
    await s.db.update(checkJobs).set({ state: "passed" }).where(eq(checkJobs.id, s.j.id));
    expect((await s.get("worker-ok")).statusCode).toBe(404);
    expect(s.delivered).toEqual([]);
    await s.app.close();
  });
});
