// A minimal Docker Engine API client over the unix socket, with only the calls the launcher
// makes. Paths are unversioned, so the daemon answers with its own API version.
import http from "node:http";

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ContainerSummary = { Id: string; Names: string[]; Image: string; ImageID?: string; State: string; Status: string; Labels: Record<string, string>; Created: number };
export type ContainerInfo = { Id: string; Name: string; Config: { Labels: Record<string, string> | null }; State: { Status: string; StartedAt?: string; ExitCode?: number; Health?: { Status: string } } };
/** One Docker event, as far as the launcher reads it: a container start, a restart or a die (a crash). */
export type DockerEvent = { Type?: string; Action?: string; Actor?: { ID?: string; Attributes?: Record<string, string> } };

export function dockerClient(socketPath = "/var/run/docker.sock", wait: { pollMs?: number; maxMs?: number } = {}) {
  const pollMs = wait.pollMs ?? 500;
  const maxMs = wait.maxMs ?? 60_000;
  function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; json: T | null }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { socketPath, method, path, headers: { host: "docker", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) }, timeout: 60_000 },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: T | null = null;
            try {
              json = text ? (JSON.parse(text) as T) : null;
            } catch {
              json = null;
            }
            resolve({ status: res.statusCode ?? 0, json });
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error(`Docker didn't answer ${method} ${path}`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  const fail = (r: { status: number; json: unknown }, what: string): never => {
    const msg = r.json && typeof r.json === "object" && "message" in r.json ? String((r.json as { message: unknown }).message) : `HTTP ${r.status}`;
    throw new DockerError(r.status, `${what}: ${msg}`);
  };

  return {
    async list(label: string): Promise<ContainerSummary[]> {
      const r = await call<ContainerSummary[]>("GET", `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: [label] }))}`);
      return r.status === 200 && r.json ? r.json : fail(r, "Listing containers failed");
    },
    async inspect(nameOrId: string): Promise<ContainerInfo | null> {
      const r = await call<ContainerInfo>("GET", `/containers/${encodeURIComponent(nameOrId)}/json`);
      if (r.status === 404) return null;
      return r.status === 200 && r.json ? r.json : fail(r, "Inspecting the container failed");
    },
    /** The id an image tag points at now, or null if there is no such image. */
    async imageId(ref: string): Promise<string | null> {
      const r = await call<{ Id: string }>("GET", `/images/${encodeURIComponent(ref)}/json`);
      if (r.status === 404) return null;
      return r.status === 200 && r.json ? r.json.Id : fail(r, "Inspecting the image failed");
    },
    async create(name: string, spec: unknown): Promise<string> {
      const r = await call<{ Id: string }>("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
      return r.status === 201 && r.json ? r.json.Id : fail(r, "Creating the runner failed");
    },
    async start(id: string) {
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/start`);
      if (r.status !== 204 && r.status !== 304) fail(r, "Starting the runner failed");
    },
    async restart(id: string) {
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/restart?t=30`);
      if (r.status !== 204) fail(r, "Restarting the runner failed");
    },
    /**
     * Stops (30 s for the runner to finish its journal write) and removes it. Volumes and binds stay.
     * Another removal finishing it ("already in progress") is not a failure: waits for it to be gone, then returns.
     */
    async remove(id: string): Promise<void> {
      const stop = await call("POST", `/containers/${encodeURIComponent(id)}/stop?t=30`);
      if (stop.status !== 204 && stop.status !== 304 && stop.status !== 404) fail(stop, "Stopping the runner failed");
      const r = await call("DELETE", `/containers/${encodeURIComponent(id)}?force=1`);
      if (r.status === 204 || r.status === 404) return;
      // Another remove (a deploy, compose recreating the container) got there first: Docker answers
      // 409 "removal of container X is already in progress". That is not a failure; wait for the
      // container to be gone, then carry on.
      const msg = r.json && typeof r.json === "object" && "message" in r.json ? String((r.json as { message: unknown }).message) : "";
      if (r.status === 409 && /already in progress/i.test(msg)) {
        const until = Date.now() + maxMs;
        for (;;) {
          const gone = await call("GET", `/containers/${encodeURIComponent(id)}/json`);
          if (gone.status === 404) return;
          if (gone.status !== 200) fail(gone, "Checking the runner was removed failed");
          if (Date.now() >= until) throw new DockerError(409, "Removing the runner failed: Docker is still removing the old container after a minute. Wait a minute and run the update again.");
          await new Promise((res) => setTimeout(res, pollMs));
        }
      }
      fail(r, "Removing the runner failed");
    },
    /**
     * Watches the container events the launcher cares about (BOS-335): a runner starting or restarting by itself
     * needs its guard back at once, not up to 5 s later. `/events` is a streaming endpoint; this reads newline-
     * delimited JSON until `signal` aborts. `since` is a Unix second so a reconnect doesn't lose what came between.
     * Resolves when the stream ends; `onError` is told why, so the caller can reconnect after a pause.
     */
    events(
      filter: { type?: string; action?: string[]; label?: string },
      since: number,
      onEvent: (e: DockerEvent) => void,
      onError: (err: Error) => void,
      signal: AbortSignal,
    ): Promise<void> {
      return new Promise((resolve) => {
        const filters: Record<string, string[]> = {};
        if (filter.type) filters.type = [filter.type];
        if (filter.action) filters.event = filter.action;
        if (filter.label) filters.label = [filter.label];
        const qs = `since=${Math.floor(since)}&filters=${encodeURIComponent(JSON.stringify(filters))}`;
        const req = http.request({ socketPath, method: "GET", path: `/events?${qs}`, headers: { host: "docker" } }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            onError(new DockerError(res.statusCode ?? 0, `Watching Docker events failed: HTTP ${res.statusCode}`));
            resolve();
            return;
          }
          let buf = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buf += chunk;
            let nl: number;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                onEvent(JSON.parse(line) as DockerEvent);
              } catch {
                /* a half line or something that isn't an event: skip it */
              }
            }
          });
          res.on("end", resolve);
          res.on("error", (err) => {
            onError(err);
            resolve();
          });
        });
        req.on("error", (err) => {
          onError(err);
          resolve();
        });
        signal.addEventListener("abort", () => req.destroy(), { once: true });
        req.end();
      });
    },
  };
}

export type Docker = ReturnType<typeof dockerClient>;
