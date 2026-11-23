// The updater's only door (design section 2): POST /move, GET /status, POST /ack on the private updater network.
// The key is checked before anything else, and before the body is read. The body is capped at 1 KB and must be exactly
// {"version","serverDigest"}. A move runs in the background; /status shows where it is.
import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { UpdaterError } from "./config.js";
import { runMove, type MoveDeps } from "./move.js";
import { parseInstruction } from "./schema.js";
import { RUNNING_STAGES } from "./state.js";

export const MAX_BODY_BYTES = 1024;

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time comparison of the presented key with the real one (both hashed to equal length first). */
export function keyMatches(presented: string | undefined, key: string): boolean {
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(key));
}

export type UpdaterServer = { server: http.Server; /** Resolves when the move running now (if any) has finished. */ idle(): Promise<void> };

export function createServer(deps: MoveDeps, key: string): UpdaterServer {
  let running: Promise<void> = Promise.resolve();
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), connection: "close" });
    // The connection closes once the answer is out, so an unread body is never read later.
    res.end(text, () => res.req.socket?.destroy());
  };
  const publicState = () => {
    const { stage, version, startedAt, updatedAt, error, report } = deps.state.get();
    return { stage, version, startedAt, updatedAt, currentVersion: deps.cfg.currentVersion, error, report };
  };

  async function readBody(req: http.IncomingMessage): Promise<Buffer> {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > MAX_BODY_BYTES) throw new UpdaterError("bad_request", "The request is larger than 1 KB.");
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const c of req) {
      total += (c as Buffer).length;
      if (total > MAX_BODY_BYTES) throw new UpdaterError("bad_request", "The request is larger than 1 KB.");
      chunks.push(c as Buffer);
    }
    return Buffer.concat(chunks);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const auth = req.headers["authorization"];
      const presented = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
      if (!keyMatches(presented, key)) {
        // Refused before the body is read; send() closes the connection.
        return send(res, 401, { error: "unauthorized" });
      }
      const url = new URL(req.url ?? "/", "http://updater");
      const route = `${url.pathname}`;
      if (route !== "/move" && route !== "/status" && route !== "/ack") return send(res, 404, { error: "not_found" });
      const want = route === "/status" ? "GET" : "POST";
      if (req.method !== want) return send(res, 405, { error: "method_not_allowed" });
      if (url.search) return send(res, 400, { error: "bad_request", message: "No query string is accepted." });
      if (route === "/status") return send(res, 200, publicState());
      try {
        const body = await readBody(req);
        if (route === "/ack") {
          if (body.length > 0) throw new UpdaterError("bad_request", "An acknowledgement has no body.");
          deps.state.acknowledge();
          return send(res, 200, publicState());
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          throw new UpdaterError("bad_request", "The request is not JSON.");
        }
        const ins = parseInstruction(parsed);
        if (RUNNING_STAGES.includes(deps.state.get().stage)) return send(res, 409, { error: "busy", message: "Another update is already running.", state: publicState() });
        deps.state.begin(ins.version, ins.serverDigest);
        running = runMove(deps, ins);
        return send(res, 202, { accepted: true, state: publicState() });
      } catch (e) {
        if (e instanceof UpdaterError && e.code === "bad_request") return send(res, 400, { error: "bad_request", message: e.message });
        if (e instanceof UpdaterError && e.code === "busy") return send(res, 409, { error: "busy", message: e.message, state: publicState() });
        return send(res, 500, { error: "internal" });
      }
    })();
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  return { server, idle: () => running };
}
