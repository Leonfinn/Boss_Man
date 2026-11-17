// R31 (BOS-1666): owner-card steps that run docker compose are checked against what the host reported about its
// compose stack: the compose files in COMPOSE_FILE, whether it runs blue/green and which colour leads. The first
// draft of the roadmap tunnel card (BOS-1574) edited COMPOSE_FILE and then ran `{{host.compose.cmd}} up -d
// cloudflared`: the token is filled from the LAST host report, so its -f list lacked the new file, and a bare `up`
// under blue/green would also have started the parked standby colour. Nothing checked either.
//
// Generic by design: every fact comes from the host report (host-facts.ts, `compose.*`); no host, path or address
// is named here. Without the facts (no report, an older deployer) the rules that need them stay quiet.
//
// R31a  a step edits COMPOSE_FILE, and a later step uses the filled `{{host.compose.cmd}}`; or a `-f` file that the
//       host didn't report and no earlier step adds.
// R31b  blue/green: `up` or `start` that names no service. (`--no-deps` is not demanded: the host report has no
//       service graph, and a service that depends on no colour, like a tunnel, starts correctly without it.)
// R31c  a colour service name (server-blue, server-green, with or without -front) in a value that lasts (a URL, a
//       .env line, a tunnel or bookmark), or in a command when the live colour is unknown or the name is the standby.
// R31d  blue/green: `restart`, `start` or `up` of the service called `server`, which is parked in a profile.
import { type LintFinding, shellCommands } from "./steps.js";

/** What the host reported about its compose stack (flattened keys `compose.files`, `compose.bluegreen`, `compose.liveColour`, `compose.cmd`). */
export type ComposeFacts = { files: string[]; bluegreen: boolean; liveColour: string; /** The filled `{{host.compose.cmd}}`, when the host gave one. */ cmd?: string };

/** The compose facts from the recorded host values; undefined when the host reported none of them. */
export function composeFactsFrom(values: Readonly<Record<string, string>> | undefined): ComposeFacts | undefined {
  if (!values) return undefined;
  const has = (k: string) => Object.hasOwn(values, k);
  if (!has("compose.files") && !has("compose.bluegreen") && !has("compose.liveColour")) return undefined;
  const cmd = has("compose.cmd") ? values["compose.cmd"] : undefined;
  return {
    files: (values["compose.files"] ?? "").split(",").map((f) => f.trim()).filter(Boolean),
    bluegreen: values["compose.bluegreen"] === "true",
    liveColour: (values["compose.liveColour"] ?? "").trim().toLowerCase(),
    ...(cmd ? { cmd } : {}),
  };
}

/** A step as the check reads it: its sentences and its code (command blocks and inline code). */
export type ComposeStep = { prose: string; code: string[] };

const COLOUR = /\bserver-(blue|green)(-front)?\b/g;
const YAML_FILE = /^[\w./-]+\.ya?ml$/i;
const norm = (f: string) => f.replace(/^\.\//, "").replace(/^['"]|['"]$/g, "");
/** Same file, whether the host wrote a relative or a full path and the card the other. */
const sameFile = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith("/" + y) || y.endsWith("/" + x);
};

/** The step edits the list in COMPOSE_FILE (adds or removes a file): an assignment, or the word for doing so. */
function editsComposeFile(s: ComposeStep): boolean {
  const text = [s.prose, ...s.code].join("\n");
  if (/COMPOSE_FILE/.test(text) === false) return false;
  return /COMPOSE_FILE\s*=/.test(text) || /\b(add|adds|adding|append|remove|removing|edit|change|extend|include|drop|delete|set|put)\w*\b/i.test(s.prose);
}

