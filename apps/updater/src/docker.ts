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
  // 941b: the swap.
  { method: "GET", pattern: /^\/containers\/json\?all=1&filters=[A-Za-z0-9%._=-]{1,300}$/, what: "list this install's containers by label (colours, standby)" },
  { method: "POST", pattern: new RegExp(`^/containers/${ID}/stop\\?t=[0-9]{1,4}$`), what: "stop a container of this install (the old colour becomes the standby)" },
  { method: "POST", pattern: new RegExp(`^/containers/${ID}/kill\\?signal=SIG(USR1|USR2)$`), what: "demote (USR1) or promote (USR2) a server colour, as the host deployer does" },
  { method: "POST", pattern: new RegExp(`^/containers/${ID}/rename\\?name=${ID}$`), what: "name the new updater after the hand-over" },
  { method: "POST", pattern: new RegExp(`^/containers/${ID}/update$`), what: "set the old updater's restart policy to no at the hand-over" },
  { method: "POST", pattern: new RegExp(`^/networks/${ID}/connect$`), what: "attach a colour to a network with its aliases (flip: new colour first)" },
  { method: "POST", pattern: new RegExp(`^/networks/${ID}/disconnect$`), what: "detach a colour from a network (flip)" },
  { method: "POST", pattern: new RegExp(`^/containers/${ID}/exec$`), what: "create the fixed pg_dump command in the database container" },
  { method: "POST", pattern: /^\/exec\/[0-9a-f]{64}\/start$/, what: "run that command" },
  { method: "GET", pattern: /^\/exec\/[0-9a-f]{64}\/json$/, what: "read that command's exit code" },
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

export type ServerKind = "colour" | "migrate" | "updater";
export type ServerAllow = { labelKey: string; labelValue: string; networks: string[]; volumes: string[]; kind: ServerKind; /** The one bind an updater may have: the Docker socket, `<host path>:/var/run/docker.sock`. */ socketBind?: string };

/**
 * What a server colour, the migrate one-shot or the next updater may ask for. Everything is built from the colour spec (src/spec.ts),
 * never from input or an inspect result; this check is the second lock: a digest image, this install's label, no privilege, no
 * capability beyond the updater's two, only named volumes the install lists, only the install's networks.
 */
export function assertSafeServerCreate(spec: unknown, allow: ServerAllow): void {
  const refuse = (why: string): never => {
    throw new UpdaterError("docker_refused", `The updater refused to create a container: ${why}.`);
  };
  if (!spec || typeof spec !== "object") return refuse("no spec");
  const s = spec as { Image?: unknown; Labels?: Record<string, string>; HostConfig?: Record<string, unknown>; User?: unknown; Env?: unknown };
  if (typeof s.Image !== "string" || !/^[a-z0-9.:/_-]+@sha256:[0-9a-f]{64}$/.test(s.Image)) refuse("the image is not named by digest");
  if (s.Labels?.[allow.labelKey] !== allow.labelValue) refuse("it does not carry this install's label");
  if (s.Env !== undefined && (!Array.isArray(s.Env) || !s.Env.every((e) => typeof e === "string"))) refuse("its environment is not a list of KEY=value text");
  if (allow.kind === "updater" ? s.User !== "0:0" : s.User !== undefined && s.User !== "") refuse("it sets a user the spec does not");
  const h = s.HostConfig ?? {};
  if (h["Privileged"] !== false) refuse("it is not marked unprivileged");
  if (Array.isArray(h["Devices"]) && h["Devices"].length > 0) refuse("it asks for a device");
  const capAdd = Array.isArray(h["CapAdd"]) ? (h["CapAdd"] as string[]) : [];
  if (allow.kind === "updater" ? capAdd.slice().sort().join() !== "SETGID,SETUID" : capAdd.length > 0) refuse("it asks for an extra capability");
  if (!Array.isArray(h["CapDrop"]) || !(h["CapDrop"] as string[]).includes("ALL")) refuse("it does not drop all capabilities");
  if (typeof h["NetworkMode"] !== "string" || !allow.networks.includes(h["NetworkMode"])) refuse("it is not on one of the install's own networks");
  for (const k of ["PidMode", "UTSMode", "UsernsMode", "CgroupnsMode"]) if (h[k] !== undefined && h[k] !== "" && h[k] !== "private") refuse(`it asks for another ${k}`);
  if (h["IpcMode"] !== undefined && h["IpcMode"] !== "" && h["IpcMode"] !== "private") refuse("it asks to share another process space");
  if (Array.isArray(h["Binds"]) && h["Binds"].length > 0) {
    if (allow.kind !== "updater" || !allow.socketBind || h["Binds"].length !== 1 || h["Binds"][0] !== allow.socketBind) refuse("it asks for a host folder");
  } else if (allow.kind === "updater" && allow.socketBind) refuse("the next updater would have no Docker socket");
  const mounts = Array.isArray(h["Mounts"]) ? (h["Mounts"] as Record<string, unknown>[]) : [];
  for (const m of mounts) if (m["Type"] !== "volume" || typeof m["Source"] !== "string" || !allow.volumes.includes(m["Source"])) refuse("it mounts something the install does not list");
  if (!(allow.kind === "migrate") && h["RestartPolicy"] === undefined) refuse("it has no restart policy");
}

