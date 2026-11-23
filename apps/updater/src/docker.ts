// The updater's Docker client (design section 9). It speaks to the Docker socket through ONE function that refuses any
// method+path not in ALLOWED_CALLS, so the updater cannot exec, build, run a privileged container, bind a host folder or
// touch another install's containers, whatever a bug or a bad instruction asks. Every call on an existing container first
// reads its labels and refuses a container that does not carry this install's label.
// 941a lists the calls the pull and the pack install need; 941b adds the swap's calls here on purpose, and the allow-list
// test (test/docker.test.ts) fails until the new line is added to it too.
import http from "node:http";
import { UpdaterError } from "./config.js";

export type Allowed = { method: "GET" | "POST" | "DELETE"; pattern: RegExp; what: string };

const ID = "[A-Za-z0-9][A-Za-z0-9_.-]{0,127}";
const IMAGE_REF = "[A-Za-z0-9][A-Za-z0-9_./:@%-]{0,300}";

/** Every Docker call the updater may make. Adding a line is a security decision: say why in the comment. */
export const ALLOWED_CALLS: readonly Allowed[] = [
  { method: "GET", pattern: new RegExp(`^/info$`), what: "the daemon's architecture" },
  { method: "GET", pattern: new RegExp(`^/containers/${ID}/json$`), what: "inspect a container (labels, exit code)" },
  { method: "GET", pattern: new RegExp(`^/containers/${ID}/logs\\?stdout=1&stderr=1&tail=[0-9]{1,4}$`), what: "the end of a one-shot container's output" },
  { method: "POST", pattern: new RegExp(`^/containers/create\\?name=${ID}$`), what: "create the one-shot pack installer (body built here, checked by assertSafeCreate)" },
  { method: "POST", pattern: new RegExp(`^/containers/${ID}/start$`), what: "start the pack installer" },
  { method: "DELETE", pattern: new RegExp(`^/containers/${ID}\\?force=1&v=1$`), what: "remove the pack installer (force also stops it at the timeout)" },
  { method: "POST", pattern: new RegExp(`^/images/create\\?fromImage=${IMAGE_REF}$`), what: "pull an image by digest" },
  { method: "GET", pattern: new RegExp(`^/images/${IMAGE_REF}/json$`), what: "read back a pulled image's digest" },
  { method: "DELETE", pattern: new RegExp(`^/images/${IMAGE_REF}$`), what: "delete an image whose digest did not match" },
];

export class DockerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type Raw = { status: number; body: Buffer };
/** The transport: a unix socket in production, a recording fake in tests. */
export type Transport = (method: string, path: string, body: unknown) => Promise<Raw>;