type Compose = { files: string[]; sub: string | null; args: string[] };
/** The `docker compose` / `docker-compose` invocations in a piece of shell: their -f files, subcommand and the words after it. */
function composeCommands(code: string): Compose[] {
  const out: Compose[] = [];
  for (const { words: raw } of shellCommands(code)) {
    const words = raw.map((w) => w.replace(/^(['"])(.*)\1$/s, "$2"));
    let i = words.findIndex((w, k) => (w === "docker" && words[k + 1] === "compose") || w === "docker-compose");
    if (i < 0) continue;
    i += words[i] === "docker" ? 2 : 1;
    const files: string[] = [];
    let sub: string | null = null;
    for (; i < words.length; i++) {
      const w = words[i]!;
      if (w === "-f" || w === "--file") { if (words[i + 1]) files.push(words[++i]!); continue; }
      if (w.startsWith("--file=")) { files.push(w.slice(7)); continue; }
      if (["-p", "--project-name", "--profile", "--env-file", "--project-directory", "--parallel", "--ansi", "--progress"].includes(w)) { i++; continue; }
      if (w.startsWith("-")) continue;
      sub = w;
      i++;
      break;
    }
    out.push({ files, sub, args: words.slice(i) });
  }
  return out;
}

/** Options of `up`/`start` that take a value as the next word, so it isn't mistaken for a service. */
const VALUE_FLAGS = new Set(["-t", "--timeout", "--scale", "--attach", "--no-attach", "--exit-code-from", "--pull", "--wait-timeout"]);
/** The service names after the subcommand: the words that are neither options nor an option's value. */
function servicesIn(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!;
    if (VALUE_FLAGS.has(w)) { i++; continue; }
    if (w.startsWith("-")) continue;
    out.push(w);
  }
  return out;
}

/** Words that say a sentence is about something that lasts: a tunnel or proxy target, a bookmark, a .env value. */
const LASTING_PROSE = /\b(tunnel|proxy|bookmark|url|hostname|origin|ingress|upstream|\.env|dns|public)\b/i;

export function composeFindings(steps: readonly ComposeStep[], facts: ComposeFacts | undefined): LintFinding[] {
  if (!facts) return [];
  const out: LintFinding[] = [];
  const say = (step: number, rule: "R31", problem: string) => { if (!out.some((f) => f.step === step && f.problem === problem)) out.push({ step, rule, problem }); };
  const added: string[] = []; // files an earlier (or this) step names in a COMPOSE_FILE edit
  let editedAt = 0;
  steps.forEach((s, i) => {
    const step = i + 1;
    if (editsComposeFile(s)) {
      if (!editedAt) editedAt = step;
      for (const m of [s.prose, ...s.code].join("\n").matchAll(/[\w./-]+\.ya?ml\b/gi)) added.push(m[0]);
    }
    const text = [s.prose, ...s.code].join("\n");
    const cmds = s.code.flatMap(composeCommands);

    // R31a: the filled `{{host.compose.cmd}}` after the card changed COMPOSE_FILE.
    if (editedAt && facts.cmd && facts.files.length && s.code.some((c) => c.includes(facts.cmd!))) {
      say(step, "R31", `R31a: uses {{host.compose.cmd}} after step ${editedAt} changes COMPOSE_FILE, but that command lists the compose files from the host's last report, without the change. Use \`cd {{host.paths.src}} && docker compose …\`, which reads COMPOSE_FILE from .env`);
    }
    // R31a: a -f file the host didn't report and no step up to here adds.
    if (facts.files.length) {
      for (const c of cmds)
        for (const f of c.files) {
          if (!YAML_FILE.test(norm(f))) continue;
          if (facts.files.some((r) => sameFile(r, f)) || added.some((a) => sameFile(a, f))) continue;
          say(step, "R31", `R31a: names the compose file ${norm(f)}, which the host doesn't list in its compose files (${facts.files.join(", ")}) and no earlier step adds. Add it to COMPOSE_FILE in an earlier step, or use a file the host reports`);
        }
    }

    if (!facts.bluegreen) return;
    for (const c of cmds) {
      const services = servicesIn(c.args);
      // R31b
      if ((c.sub === "up" || c.sub === "start") && !services.length)
        say(step, "R31", `R31b: runs \`docker compose ${c.sub}\` with no service named. On a blue/green host that starts every service, including the standby colour. Name the service you mean (for example \`up -d --no-deps <service>\`)`);
      // R31d
      if ((c.sub === "restart" || c.sub === "up" || c.sub === "start") && services.includes("server"))
        say(step, "R31", `R31d: runs \`docker compose ${c.sub} server\`, but on a blue/green host the service "server" is parked in a profile, so this does nothing or fails. The live colour is served through the proxy under the name "server"; restart the proxy, or the colour the host reports as live`);
    }

    // R31c, in a command run now: the live colour must be known, and it must not be the standby.
    for (const code of s.code) {
      for (const { words } of shellCommands(code)) {
        if (!words.some((w) => w === "docker" || w === "docker-compose")) continue;
        for (const w of words) {
          for (const m of w.matchAll(COLOUR)) {
            const colour = m[1]!;
            if (!/blue|green/.test(facts.liveColour)) {
              say(step, "R31", `R31c: names ${m[0]}, but the host hasn't reported which colour is live, so this may be the standby. Name the service "server" (the proxy's alias), or wait for the host's report`);
            } else if (!facts.liveColour.includes(colour)) {
              say(step, "R31", `R31c: names ${m[0]}, the standby colour (the live one is ${facts.liveColour}). Starting or changing the standby is the deploy's job, not a card's`);
            }
          }
        }
      }
    }
    // R31c, in a value that lasts: the live colour flips at the next deploy, so a URL, a .env line or a bookmark naming one breaks.
    const lasting = (m: string) => say(step, "R31", `R31c: puts ${m} in a value that lasts (a URL, a .env line, a tunnel or bookmark). The live colour changes at the next deploy; use "server", the proxy's alias, which always reaches the live one`);
    for (const m of text.matchAll(/(?:[a-z][a-z0-9+.-]*:\/\/|=\s*['"]?)[^\s'"]*?(server-(?:blue|green)(?:-front)?)\b/gi)) lasting(m[1]!);
    for (const m of text.matchAll(/\bserver-(?:blue|green)(?:-front)?:\d+/gi)) lasting(m[0].replace(/:\d+$/, ""));
    for (const m of s.prose.matchAll(COLOUR)) if (LASTING_PROSE.test(s.prose)) lasting(m[0]);
  });
  return out;
}