export type ContainerInfo = {
  Id: string;
  Name?: string;
  Image?: string;
  Created?: string;
  Config: { Labels: Record<string, string> | null; Image?: string };
  State: { Status?: string; Running?: boolean; ExitCode?: number };
  NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] | null }> };
};
export type ImageInfo = { Id: string; Architecture?: string; RepoDigests?: string[] };

export type DockerOptions = { installLabel: string; volume: string; network: string; /** Networks the swap may attach containers to. */ networks?: string[]; /** Named volumes a colour may mount. */ volumes?: string[]; socketBind?: string };

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
    /** A server colour, the migrate one-shot or the next updater, from the colour spec (checked by assertSafeServerCreate). */
    async createServer(name: string, spec: { Labels?: Record<string, string> } & Record<string, unknown>, kind: ServerKind): Promise<string> {
      assertSafeServerCreate(spec, { labelKey, labelValue, networks: opts.networks ?? [opts.network], volumes: opts.volumes ?? [], kind, socketBind: opts.socketBind });
      const r = await call("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec);
      const j = r.status === 201 ? json<{ Id: string }>(r) : null;
      return j?.Id ?? fail(r, "Creating the container failed");
    },
    /** This install's containers that carry a label key (any value). */
    async listByLabel(key: string): Promise<ContainerInfo[]> {
      const filters = encodeURIComponent(JSON.stringify({ label: [`${labelKey}=${labelValue}`, key] }));
      const r = await call("GET", `/containers/json?all=1&filters=${filters}`);
      const rows = r.status === 200 ? (json<{ Id: string }[]>(r) ?? []) : fail(r, "Listing the containers failed");
      const out: ContainerInfo[] = [];
      for (const row of rows) {
        const info = await inspectOurs(row.Id);
        if (info) out.push(info);
      }
      return out;
    },
    async stop(id: string, graceSeconds: number) {
      await ours(id);
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/stop?t=${Math.min(Math.max(Math.trunc(graceSeconds), 0), 9999)}`);
      if (r.status !== 204 && r.status !== 304) fail(r, "Stopping the container failed");
    },
    async signal(id: string, sig: "SIGUSR1" | "SIGUSR2") {
      await ours(id);
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/kill?signal=${sig}`);
      if (r.status !== 204) fail(r, "Signalling the container failed");
    },
    async rename(id: string, name: string) {
      await ours(id);
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`);
      if (r.status !== 204) fail(r, "Renaming the container failed");
    },
    async setRestartNever(id: string) {
      await ours(id);
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/update`, { RestartPolicy: { Name: "no" } });
      if (r.status !== 200) fail(r, "Changing the container's restart policy failed");
    },
    async setRestartUnlessStopped(id: string) {
      await ours(id);
      const r = await call("POST", `/containers/${encodeURIComponent(id)}/update`, { RestartPolicy: { Name: "unless-stopped" } });
      if (r.status !== 200) fail(r, "Changing the container's restart policy failed");
    },
    /** Attaches a container to one of the install's networks (never another). With aliases, they are the only extra names. */
    async connect(network: string, id: string, aliases: string[]) {
      if (!(opts.networks ?? [opts.network]).includes(network)) throw new UpdaterError("docker_refused", "The updater refused to attach a container to a network that is not part of this install.");
      await ours(id);
      const r = await call("POST", `/networks/${encodeURIComponent(network)}/connect`, { Container: id, EndpointConfig: { Aliases: aliases } });
      if (r.status !== 200 && !(r.status === 403 && /already exists/i.test(r.body.toString("utf8")))) fail(r, "Attaching the container to the network failed");
    },
    async disconnect(network: string, id: string) {
      if (!(opts.networks ?? [opts.network]).includes(network)) throw new UpdaterError("docker_refused", "The updater refused to detach a container from a network that is not part of this install.");
      await ours(id);
      const r = await call("POST", `/networks/${encodeURIComponent(network)}/disconnect`, { Container: id, Force: false });
      // "is not connected" (a retry after a restart) is the state we wanted.
      if (r.status !== 200 && !/is not connected/i.test(r.body.toString("utf8"))) fail(r, "Detaching the container from the network failed");
    },
    /** Runs one fixed command in a container of this install (the backup). The command is built by the updater, never from input. */
    async exec(id: string, cmd: string[], user: string): Promise<{ exitCode: number; output: string }> {
      await ours(id);
      const c = await call("POST", `/containers/${encodeURIComponent(id)}/exec`, { AttachStdout: true, AttachStderr: true, Tty: false, User: user, Cmd: cmd });
      const execId = c.status === 201 ? json<{ Id: string }>(c)?.Id : undefined;
      if (!execId) return fail(c, "Preparing the command failed");
      const s = await call("POST", `/exec/${execId}/start`, { Detach: false, Tty: false });
      if (s.status !== 200) fail(s, "Running the command failed");
      const i = await call("GET", `/exec/${execId}/json`);
      const code = i.status === 200 ? json<{ ExitCode?: number }>(i)?.ExitCode : undefined;
      return { exitCode: typeof code === "number" ? code : -1, output: demux(s.body) };
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
