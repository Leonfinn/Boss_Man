// The WebSocket a runner dials out to (R31). Auth: `Authorization: Bearer <runner token>`.
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { HEARTBEAT_MS, PROTOCOL_VERSION, RunnerMessage, type ServerMessage } from "@boss-man/shared";
import type { runnersService } from "../services/runners.js";
import type { secretsService } from "../services/secrets.js";

type Runners = ReturnType<typeof runnersService>;

// Runner events received and not yet stored (the one being stored included), across every socket on this process (BOS-410). A
// slow database makes these pile up in memory; the memory sampler logs the count.
// lost on restart, harmless because it is only a live gauge of this process's in-flight stores, not a value anything reads later.
let ingestWaiting = 0;
export const runnerIngestWaiting = () => ingestWaiting;

export async function runnerSocketRoutes(
  app: FastifyInstance,
  runners: Runners,
  secrets: ReturnType<typeof secretsService>,
  opts: { heartbeatMs?: number; isLeader?: () => boolean; checks?: Pick<ReturnType<typeof import("../services/check-dispatcher.js").checkDispatcher>, "onHello" | "onDone" | "onProgress"> } = {},
) {
  const heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;

  /** A run's environment: the company's granted secrets. Each fetch is written to the access log. */
  app.get("/api/runner/env", async (req, reply) => {
    const header = req.headers.authorization;
    const runner = await runners.authenticate(header?.startsWith("Bearer ") ? header.slice(7) : undefined);
    if (!runner) return reply.code(401).send({ error: "unknown_runner" });
    const runId = (req.query as { runId?: string }).runId;
    const validRunId = runId && /^[0-9a-f-]{36}$/i.test(runId) ? runId : undefined;
    reply.header("cache-control", "no-store");
    // Outside a run, a runner needs secrets only to push a merge (R46), check the setup-token (R58) or move a deploy tag (DR-033).
    const asked = (req.query as { purpose?: string }).purpose;
    const purpose = !validRunId && (asked === "merge" || asked === "check" || asked === "deploy_tag") ? asked : "run";
    return { env: await secrets.resolveCompanyEnv(runner.companyId, purpose, validRunId) };
  });

  app.get(
    "/api/runner/connect",
    {
      websocket: true,
      // Reject before the upgrade so an unauthenticated client never gets a socket.
      preValidation: async (req, reply) => {
        // Only the leader holds runners; the runner's backoff retries until it reaches the one in charge.
        if (opts.isLeader && !opts.isLeader()) return reply.code(503).header("retry-after", "2").send({ error: "standby" });
        const header = req.headers.authorization;
        const runner = await runners.authenticate(header?.startsWith("Bearer ") ? header.slice(7) : undefined);
        if (!runner) return reply.code(401).send({ error: "unknown_runner" });
        (req as unknown as { runner: typeof runner }).runner = runner;
      },
    },
    (socket, req) => {
      const runner = (req as unknown as { runner: NonNullable<Awaited<ReturnType<Runners["authenticate"]>>> }).runner;
      const send = (m: ServerMessage) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m));
      };
      let lastHeard = Date.now();
      let release: (() => void) | null = null;
      // Ingest strictly in arrival order so acks stay cumulative.
      let queue = Promise.resolve();

      const timer = setInterval(() => {
        if (Date.now() - lastHeard > heartbeatMs * 3) {
          socket.terminate();
          return;
        }
        send({ type: "ping" });
      }, heartbeatMs);

      socket.on("message", (raw) => {
        lastHeard = Date.now();
        let msg: RunnerMessage;
        try {
          msg = RunnerMessage.parse(JSON.parse(String(raw)));
        } catch {
          send({ type: "error", message: "Malformed message" });
          return;
        }
        switch (msg.type) {
          case "hello":
            if (msg.protocol !== PROTOCOL_VERSION) {
              send({ type: "error", message: `Protocol ${msg.protocol} is not supported; expected ${PROTOCOL_VERSION}.` });
              socket.close(4000, "protocol");
              return;
            }
            queue = queue.then(async () => {
              await runners.touch(runner, msg.imageVersion, msg.harnessVersions, msg.imageCommit);
              await runners.bootSeen(runner, msg.bootId, { previousExit: msg.previousExit, hostBootAt: msg.hostBootAt }).catch((err) => app.log.error({ err, runnerId: runner.id, companyId: runner.companyId }, "waking parked checks after a restart failed"));
              release = runners.connect(runner.id, (command) => {
                if (socket.readyState !== socket.OPEN) return false;
                send({ type: "command", id: randomUUID(), command });
                return true;
              }, msg.features);
              send({ type: "welcome", lastSeq: await runners.lastSeq(runner.id) });
              void runners.checkAddons(runner.id).catch((err) => app.log.warn({ err, runnerId: runner.id }, "add-on check failed"));
              // Verdicts that may have been lost in a dropped connection are sent again.
              // The runs the runner really has: any other open run of this runner is closed after a short wait (BOS-583).
              if (msg.liveRuns) runners.reconcileLater(runner, msg.liveRuns);
              if (msg.pending?.length) await runners.resumed(runner, msg.pending).catch((err) => app.log.error({ err, runnerId: runner.id, companyId: runner.companyId }, "re-sending verdicts failed"));
              await opts.checks?.onHello(runner.id, msg.checkJobs).catch((err) => app.log.error({ err, runnerId: runner.id }, "check queue hello failed"));
            });
            return;
          case "event":
            ingestWaiting++;
            queue = queue
              .then(async () => {
                await runners.ingest(runner, msg.entry);
                send({ type: "ack", upTo: msg.entry.seq });
              })
              .catch((err) => {
                app.log.error({ err, runnerId: runner.id, seq: msg.entry.seq, companyId: runner.companyId }, "runner event failed");
                // No ack: the runner keeps the entry and resends it after reconnecting.
                socket.close(1011, "ingest failed");
              })
              // Counted down however the event ends, a failed hello ahead of it included (Jane, BOS-472).
              .finally(() => {
                ingestWaiting--;
              });
            return;
          case "check.progress":
            queue = queue.then(() => opts.checks?.onProgress(runner.id, msg)).catch((err) => app.log.warn({ err, runnerId: runner.id }, "check progress failed"));
            return;
          case "check.done":
            queue = queue.then(() => opts.checks?.onDone(runner.id, msg)).catch((err) => app.log.error({ err, runnerId: runner.id }, "check result failed"));
            return;
          case "reply":
            runners.resolveReply(msg);
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
        release?.();
      });
    },
  );
}
