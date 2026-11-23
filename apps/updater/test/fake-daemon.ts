// A small stateful fake of the Docker daemon, for the swap tests: containers with labels, networks and aliases, signals that
// change a colour's role, exec, and a recording of every call. It also answers the updater's /api/ready probe from the same state.
import { dockerClient, type Raw, type Transport } from "../src/docker.js";
import type { Probe, Clock } from "../src/swap.js";
import { framed, testConfig, tmpDir, type Call } from "./helpers.js";
import { stateStore } from "../src/state.js";

export type Fc = {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  env: string[];
  running: boolean;
  exitCode: number;
  role: "leader" | "standby";
  commit: string;
  healthy: boolean;
  networks: Record<string, string[]>;
  restart: string;
  created: number;
};

export const PACK_HASH = "0123456789abcdef01234567";
export const OLD_COMMIT ="b".repeat(40);
export const NEW_COMMIT = "a".repeat(40);
export const LABEL = "boss-man.install";

export function swapConfig(over: Record<string, string> = {}) {
  return testConfig({
    UPDATER_FRONT_NETWORK: "test_front",
    UPDATER_LAUNCHER_NETWORK: "test_launcher",
    UPDATER_DB_CONTAINER: "test-db",
    UPDATER_SELF_NETWORK: "test_updater",
    UPDATER_SPEC_ENV: "DATABASE_URL=postgres://bossman@db:5432/bossman\nBOSSMAN_DATABASE_PASSWORD_FILE=/run/db/db_password\nBOSSMAN_LAUNCHER=1",
    UPDATER_SPEC_MOUNTS: "test_config:/run/config:ro\ntest_db-secret:/run/db:ro\ntest_launcher-key:/run/launcher:ro",
    UPDATER_SELF_MOUNTS: "test_updater-state:/state\ntest_updater-key:/run/updater",
    UPDATER_HANDOVER_CALL_SECONDS: "1",
    UPDATER_CURRENT_VERSION: "0.0.9",
    ...over,
  });
}

export class FakeDaemon {
  containers = new Map<string, Fc>();
  images = new Set<string>();
  calls: Call[] = [];
  signals: string[] = [];
  nextId = 1;
  /** Test hooks. */
  execExit = 0;
  migrateExit = 0;
  /** A colour started from a new image answers ready at this commit. */
  newBootsHealthy = true;
  /** Called with the container name when it starts. */
  onStart?: (name: string) => void;
  /** Return a Raw to fail a call. */
  failCall?: (c: Call) => Raw | undefined;
  time = 0;

  constructor(readonly front = "test_front") {}

  addLive(colour: "blue" | "green", release: string, opts: { running?: boolean; live?: boolean; digestChar?: string } = {}) {
    const name = `server-${colour}`;
    const live = opts.live ?? true;
    const c: Fc = {
      id: `id${this.nextId++}`.padEnd(12, "0"),
      name,
      image: `ghcr.io/leonfinn/boss-man-server@sha256:${(opts.digestChar ?? "9").repeat(64)}`,
      labels: { [LABEL]: "test", "com.bossman.managed": "1", "com.bossman.colour": colour, "com.bossman.release": release, "com.bossman.digest": `sha256:${(opts.digestChar ?? "9").repeat(64)}` },
      env: [],
      running: opts.running ?? true,
      exitCode: 0,
      role: live ? "leader" : "standby",
      commit: OLD_COMMIT,
      healthy: true,
      networks: { test_default: [], test_launcher: [], [this.front]: live ? [`server-${colour}-front`, "server-live"] : [`server-${colour}-front`] },
      restart: "unless-stopped",
      created: this.nextId,
    };
    this.containers.set(name, c);
    return c;
  }

  addPlain(name: string, labels: Record<string, string> = { [LABEL]: "test" }, image = "x") {
    const c: Fc = { id: `id${this.nextId++}`.padEnd(12, "0"), name, image, labels, env: [], running: true, exitCode: 0, role: "leader", commit: "", healthy: true, networks: {}, restart: "unless-stopped", created: this.nextId };
    this.containers.set(name, c);
    return c;
  }

