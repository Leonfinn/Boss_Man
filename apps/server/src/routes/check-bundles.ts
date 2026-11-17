// A check job's code on its way to a check worker (DR-060 part 2, BOS-1436). The server's first streamed upload and
// download: the body is never held in memory and never logged.
//
//   PUT /api/check-bundles/:jobId  the company runner's token; only for a job of its own company that the server has just
//                                  asked it to pack (the dispatcher's acceptsUpload), so a runner can't plant code for
//                                  any other job.
//   GET /api/check-bundles/:jobId  the check worker's token; only the worker the job runs on, while it runs, and only an
//                                  enabled worker. Anything else is 404, so the route says nothing about which jobs exist.
//
// Both are leader-only (the folder is the leader's): app.ts's standby hook answers 503 for the whole prefix.
import type { FastifyInstance } from "fastify";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checkJobs } from "../db/schema.js";
import type { CheckBundleStore } from "../services/check-bundles.js";
import type { CheckWorkersService } from "../services/check-workers.js";
import type { runnersService } from "../services/runners.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bearer = (h: string | undefined) => (h?.startsWith("Bearer ") ? h.slice(7) : undefined);

export async function checkBundleRoutes(
  app: FastifyInstance,
  db: Db,
  deps: {
    store: CheckBundleStore;
    runners: Pick<ReturnType<typeof runnersService>, "authenticate">;
    workers: Pick<CheckWorkersService, "authenticate">;
    checks: { acceptsUpload: (jobId: string, runnerId: string) => boolean; delivered: (jobId: string) => void };
  },
) {
  await app.register(async (scope) => {
    // Scoped to these routes: the raw request stream goes to the store as it arrives.
    scope.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));

    scope.put("/api/check-bundles/:jobId", { bodyLimit: deps.store.maxBytes }, async (req, reply) => {
      const runner = await deps.runners.authenticate(bearer(req.headers.authorization));
      if (!runner) return reply.code(401).send({ error: "unknown_runner" });
      const { jobId } = req.params as { jobId: string };
      if (!UUID.test(jobId)) return reply.code(404).send({ error: "not_found" });
      const [job] = await db.select({ companyId: checkJobs.companyId }).from(checkJobs).where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "running")));
      if (!job || job.companyId !== runner.companyId || !deps.checks.acceptsUpload(jobId, runner.id)) return reply.code(404).send({ error: "not_found" });
      if (req.headers["content-type"] !== "application/octet-stream" || !req.body) return reply.code(415).send({ error: "octet_stream_only" });
      const declared = Number(req.headers["content-length"]);
      const sha = req.headers["x-bundle-sha256"];
      const r = await deps.store.put(jobId, req.body as NodeJS.ReadableStream as import("node:stream").Readable, {
        declared: Number.isInteger(declared) && declared >= 0 ? declared : undefined,
        sha256: typeof sha === "string" && /^[0-9a-f]{64}$/.test(sha) ? sha : undefined,
      });
      if (!r.ok) {
        req.log.warn({ jobId, status: r.status }, "check bundle upload refused");
        return reply.code(r.status).send({ error: r.error });
      }
      req.log.info({ jobId, bytes: r.bytes }, "check bundle stored");
      return reply.code(201).send({ bytes: r.bytes, sha256: r.sha256 });
    });

    scope.get("/api/check-bundles/:jobId", async (req, reply) => {
      const worker = await deps.workers.authenticate(bearer(req.headers.authorization));
      if (!worker || !worker.enabled) return reply.code(401).send({ error: "unknown_worker" });
      const { jobId } = req.params as { jobId: string };
      if (!UUID.test(jobId)) return reply.code(404).send({ error: "not_found" });
      const [job] = await db.select({ id: checkJobs.id }).from(checkJobs).where(and(eq(checkJobs.id, jobId), eq(checkJobs.state, "running"), eq(checkJobs.workerId, worker.id)));
      const file = job ? deps.store.open(jobId) : null;
      if (!file) return reply.code(404).send({ error: "not_found" });
      // A whole download means the worker has it, so the file goes now rather than at the job's end (a first bundle is a few
      // hundred MB and a full check runs 30-50 minutes). A broken one is left to the job's end or the sweep.
      reply.raw.once("finish", () => deps.checks.delivered(jobId));
      return reply.header("content-type", "application/octet-stream").header("content-length", String(file.bytes)).header("cache-control", "no-store").send(file.stream);
    });
  });
}
