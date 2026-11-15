// The WebSocket a check worker dials out to (DR-060, BOS-1435). Auth: `Authorization: Bearer <worker token>`.
// It carries check jobs and nothing else. Messages are parsed with WorkerMessage, which has no journal events, no replies
// to requests and no run or merge messages, so anything else is refused; the only commands sent are check.run,
// check.cancel and check.ack. There is no env route for a worker: it never gets the company's secrets.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { HEARTBEAT_MS, PROTOCOL_VERSION, WorkerMessage } from "@boss-man/shared";
import type { checkDispatcher } from "../services/check-dispatcher.js";
import type { CheckWorker, CheckWorkersService } from "../services/check-workers.js";

/** Close code for a worker the owner turned off (or removed): it keeps redialling, and is refused until turned on. */
export const WORKER_OFF_CLOSE = 4003;
/** Close code for a socket that connected but never said hello within three heartbeats. */
export const WORKER_NO_HELLO_CLOSE = 4008;

type Checks = Pick<ReturnType<typeof checkDispatcher>, "onWorkerHello" | "onWorkerDone" | "onWorkerProgress" | "onWorkerGone"> &
  Partial<Pick<ReturnType<typeof checkDispatcher>, "onWorkerNeedCode" | "onWorkerNoCode" | "onWorkerRepos">>;

export async function checkWorkerSocketRoutes(app: FastifyInstance, workers: CheckWorkersService, opts: { heartbeatMs?: number; isLeader?: () => boolean; checks?: Checks } = {}) {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;

  app.get(
    "/api/check-worker/connect",
    {
      websocket: true,
      // Reject before the upgrade so an unauthenticated (or turned-off) client never gets a socket.
      preValidation: async (req, reply) => {
        if (opts.isLeader && !opts.isLeader()) return reply.code(503).header("retry-after", "2").send({ error: "standby" });
        const header = req.headers.authorization;
        const worker = await workers.authenticate(header?.startsWith("Bearer ") ? header.slice(7) : undefined);
        if (!worker) return reply.code(401).send({ error: "unknown_worker" });
        if (!worker.enabled) return reply.code(403).send({ error: "worker_off" });
        (req as unknown as { worker: CheckWorker }).worker = worker;
      },
    },
    (socket, req) => {
      const worker = (req as unknown as { worker: CheckWorker }).worker;
      const send = (m: unknown) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
      };
      const opened = Date.now();
      let lastHeard = opened;
      let release: (() => void) | null = null;
      // Handle strictly in arrival order, so a result never overtakes the hello before it.
      let queue = Promise.resolve();

      const timer = setInterval(() => {
        if (Date.now() - lastHeard > heartbeatMs * 3) {
          socket.terminate();
          return;
        }
        // A socket that never says hello gets no jobs; don't keep it open on pings alone.
        if (!release && Date.now() - opened > heartbeatMs * 3) {
          socket.close(WORKER_NO_HELLO_CLOSE, "no hello");
          return;
        }
        send({ type: "ping" });
      }, heartbeatMs);

      socket.on("message", (raw) => {
        lastHeard = Date.now();
        let msg: WorkerMessage;
        try {
          msg = WorkerMessage.parse(JSON.parse(String(raw)));
        } catch {
          // Includes every runner-only message (event, reply): a worker can't journal, answer requests or run agents.
          send({ type: "error", message: "Not a check worker message" });
          return;
        }
        switch (msg.type) {
          case "hello":
            if (msg.protocol !== PROTOCOL_VERSION) {
              send({ type: "error", message: `Protocol ${msg.protocol} is not supported; expected ${PROTOCOL_VERSION}.` });
              socket.close(4000, "protocol");
              return;
            }
            queue = queue
              .then(async () => {
                const helloAt = new Date();
                const row = await workers.touch(worker.id, { imageCommit: msg.imageCommit, toolchain: msg.toolchain, imageVersion: msg.imageVersion, checkSlots: msg.checkSlots, features: msg.features });
                // Turned off or removed since the upgrade: close, and the redial is refused in preValidation.
                if (!row?.enabled) {
                  socket.close(WORKER_OFF_CLOSE, "worker off");
                  return;
                }
                release?.();
                release = workers.connect(
                  worker.id,
                  (command) => {
                    if (socket.readyState !== socket.OPEN) return false;
                    send({ type: "command", id: randomUUID(), command });
                    return true;
                  },
                  (code, why) => socket.close(code, why),
                  msg.features,
                );
                // lastSeq 0: a worker keeps no journal, so there is nothing to replay; the welcome only says "live".
                send({ type: "welcome", lastSeq: 0 });
                await opts.checks?.onWorkerHello(worker.id, msg.checkJobs, helloAt, msg.repos);
              })
              .catch((err) => app.log.error({ err, workerId: worker.id }, "check worker hello failed"));
            return;
          case "check.progress":
            queue = queue.then(() => opts.checks?.onWorkerProgress(worker.id, msg)).catch((err) => app.log.warn({ err, workerId: worker.id }, "check worker progress failed"));
            return;
          case "check.done":
            queue = queue.then(() => opts.checks?.onWorkerDone(worker.id, msg)).catch((err) => app.log.error({ err, workerId: worker.id }, "check worker result failed"));
            return;
          // BOS-1436: getting the code. Only for the worker's own jobs (the dispatcher checks the job runs on it).
          case "check.needCode":
            queue = queue.then(() => opts.checks?.onWorkerNeedCode?.(worker.id, msg.jobId)).catch((err) => app.log.warn({ err, workerId: worker.id }, "check worker code request failed"));
            return;
          case "check.noCode":
            queue = queue.then(() => opts.checks?.onWorkerNoCode?.(worker.id, msg.jobId, msg.reason)).catch((err) => app.log.warn({ err, workerId: worker.id }, "check worker no-code failed"));
            return;
          case "check.haves":
            opts.checks?.onWorkerRepos?.(worker.id, msg.repos);
            return;
          case "ping":
            send({ type: "pong" });
            return;
          case "pong":
            return;
        }
      });

      socket.on("close", () => {
        clearInterval(timer);
        const wasLive = !!release;
        release?.();
        release = null;
        if (wasLive && !workers.isConnected(worker.id)) {
          // "Offline since" in Settings is when it went, not when it last said hello.
          void workers.seen(worker.id).catch(() => {});
          opts.checks?.onWorkerGone(worker.id);
        }
      });
    },
  );
}