  find = (idOrName: string) => [...this.containers.values()].find((c) => c.name === idOrName || c.id === idOrName);
  holder = (alias: string) => [...this.containers.values()].find((c) => c.running && Object.values(c.networks).some((a) => a.includes(alias)));
  /** Names of every container except the database. */
  names = () => [...this.containers.keys()].filter((n) => n !== "test-db");

  private info(c: Fc) {
    return {
      Id: c.id,
      Name: `/${c.name}`,
      Image: c.image,
      Config: { Labels: c.labels, Image: c.image },
      State: { Running: c.running, Status: c.running ? "running" : "exited", ExitCode: c.exitCode },
      NetworkSettings: { Networks: Object.fromEntries(Object.entries(c.networks).map(([n, a]) => [n, { Aliases: a }])) },
    };
  }

  probe: Probe = async (host) => {
    const c = this.holder(host);
    if (!c) return null;
    if (!c.healthy) return { ok: false, role: c.role, commit: c.commit };
    return { ok: true, role: c.role, commit: c.commit };
  };

  clock: Clock = { now: () => this.time, sleep: async (ms) => void (this.time += ms) };

  transport: Transport = async (method, path, body) => {
    this.calls.push({ method, path, body });
    const injected = this.failCall?.({ method, path, body });
    if (injected) return injected;
    const j = (status: number, json: unknown): Raw => ({ status, body: Buffer.from(JSON.stringify(json)) });
    const empty = (status: number): Raw => ({ status, body: Buffer.alloc(0) });
    let m: RegExpExecArray | null;
    if (method === "GET" && path.startsWith("/containers/json")) {
      const f = JSON.parse(decodeURIComponent(path.split("filters=")[1]!)) as { label: string[] };
      const rows = [...this.containers.values()].filter((c) => f.label.every((l) => (l.includes("=") ? c.labels[l.split("=")[0]!] === l.split("=")[1] : l in c.labels)));
      return j(200, rows.map((c) => ({ Id: c.id })));
    }
    if (method === "GET" && /^\/containers\/[^/]+\/logs\?/.test(path)) return { status: 200, body: framed(`[claude-pack] ready: /opt/bossman-claude/${PACK_HASH} (Claude Code 2.1.0)\n`) };
    if (method === "GET" && (m = /^\/containers\/([^/]+)\/json$/.exec(path))) {
      const c = this.find(m[1]!);
      return c ? j(200, this.info(c)) : j(404, { message: "no such container" });
    }
    if (method === "POST" && (m = /^\/containers\/create\?name=(.+)$/.exec(path))) {
      const name = decodeURIComponent(m[1]!);
      if (this.containers.has(name)) return j(409, { message: "name in use" });
      const b = body as { Image: string; Labels: Record<string, string>; Env?: string[]; HostConfig: { NetworkMode: string; RestartPolicy?: { Name: string } } };
      const colour = b.Labels["com.bossman.colour"];
      const c: Fc = {
        id: `id${this.nextId++}`.padEnd(12, "0"),
        name,
        image: b.Image,
        labels: b.Labels,
        env: b.Env ?? [],
        running: false,
        exitCode: 0,
        role: "standby",
        commit: NEW_COMMIT,
        healthy: this.newBootsHealthy,
        networks: { [b.HostConfig.NetworkMode]: [] },
        restart: b.HostConfig.RestartPolicy?.Name ?? "",
        created: this.nextId,
      };
      void colour;
      this.containers.set(name, c);
      return j(201, { Id: c.id });
    }
    if (method === "POST" && (m = /^\/containers\/([^/]+)\/start$/.exec(path))) {
      const c = this.find(m[1]!);
      if (!c) return j(404, { message: "no such container" });
      c.running = true;
      if (c.name.endsWith("-migrate")) {
        c.running = false;
        c.exitCode = this.migrateExit;
      }
      if (c.name.endsWith("-pack")) c.running = false;
      this.onStart?.(c.name);
      return empty(204);
    }
    if (method === "POST" && (m = /^\/containers\/([^/]+)\/stop\?t=\d+$/.exec(path))) {
      const c = this.find(m[1]!);
      if (!c) return j(404, { message: "no such container" });
      c.running = false;
      return empty(204);
    }
    if (method === "POST" && (m = /^\/containers\/([^/]+)\/kill\?signal=(SIGUSR[12])$/.exec(path))) {
      const c = this.find(m[1]!);
      if (!c || !c.running) return j(409, { message: "not running" });
      this.signals.push(`${c.name} ${m[2]}`);
      c.role = m[2] === "SIGUSR1" ? "standby" : "leader";
      return empty(204);
    }
    if (method === "POST" && (m = /^\/containers\/([^/]+)\/rename\?name=(.+)$/.exec(path))) {
      const c = this.find(m[1]!);
      if (!c) return j(404, { message: "no such container" });
      this.containers.delete(c.name);
      c.name = decodeURIComponent(m[2]!);
      this.containers.set(c.name, c);
      return empty(204);
    }
    if (method === "POST" && (m = /^\/containers\/([^/]+)\/update$/.exec(path))) {
      const c = this.find(m[1]!);
      if (!c) return j(404, { message: "no such container" });
      c.restart = (body as { RestartPolicy: { Name: string } }).RestartPolicy.Name;
      return j(200, {});
    }
    if (method === "DELETE" && (m = /^\/containers\/([^/?]+)\?force=1&v=1$/.exec(path))) {
      const c = this.find(m[1]!);
      if (!c) return j(404, { message: "no such container" });
      this.containers.delete(c.name);
      return empty(204);
    }
    if (method === "POST" && (m = /^\/networks\/([^/]+)\/(connect|disconnect)$/.exec(path))) {
      const b = body as { Container: string; EndpointConfig?: { Aliases: string[] } };
      const c = this.find(b.Container);
      if (!c) return j(404, { message: "no such container" });
      if (m[2] === "connect") {
        if (c.networks[m[1]!]) return j(403, { message: "endpoint with name already exists in network" });
        c.networks[m[1]!] = b.EndpointConfig?.Aliases ?? [];
      } else {
        if (!c.networks[m[1]!]) return j(500, { message: `container ${c.id} is not connected to network ${m[1]}` });
        delete c.networks[m[1]!];
      }
      return j(200, {});
    }
    if (method === "POST" && /^\/containers\/[^/]+\/exec$/.test(path)) return j(201, { Id: "e".repeat(64) });
    if (method === "POST" && /^\/exec\/[0-9a-f]{64}\/start$/.test(path)) {
      const cmd = this.calls.filter((c) => c.path.endsWith("/exec")).at(-1)!.body as { Cmd: string[] };
      const file = /(bossman-[0-9]{8}-[0-9]{6}\.sql\.gz)/.exec(cmd.Cmd.join(" "))?.[1];
      const out = Buffer.from(this.execExit === 0 ? `saved ${file}\n` : "pg_dump: error\n");
      const head = Buffer.alloc(8);
      head[0] = 1;
      head.writeUInt32BE(out.length, 4);
      return { status: 200, body: Buffer.concat([head, out]) };
    }
    if (method === "GET" && /^\/exec\/[0-9a-f]{64}\/json$/.test(path)) return j(200, { ExitCode: this.execExit });
    if (method === "POST" && path.startsWith("/images/create")) {
      this.images.add(decodeURIComponent(path.split("fromImage=")[1]!));
      return { status: 200, body: Buffer.from("{}\n") };
    }
    if (method === "GET" && path.startsWith("/images/")) {
      const ref = decodeURIComponent(path.slice("/images/".length, -"/json".length));
      return this.images.has(ref) ? j(200, { Id: "sha256:i", Architecture: "arm64", RepoDigests: [ref] }) : j(404, { message: "no such image" });
    }
    if (method === "DELETE" && path.startsWith("/images/")) return j(200, []);
    return j(404, { message: "no such thing" });
  };
}

export { dockerClient, stateStore, tmpDir };
