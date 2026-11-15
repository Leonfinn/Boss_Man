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
export type ContainerInfo = { Id: string; Name: string; Config: { Labels: Record<string, string> | null; Env?: string[] | null }; HostConfig?: { Memory?: number }; Mounts?: { Type?: string; Source?: string; Destination?: string }[]; State: { Status: string; StartedAt?: string; ExitCode?: number; Health?: { Status: string } }; NetworkSettings?: { Networks?: Record<string, unknown> | null } };
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
    /** The daemon's version and OS type, for the runner's platform fingerprint (DR-049); null if it won't say. */
    async hostInfo(): Promise<{ dockerVersion: string; osType: string } | null> {
      const r = await call<{ ServerVersion?: string; OSType?: string }>("GET", "/info");
      if (r.status !== 200 || !r.json) return null;
      return { dockerVersion: r.json.ServerVersion ?? "unknown", osType: r.json.OSType ?? "unknown" };
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
    /**
     * Waits for a container to stop and returns how it ended: its exit code, or null when it didn't stop
     * within `timeoutMs` (the caller then kills it). Used for the one-shot Claude pack installer (BOS-972).
     *
     * Polls `GET /containers/{id}/json` rather than `POST /wait`: `/wait` blocks with no bytes until the
     * container stops, and `call`'s FIXED 60 s socket timeout would destroy the request long before a real
     * `npm ci` (minutes) finished. Polling each returns at once, so the 60 s timeout never bites and the
     * caller's own (15-minute) budget is what decides. Waits `pollMs` between looks, not a tight loop.
     */
    async wait(id: string, timeoutMs: number): Promise<{ stopped: boolean; exitCode: number | null }> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const r = await call<{ State?: { Running?: boolean; ExitCode?: number } }>("GET", `/containers/${encodeURIComponent(id)}/json`);
        const state = r.status === 200 ? r.json?.State : undefined;
        if (state && state.Running === false) return { stopped: true, exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null };
        const left = deadline - Date.now();
        if (left <= 0) return { stopped: false, exitCode: null };
        await new Promise((res) => setTimeout(res, Math.min(pollMs, left)));
      }
    },
    async start(id: string) {
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/start`);
      if (r.status !== 204 && r.status !== 304) fail(r, "Starting the runner failed");
    },
    /** Takes a container off a network (BOS-576: before it starts, it then has loopback only). Not on it already is fine. */
    async disconnect(network: string, id: string) {
      const r = await call("POST", `/networks/${encodeURIComponent(network)}/disconnect`, { Container: id, Force: false });
      const msg = r.json && typeof r.json === "object" && "message" in r.json ? String((r.json as { message: unknown }).message) : "";
      if (r.status !== 200 && !/is not connected/i.test(msg)) fail(r, "Taking the runner off its network failed");
    },
    /** Puts a container on a network. Being on it already is fine. */
    async connect(network: string, id: string) {
      const r = await call("POST", `/networks/${encodeURIComponent(network)}/connect`, { Container: id });
      const msg = r.json && typeof r.json === "object" && "message" in r.json ? String((r.json as { message: unknown }).message) : "";
      if (r.status !== 200 && !/already exists in network/i.test(msg)) fail(r, "Connecting the runner to its network failed");
    },
    /** Sends a signal, e.g. USR1 to wake the guard. */
    async signal(id: string, signal: string) {
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/kill?signal=${encodeURIComponent(signal)}`);
      if (r.status !== 204) fail(r, "Signalling the container failed");
    },
    async restart(id: string) {
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/restart?t=30`);
      if (r.status !== 204) fail(r, "Restarting the runner failed");
    },
    /** Freezes every process in the container (cgroup freezer); its memory, files and network namespace stay as they are (DR-007). */
    async pause(id: string) {
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/pause`);
      if (r.status !== 204) fail(r, "Pausing the runner failed");
    },
    async unpause(id: string) {
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/unpause`);
      if (r.status !== 204) fail(r, "Unpausing the runner failed");
    },
    /** Stops it (30 s grace) and keeps the container, so it can be started again with its data. */
    async stop(id: string) {
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/stop?t=30`);
      if (r.status !== 204 && r.status !== 304) fail(r, "Stopping the runner failed");
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
        // Settle once and take the abort listener off, so a long-lived signal collecting one per reconnect (BOS-335)
        // doesn't pile up listeners: Node warns past ten, and this reconnects for the life of the process.
        let settled = false;
        const onAbort = () => req.destroy();
        const done = () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const req = http.request({ socketPath, method: "GET", path: `/events?${qs}`, headers: { host: "docker" } }, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            onError(new DockerError(res.statusCode ?? 0, `Watching Docker events failed: HTTP ${res.statusCode}`));
            done();
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
          res.on("end", done);
          res.on("error", (err) => {
            onError(err);
            done();
          });
        });
        req.on("error", (err) => {
          onError(err);
          done();
        });
        signal.addEventListener("abort", onAbort, { once: true });
        req.end();
      });
    },
  };
}

export type Docker = ReturnType<typeof dockerClient>;