export function socketTransport(socketPath: string, timeoutMs = 60_000): Transport {
  return (method, path, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
        { socketPath, method, path, headers: { host: "docker", ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) }, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      req.on("timeout", () => req.destroy(new Error(`Docker did not answer ${method} ${path}`)));
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
}

/** The create body the updater may send: a one-shot container with one named volume, no capability, nothing host-wide. */
export function assertSafeCreate(spec: unknown, allow: { volume: string; network: string; labelKey: string; labelValue: string }): void {
  const refuse = (why: string): never => {
    throw new UpdaterError("docker_refused", `The updater refused to create a container: ${why}.`);
  };
  if (!spec || typeof spec !== "object") return refuse("no spec");
  const s = spec as { Image?: unknown; Labels?: Record<string, string>; HostConfig?: Record<string, unknown>; User?: unknown };
  if (typeof s.Image !== "string" || !/^[a-z0-9.:/_-]+@sha256:[0-9a-f]{64}$/.test(s.Image)) refuse("the image is not named by digest");
  if (s.Labels?.[allow.labelKey] !== allow.labelValue) refuse("it does not carry this install's label");
  if (s.User !== "1000:1000") refuse("it would not run as the unprivileged user");
  const h = s.HostConfig ?? {};
  if (h["Privileged"] !== false) refuse("it is not marked unprivileged");
  if (h["Binds"] !== undefined) refuse("it asks for a host folder");
  if (Array.isArray(h["Devices"]) && h["Devices"].length > 0) refuse("it asks for a device");
  if (Array.isArray(h["CapAdd"]) && h["CapAdd"].length > 0) refuse("it asks for an extra capability");
  if (!Array.isArray(h["CapDrop"]) || !(h["CapDrop"] as string[]).includes("ALL")) refuse("it does not drop all capabilities");
  if (h["NetworkMode"] !== allow.network) refuse("it is not on the install's own network");
  if (h["PidMode"] !== "" && h["PidMode"] !== undefined) refuse("it asks for another process space");
  const mounts = h["Mounts"];
  if (!Array.isArray(mounts) || mounts.length !== 1) refuse("it must mount exactly the pack volume");
  const m = (mounts as Record<string, unknown>[])[0]!;
  if (m["Type"] !== "volume" || m["Source"] !== allow.volume) refuse("it mounts something other than the pack volume");
}

export type ContainerInfo = { Id: string; Name?: string; Config: { Labels: Record<string, string> | null }; State: { Status?: string; Running?: boolean; ExitCode?: number } };
export type ImageInfo = { Id: string; Architecture?: string; RepoDigests?: string[] };

export type DockerOptions = { installLabel: string; volume: string; network: string };

export function dockerClient(transport: Transport, opts: DockerOptions) {
  const [labelKey = "", labelValue = ""] = opts.installLabel.split("=", 2);
  const call = async (method: Allowed["method"], path: string, body?: unknown): Promise<Raw> => {
    if (!ALLOWED_CALLS.some((a) => a.method === method && a.pattern.test(path))) throw new UpdaterError("docker_refused", `The updater refused a Docker call it is not allowed to make (${method}).`);
    return transport(method, path, body);
  };
  const json = <T>(r: Raw): T | null => {
    try {
      return r.body.length ? (JSON.parse(r.body.toString("utf8")) as T) : null;
    } catch {
      return null;
    }
  };
  const fail = (r: Raw, what: string): never => {
    const j = json<{ message?: string }>(r);
    throw new DockerError(r.status, `${what}: ${j?.message ?? `HTTP ${r.status}`}`);
  };
  /** Reads a container and refuses it unless it carries this install's label. null = no such container. */
  async function inspectOurs(id: string): Promise<ContainerInfo | null> {
    const r = await call("GET", `/containers/${encodeURIComponent(id)}/json`);
    if (r.status === 404) return null;
    const info = r.status === 200 ? json<ContainerInfo>(r) : fail(r, "Inspecting the container failed");
    if (!info || info.Config?.Labels?.[labelKey] !== labelValue) throw new UpdaterError("docker_refused", "The updater refused to touch a container that is not part of this install.");
    return info;
  }
  const ours = async (id: string): Promise<ContainerInfo> => {
    const info = await inspectOurs(id);
    if (!info) throw new DockerError(404, "No such container");
    return info;
  };

  return {
    /** The daemon's CPU architecture as the releases name it, or null if it will not say. */
    async arch(): Promise<string | null> {
      const r = await call("GET", "/info");
      const a = r.status === 200 ? json<{ Architecture?: string }>(r)?.Architecture : undefined;
      return a === "x86_64" ? "amd64" : a === "aarch64" ? "arm64" : (a ?? null);
    },
    inspectOurs,
    async create(name: string, spec: { Labels?: Record<string, string> } & Record<string, unknown>): Promise<string> {
      assertSafeCreate(spec, { volume: opts.volume, network: opts.network, labelKey, labelValue });
      const r = await call("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
      const j = r.status === 201 ? json<{ Id: string }>(r) : null;
      return j?.Id ?? fail(r, "Creating the container failed");
    },
    async start(id: string) {
      await ours(id);
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/start`);
      if (r.status !== 204 && r.status !== 304) fail(r, "Starting the container failed");
    },
    /** Removes a container of this install (stopping it first if it still runs). Gone already is fine. */
    async remove(id: string) {
      if (!(await inspectOurs(id))) return;
      const r = await call("DELETE", `/containers/${encodeURIComponent(id)}?force=1&v=1`);
      if (r.status !== 204 && r.status !== 404) fail(r, "Removing the container failed");
    },
    /** The last lines of a container's output (Docker's stream framing removed). */
    async logs(id: string, tail = 50): Promise<string> {
      await ours(id);
      const r = await call("GET", `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${Math.min(Math.max(tail, 1), 9999)}`);
      if (r.status !== 200) fail(r, "Reading the container's output failed");
      return demux(r.body);
    },
    /** Polls until the container stops or `timeoutMs` passes. `sleep` is injected so tests never wait. */
    async wait(id: string, timeoutMs: number, pollMs: number, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)), now: () => number = Date.now): Promise<{ stopped: boolean; exitCode: number | null }> {
      const deadline = now() + timeoutMs;
      for (;;) {
        const info = await ours(id);
        if (info.State.Running === false) return { stopped: true, exitCode: typeof info.State.ExitCode === "number" ? info.State.ExitCode : null };
        const left = deadline - now();
        if (left <= 0) return { stopped: false, exitCode: null };
        await sleep(Math.min(pollMs, left));
      }
    },
    /** Starts a pull of `ref` (which names a digest) and waits for the stream to end; the daemon reports failures in the stream. */
    async pull(ref: string): Promise<void> {
      const r = await call("POST", `/images/create?fromImage=${encodeURIComponent(ref)}`);
      if (r.status !== 200) fail(r, "Pulling the image failed");
      for (const line of r.body.toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line) as { error?: string };
          if (j.error) throw new DockerError(500, `Pulling the image failed: ${j.error}`);
        } catch (e) {
          if (e instanceof DockerError) throw e;
        }
      }
    },
    async imageInfo(ref: string): Promise<ImageInfo | null> {
      const r = await call("GET", `/images/${encodeURIComponent(ref)}/json`);
      if (r.status === 404) return null;
      return r.status === 200 ? json<ImageInfo>(r) : fail(r, "Reading the image failed");
    },
    async removeImage(ref: string) {
      const r = await call("DELETE", `/images/${encodeURIComponent(ref)}`);
      if (r.status !== 200 && r.status !== 404) fail(r, "Removing the image failed");
    },
  };
}

export type Docker = ReturnType<typeof dockerClient>;

/** Docker frames a non-terminal container's output as [stream, 0, 0, 0, size(4 bytes BE)] + payload. */
export function demux(buf: Buffer): string {
  const out: string[] = [];
  let i = 0;
  while (i + 8 <= buf.length && buf[i]! <= 2 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0) {
    const size = buf.readUInt32BE(i + 4);
    out.push(buf.subarray(i + 8, i + 8 + size).toString("utf8"));
    i += 8 + size;
  }
  return i === 0 ? buf.toString("utf8") : out.join("");
}
