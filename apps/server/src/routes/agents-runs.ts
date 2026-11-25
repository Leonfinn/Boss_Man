// Agents, their lasting notes, and runs (R37, R62, BOS-85), owner only. Moved out of app.ts unchanged
// (BOS-298 step 15). The caller passes its owner scope, so requireOwner and the app's error handler
// still apply: this registers routes on that instance rather than through app.register, which would add
// a new scope. The company-level hiring and model routes, and /api/agent-changes/:id/undo, stay in app.ts.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { OWNER_MESSAGE_MAX, THINKING_LEVELS } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agentAvatars, agentNotes, agents } from "../db/schema.js";
import { AgentError, type agentsService } from "../services/agents.js";
import { AgentRecordError, agentRecordService, RECORD_DAYS } from "../services/agent-record.js";
import { NOTE_LIMITS, NoteError, type notesService } from "../services/agent-notes.js";
import { logoType } from "../services/image-type.js";
import { permissionsForRun } from "../services/permission-store.js";
import { RunError, type runsService } from "../services/runs.js";
import type { schedulerService } from "../services/scheduler.js";
import { sendLogo } from "../portal.js";

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });

export function agentRunsRoutes(
  owner: FastifyInstance,
  db: Db,
  deps: {
    agentsSvc: ReturnType<typeof agentsService>;
    notesSvc: ReturnType<typeof notesService>;
    runsSvc: ReturnType<typeof runsService>;
    scheduler: ReturnType<typeof schedulerService>;
    log: FastifyInstance["log"];
  },
) {
  const { agentsSvc, notesSvc, runsSvc, scheduler, log } = deps;

  // An agent's own picture, in place of its template's portrait.
  owner.put("/api/agents/:id/avatar", { bodyLimit: 400 * 1024 }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const { data } = z.object({ data: z.string() }).parse(req.body);
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || bytes.length > 256 * 1024) return reply.code(413).send({ error: "too_large", message: "The picture must be 256 KB or smaller." });
    const type = logoType(bytes);
    if (!type) return reply.code(415).send({ error: "bad_type", message: "The picture must be a PNG, JPEG or WebP image." });
    const [a] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, id));
    if (!a) return reply.code(404).send({ error: "not_found", message: "No such agent." });
    // An upload replaces any picture the CEO copied from a ticket image (BOS-265).
    await db.insert(agentAvatars).values({ agentId: id, bytes, type }).onConflictDoUpdate({ target: agentAvatars.agentId, set: { bytes, type, imageId: null } });
    const [row] = await db.update(agents).set({ avatarAt: new Date() }).where(eq(agents.id, id)).returning({ avatarAt: agents.avatarAt });
    return row;
  });
  owner.delete("/api/agents/:id/avatar", async (req) => {
    const { id } = IdParam.parse(req.params);
    await db.delete(agentAvatars).where(eq(agentAvatars.agentId, id));
    await db.update(agents).set({ avatarAt: null }).where(eq(agents.id, id));
    return { avatarAt: null };
  });
  owner.get("/api/agents/:id/avatar", async (req, reply) => {
    const [pic] = await db.select({ bytes: agentAvatars.bytes, type: agentAvatars.type }).from(agentAvatars).where(eq(agentAvatars.agentId, IdParam.parse(req.params).id));
    return pic ? sendLogo(reply, pic) : reply.code(404).send({ error: "not_found", message: "No picture." });
  });

  // Agents (R62): change them and retire them; hiring from a template stays in app.ts with the company routes.
  const agentErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
    if (err instanceof AgentError) return reply.code(err.status).send({ error: "agent", message: err.message });
    throw err;
  };
  const Instructions = z.string().trim().max(20_000).nullable();
  owner.patch("/api/agents/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z
      .object({ name: z.string().trim().min(1).max(80), title: z.string().trim().max(80).nullable(), instructions: Instructions, model: z.string().nullable(), thinking: z.enum(THINKING_LEVELS).nullable(), fundingSourceId: Uuid.nullable(), agentKind: z.string().min(1), paused: z.boolean(), starred: z.boolean(), workingHours: z.object({ days: z.array(z.number().int().min(0).max(6)).min(1).max(7), start: z.string(), end: z.string(), timeZone: z.string().min(1).max(80) }).nullable() })
      .partial()
      .parse(req.body);
    // Who reviews what is set only in Settings > Reviews now (BOS-198); say so rather than drop it quietly.
    if (req.body && typeof req.body === "object" && "reviewKind" in req.body) return reply.code(400).send({ error: "moved", message: "Reviewers are chosen in Settings > Reviews." });
    const patch = b;
    const [before] = await db.select().from(agents).where(eq(agents.id, id));
    if (!before) return reply.code(404).send({ error: "not_found" });
    // An agent with a standing job starts with no model; it needs one before it can run (R73).
    if (b.paused === false && before.duty && !(b.model !== undefined ? b.model : before.model)) {
      return reply.code(409).send({ error: "needs_model", message: `Choose a model for ${before.name} before starting it.` });
    }
    return agentsSvc.update(id, patch).then((a) => {
      // Unpausing lets its waiting work start now rather than at the next tick.
      if ((b.paused === false && before.paused) || (b.workingHours !== undefined && JSON.stringify(b.workingHours) !== JSON.stringify(before.workingHours))) void scheduler.tick().catch((err) => log.error({ err }, "tick after unpause failed"));
      return a;
    }, agentErrors(reply));
  });
  owner.post("/api/agents/:id/retire", async (req, reply) => agentsSvc.retire(IdParam.parse(req.params).id).catch(agentErrors(reply)));
  owner.get("/api/agents/:id/history", async (req, reply) => agentsSvc.history(IdParam.parse(req.params).id).catch(agentErrors(reply)));
  // One agent's last 30 days (BOS-2389): finished tickets, first-time passes, send-backs, time to merge, cost.
  owner.get("/api/agents/:id/record", async (req, reply) =>
    agentRecordService(db).record(IdParam.parse(req.params).id).catch((err: unknown) => {
      if (err instanceof AgentRecordError) return reply.code(404).send({ error: "not_found", message: err.message });
      throw err;
    }),
  );

  // Every agent's last 30 days side by side (BOS-2504), for the Agents page's "Team record" table.
  owner.get("/api/companies/:id/agent-records", async (req) => ({ days: RECORD_DAYS, agents: await agentRecordService(db).team(IdParam.parse(req.params).id) }));

  // The CEO's lasting notes (BOS-85): the owner sees, adds, edits and deletes them, within the same caps, and sees colleagues' requests.
  const noteErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
    if (err instanceof NoteError) return reply.code(err.status).send({ error: "note", message: err.message });
    throw err;
  };
  const NoteBody = z.object({ title: z.string().trim().min(1).max(NOTE_LIMITS.title), text: z.string().trim().min(1).max(NOTE_LIMITS.text), why: z.string().trim().min(1).max(NOTE_LIMITS.why), reviewBy: z.string().nullable().optional() });
  const noteOf = async (id: string) => (await db.select({ companyId: agentNotes.companyId }).from(agentNotes).where(eq(agentNotes.id, id)))[0];
  owner.get("/api/agents/:id/notes", async (req, reply) => {
    const [a] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, IdParam.parse(req.params).id));
    if (!a) return reply.code(404).send({ error: "not_found" });
    // Pending and declined requests from other agents show beside the notes.
    return { items: await notesSvc.withOrigin(a.companyId, IdParam.parse(req.params).id), requests: await notesSvc.requests(a.companyId, IdParam.parse(req.params).id), limits: NOTE_LIMITS };
  });
  owner.post("/api/agents/:id/notes", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const [a] = await db.select({ companyId: agents.companyId }).from(agents).where(eq(agents.id, id));
    if (!a) return reply.code(404).send({ error: "not_found" });
    return notesSvc.save(a.companyId, id, NoteBody.parse(req.body), { source: "owner" }).then((n) => reply.code(201).send(n), noteErrors(reply));
  });
  owner.patch("/api/agent-notes/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const n = await noteOf(id);
    if (!n) return reply.code(404).send({ error: "not_found" });
    return notesSvc.update(n.companyId, id, NoteBody.partial().parse(req.body), { owner: true }).then((r) => r.after, noteErrors(reply));
  });
  owner.delete("/api/agent-notes/:id", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const n = await noteOf(id);
    if (!n) return reply.code(404).send({ error: "not_found" });
    return notesSvc.remove(n.companyId, id, { owner: true }).then(() => ({ ok: true }), noteErrors(reply));
  });

  // Steering and stopping running agents (R37).
  const runErrors = (reply: import("fastify").FastifyReply) => (err: unknown) => {
    if (err instanceof RunError) return reply.code(err.status).send({ error: "run", message: err.message });
    throw err;
  };
  owner.get("/api/runs", async (req) => runsSvc.active(z.object({ companyId: Uuid.optional() }).parse(req.query).companyId));
  owner.post("/api/runs/:id/message", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ text: z.string().trim().min(1).max(OWNER_MESSAGE_MAX), interrupt: z.boolean().optional() }).parse(req.body);
    return runsSvc.message(id, { ...b, from: "the owner" }).catch(runErrors(reply));
  });
  // Agents woken but not started yet, and why (BOS-2320). Read-only; no notes text.
  owner.get("/api/companies/:id/wakes/waiting", async (req) => runsSvc.waiting(IdParam.parse(req.params).id));
  // Start now / Cancel on a waiting agent (BOS-2328). Start now only clears the wait: the scheduler still applies every limit.
  const WaitingBody = z.object({ reason: z.string().trim().max(200).optional() });
  const WakeParams = z.object({ id: Uuid, wakeId: Uuid });
  owner.post("/api/companies/:id/wakes/:wakeId/start-now", async (req, reply) => {
    const { id, wakeId } = WakeParams.parse(req.params);
    const b = WaitingBody.parse(req.body ?? {});
    const done = await runsSvc.startWaiting(id, wakeId, b.reason || undefined).catch(runErrors(reply));
    if (!done || !("id" in done)) return done;
    await scheduler.tick().catch((err) => log.error({ err }, "tick after start now failed"));
    const now = await runsSvc.wakeState(id, wakeId);
    // Started: a run took the wake. Still deferred or queued: say why instead of pretending.
    if (now?.runId) return { ok: true, started: true, waitingReason: null };
    return { ok: true, started: false, waitingReason: now?.statusReason ?? "Waiting for a free run slot." };
  });
  owner.post("/api/companies/:id/wakes/:wakeId/cancel", async (req, reply) => {
    const { id, wakeId } = WakeParams.parse(req.params);
    const b = WaitingBody.parse(req.body ?? {});
    return runsSvc.cancelWaiting(id, wakeId, b.reason || undefined).then(() => ({ ok: true }), runErrors(reply));
  });
  owner.get("/api/runs/recent", async (req) => {
    const q = z
      .object({
        companyId: Uuid.optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        agentId: Uuid.optional(),
        result: z.enum(["finished", "failed", "interrupted"]).optional(),
        // "Show more": only runs that ended before this moment (the oldest one already shown).
        before: z.coerce.date().optional(),
        // A ticket ref ("BOS-2250", any case) or words from the ticket's title.
        q: z.string().trim().max(100).optional(),
        // The wake reason that started the run (BOS-2437).
        reason: z.string().trim().min(1).max(100).optional(),
      })
      .parse(req.query);
    return runsSvc.recent(q.limit, q.companyId, { agentId: q.agentId, result: q.result, before: q.before, q: q.q, reason: q.reason });
  });
  // Why runs that ended in the last 7 days started: runs, cost and share per wake reason (BOS-2437).
  owner.get("/api/runs/reasons", async (req) => runsSvc.reasonSummary(z.object({ companyId: Uuid.optional() }).parse(req.query).companyId));
  owner.get("/api/runs/:id/transcript", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const q = z.object({ after: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query);
    return runsSvc.transcript(id, q).catch(runErrors(reply));
  });
  // What each permission rule decided in one run (BOS-2185), kept 60 days.
  owner.get("/api/runs/:id/permissions", async (req) => permissionsForRun(db, IdParam.parse(req.params).id));
  // End every run going now, in every company (BOS-837): the owner's emergency stop, behind the Runs page's confirm.
  owner.post("/api/runs/cancel-all", async () => runsSvc.cancelAll());
  owner.post("/api/runs/:id/cancel", async (req, reply) => runsSvc.cancel(IdParam.parse(req.params).id).catch(runErrors(reply)));
}
