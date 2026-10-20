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
export type ContainerInfo = { Id: string; Name: string; Config: { Labels: Record<string, string> | null }; State: { Status: string } };

export function dockerClient(socketPath = "/var/run/docker.sock") {
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
    /** Stops (30 s for the runner to finish its journal write) and removes it. Volumes and binds stay. */
    async remove(id: string) {
      const stop = await call("POST", `/containers/${encodeURIComponent(id)}/stop?t=30`);
      if (stop.status !== 204 && stop.status !== 304 && stop.status !== 404) fail(stop, "Stopping the runner failed");
      const r = await call("DELETE", `/containers/${encodeURIComponent(id)}?force=1`);
      if (r.status !== 204 && r.status !== 404) fail(r, "Removing the runner failed");
    },
  };
}

export type Docker = ReturnType<typeof dockerClient>;
