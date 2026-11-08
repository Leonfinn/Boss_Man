// Self-deploy, phase 1 (docs/09-self-deploy.md): Boss Man updating itself through the host deployer.
// The server never runs anything on the host. It reads what the host script publishes (outbox:
// available.json, status.json), raises an owner decision when main has moved, and on approval
// writes one small request file (inbox) that the host script validates and acts on.
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { ticketRef } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, owners, settings, tickets } from "../db/schema.js";
import { record } from "./activity.js";
import { AnswerError, APPROVE_HAND_APPLY, DEPLOY, NOT_NOW, UPDATE_RUNNERS, clearOwnerTodo, fixesLiveHeading, markDecisionNotificationRead, raiseOwnerTodo, type DecisionContext, type DeployUpdate, type DeployUrgent, type LiveFix } from "./decisions.js";
import type { NotifyInput } from "./notifications.js";
import { leaveClosedNotice, liveNotice, newerNotice, type ClosedNotice } from "./closed-notice.js";
import { sh, step, type HostFacts, type SelfDeployFacts } from "./steps.js";
import type { ReleaseHow, ReleaseLog } from "./release-log.js";

type SelfDeployContext = Extract<DecisionContext, { type: "self_deploy" }>;

const Available = z.object({
  checkedAt: z.string(),
  deployed: z.string(),
  tip: z.string(),
  commits: z.array(z.object({ sha: z.string(), subject: z.string().optional() })).default([]),
  paths: z.array(z.string()).default([]),
  infraPaths: z.array(z.string()).default([]),
  runnerChanged: z.boolean().default(false),
  // What the host really looks like (BOS-269). Absent from an older host script: the card then says it can't tell.
  srcDir: z.string().optional(),
  deployerDir: z.string().optional(),
  bluegreen: z.boolean().optional(),
  liveColour: z.string().optional(),
  // The host's own standby window (SOAK_SECONDS in its host.conf), published since BOS-384. Absent from an older host script.
  soakSeconds: z.number().int().nonnegative().nullish(),
  // Which services the update changes, read from their rendered settings (BOS-487, DR-020 B and C). All absent from an older
  // host script: the cards then say nothing about the database or proxy. `servicesChecked: false` = the host couldn't compare.
  changedServices: z.array(z.string()).default([]),
  servicesChecked: z.boolean().optional(),
  // db/proxy still running with older settings than the live checkout asks for (the container hasn't been recreated since).
  pendingServices: z.array(z.string()).default([]),
  dbStartedAt: z.string().optional(),
  dbContainerId: z.string().optional(),
});
export type Available = z.infer<typeof Available>;

const Status = z.object({
  id: z.string(),
  // "restart": the Settings button (BOS-647), a fresh copy of the commit that already runs.
  target: z.enum(["server", "runner", "restart"]),
  result: z.enum(["running", "deployed", "nothing_new", "rejected", "failed", "partial", "rolled_back"]),
  message: z.string(),
  from_commit: z.string(),
  to_commit: z.string(),
  started: z.string(),
  ended: z.string(),
  backup: z.string().default(""),
  // The host's own standby window in seconds (BOS-401). The shell writes every value as a string; an older host omits it.
  soak_seconds: z.union([z.number(), z.string()]).optional(),
  // BOS-753: main had moved on past the approved commit, so the host deployed the newest checked one instead. Both are
  // written only then: what the owner approved, and whether what really went out changes the runner ("true"/"false").
  requested_commit: z.string().optional(),
  runner_changed: z.string().optional(),
});
export type DeployStatus = z.infer<typeof Status>;

/** What the host deployer says about its memory every tick (outbox/headroom.json, BOS-420). Every field but the time is optional. */
const Headroom = z.object({
  version: z.literal(1),
  writtenAt: z.string(),
  totalMb: z.number().int().nonnegative().optional(),
  availableMb: z.number().int().nonnegative().optional(),
  swapTotalMb: z.number().int().nonnegative().optional(),
  swapUsedMb: z.number().int().nonnegative().optional(),
  needMb: z.number().int().nonnegative().optional(),
  needFrom: z.string().max(32).optional(),
  /** Blue/green: the room the need gives a freshly started second server, and what the live server uses now (never part of the need). */
  newServerMb: z.number().int().nonnegative().optional(),
  liveServerMb: z.number().int().nonnegative().optional(),
  /** The host is leaving a request in its inbox (its memory floor). */
  holding: z.string().max(64).optional(),
  lastUpdate: z.object({ commit: z.string(), lowMb: z.number(), lowAt: z.string(), swapPeakMb: z.number() }).optional(),
});
export type Headroom = z.infer<typeof Headroom>;

/** The host deployer runs every minute (cron) and rewrites host.json each time; longer than this without any sign of it, while no deploy holds its lock, is overdue (BOS-753). */
export const DEPLOYER_LATE_MS = 10 * 60_000;
/** How many of the newest checked merges the host is told about (BOS-753): far more than can land between a card and its deploy. */
const CHECKED_LIMIT = 500;
const HostStamp = z.object({ writtenAt: z.string() });

/** The services only the owner's own step applies: a server update never restarts them (BOS-458, BOS-487). */
const OWNER_SERVICES = ["db", "proxy"] as const;
type OwnerService = (typeof OWNER_SERVICES)[number];
const SERVICE_WORDS: Record<OwnerService, string> = { db: "database", proxy: "proxy" };
const SERVICE_KEY = "self-deploy:services:";
// Never a guide's folder (BOS-417): docs/06 is TrueNAS-only, and an owner card must not send them to a doc.
const NO_SRC = "Boss Man can't tell where it is installed, because the machine hasn't reported its install folder, so no command is shown here. Ask us on this ticket for the exact commands.";
const NO_HOST = "Boss Man hasn't been told this machine's name yet, so it can't say where a command runs. Open Settings → Server and runner → This host and ask us on this ticket for the exact commands.";

const short = (sha: string) => sha.slice(0, 8);
/** Boss Man's merges record the ticket as `Merge "<title>" (<ticket id>)` (BOS-213): the ticket id, or null for any other commit. */
const mergedTicket = (subject: string) => subject.match(/^Merge ".*" \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/i)?.[1]!.toLowerCase() ?? null;
/** A folder the host reported, if it is safe to put in a command the owner pastes; otherwise null (never guessed). */
const folder = (p: string | undefined) => (p && /^\/[\w.+@/-]+$/.test(p) && !p.split("/").includes("..") ? p.replace(/\/+$/, "") : null);
const isSha = (s: string) => /^[0-9a-f]{7,64}$/.test(s);
/** The ladder: success is a note, a refusal a flag, anything half-done or broken a page. */
const LEVEL = { deployed: "note", nothing_new: "note", rejected: "flag", failed: "page", partial: "page", rolled_back: "page", running: "note" } as const;
/** The pass reads the host's files every time, but if they haven't changed for this long it runs anyway (BOS-414). */
const FORCED_SYNC_MS = 60_000;

export function selfDeployService(db: Db, deps: { dir?: string; notify: (n: NotifyInput) => Promise<unknown>; /** The live-commit record and the Release Manager's wake (BOS-284). */ releaseLog?: ReleaseLog; /** What each host recorded about itself (BOS-427): its name goes on every command's block. */ hosts?: () => Promise<HostFacts[]>; /** The settings record's facts as key → value (BOS-419): used for what the update file doesn't say. */ facts?: () => Promise<Record<string, string>>; /** True when nothing is running that a few seconds' outage would cut short (BOS-487); absent = always quiet. */ hostQuiet?: () => Promise<boolean>; log?: (msg: string) => void }) {
  const dir = deps.dir;
  const inboxFile = dir && path.join(dir, "inbox", "request.json");
  const readJson = async <T>(file: string, schema: z.ZodType<T>): Promise<T | null> => {
    try {
      return schema.parse(JSON.parse(await readFile(file, "utf8")));
    } catch {
      return null; // missing, half-written or from a newer host script: treated as "nothing yet"
    }
  };
  const available = () => (dir ? readJson(path.join(dir, "outbox", "available.json"), Available) : Promise.resolve(null));
  const status = () => (dir ? readJson(path.join(dir, "outbox", "status.json"), Status) : Promise.resolve(null));
  const pending = async () => !!inboxFile && (await stat(inboxFile).then(() => true, () => false));
  const availableFile = dir && path.join(dir, "outbox", "available.json");
  const statusFile = dir && path.join(dir, "outbox", "status.json");
  const checkedFile = dir && path.join(dir, "inbox", "checked");

  /**
   * BOS-753: the merge commits Boss Man's merge gate checked, newest merges first, one hash per line, for the host. When
   * main has moved on past an approved commit, the host deploys the newest commit on main that is in this list (and
   * never one off main). Only checked merges are listed: a merge with no check, or a rider on another ticket's
   * merge without its own check, is left out. Written beside every request and refreshed while one waits, so a
   * merge that lands just before the host's tick is known. Only rewritten when the list changed.
   */
  let checkedWritten: string | null = null;
  async function writeChecked() {
    if (!checkedFile) return;
    const rows = await db
      .select({ sha: tickets.mergeCommit })
      .from(tickets)
      .where(and(isNotNull(tickets.mergeCommit), isNotNull(tickets.checkedCommit)))
      .orderBy(desc(tickets.stateChangedAt))
      .limit(CHECKED_LIMIT);
    const body = [...new Set(rows.flatMap((r) => (r.sha && /^[0-9a-f]{40}$/.test(r.sha) ? [r.sha] : [])))].map((s) => `${s}\n`).join("");
    if (body === checkedWritten && (await stat(checkedFile).then(() => true, () => false))) return;
    const tmp = `${checkedFile}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, body, { mode: 0o640 });
    await rename(tmp, checkedFile);
    checkedWritten = body;
  }

  /**
   * When the host deployer last showed it is alive (BOS-753): the newest of host.json's writtenAt (rewritten every
   * tick), available.json's checkedAt and the last status. `late` only when it never reported, or nothing came for
   * DEPLOYER_LATE_MS while no deploy is running (a deploy holds the deployer's lock, so its ticks stop until it ends).
   * available.json alone is no sign of life: the host removes it on purpose after a deploy so the next tick rewrites it.
   */
  async function deployerSeen(a: Available | null, s: DeployStatus | null) {
    const host = dir ? await readJson(path.join(dir, "outbox", "host.json"), HostStamp) : null;
    const times = [host?.writtenAt, a?.checkedAt, s?.ended || s?.started].map((t) => (t ? Date.parse(t) : NaN)).filter((t) => Number.isFinite(t));
    const at = times.length ? Math.max(...times) : null;
    const late = at === null || (Date.now() - at > DEPLOYER_LATE_MS && s?.result !== "running");
    return { reportedAt: at === null ? null : new Date(at).toISOString(), late };
  }

  /** Asks the host to look at main on its next tick (only the file's existence is read). True when the ask was written. */
  const askHostToLook = () => (dir ? writeFile(path.join(dir, "inbox", "check"), "", { mode: 0o640 }).then(() => true, () => false) : Promise.resolve(false));

  /** Why there is no offer to act on, in words that don't send the owner to a cron job that is running fine (BOS-753). */
  async function noOfferReason(a: Available | null, s: DeployStatus | null): Promise<string> {
    const seen = await deployerSeen(a, s);
    if (!seen.reportedAt) return "The host deployer has not reported yet. Check that its cron job is running.";
    const at = `${seen.reportedAt.slice(0, 10)} ${seen.reportedAt.slice(11, 16)} UTC`;
    if (seen.late) return `The host deployer last reported at ${at}, more than ${DEPLOYER_LATE_MS / 60_000} minutes ago; it should report every minute. Check that its cron job is running.`;
    if (a && !a.tip) return `The host deployer reported at ${at}, but main is not a straight continuation of the version that runs (${short(a.deployed)}), so it can't be deployed with one click. Ask us on a ticket.`;
    const asked = await askHostToLook();
    return `The host deployer is running (last report at ${at}) and is reading main again after its last deploy.${asked ? " Try again in a minute or two." : ""}`;
  }

  /**
   * When the host last rewritten a file, and how big it was (BOS-414). The host replaces each file by
   * rename, so both change with its content; a missing or unreadable file gets a token that never
   * matches a stored one, so the next pass runs.
   */
  const fingerprint = (file: string | undefined) =>
    file
      ? stat(file).then(
          (st) => `${st.mtimeMs}:${st.size}`,
          () => "missing",
        )
      : Promise.resolve("off");
  let seen: { print: string; at: number } | null = null;

  /**
   * Nothing a pass reads outside its database can change until the host writes a file, or a request
   * is put in its inbox, so when all three have the same mtime and size as last time there is nothing
   * to do (BOS-414). A pass still runs at least once a minute, which covers a missed rename and
   * anything else a file token can't see. The minute is measured from the last pass that *ran*, not
   * the last call: a skipped call keeps the old time, or the poller skipping every 30 s would push the
   * forced pass back for ever (BOS-414 review). Tests set the time with fake timers, never a timer.
   */
  const unchanged = async () => {
    const nowMs = Date.now();
    const print = (await Promise.all([fingerprint(availableFile), fingerprint(statusFile), fingerprint(inboxFile)])).join("|");
    const skip = seen !== null && seen.print === print && nowMs - seen.at < FORCED_SYNC_MS;
    // On a skip only the print is refreshed: the clock for the forced pass stays on the last real pass.
    seen = skip ? { print, at: seen!.at } : { print, at: nowMs };
    return skip;
  };

  /** Boss Man itself belongs to no company, but a decision needs one: the oldest. */
  async function homeCompany() {
    const [c] = await db.select({ id: companies.id }).from(companies).orderBy(asc(companies.createdAt)).limit(1);
    return c?.id ?? null;
  }

  /**
   * What the owner is approving (BOS-213): Boss Man's merges record the ticket as
   * `Merge "<title>" (<ticket id>)`, so each one maps back to its ticket and title. Commits that
   * aren't a ticket keep their subject line. Long ranges show the first 20 tickets.
   */
  async function updateFor(commit: string, fromCommit: string, a: Available | null, extras: { handBecause?: string; handFiles?: string[]; handEffect?: DeployUpdate["handEffect"]; needsDeployerCopy?: boolean; needsRunnerUpdate?: boolean; risks: string[] }): Promise<DeployUpdate | undefined> {
    const commits = a?.commits ?? [];
    if (!commits.length) return undefined;
    const entries = commits.flatMap((c) => (c.subject ? [{ subject: c.subject, ticketId: mergedTicket(c.subject) }] : []));
    const wanted = [...new Set(entries.flatMap((e) => (e.ticketId ? [e.ticketId] : [])))];
    const rows = wanted.length
      ? await db
          .select({ id: tickets.id, title: tickets.title, number: tickets.number, prefix: companies.ticketPrefix })
          .from(tickets)
          .innerJoin(companies, eq(companies.id, tickets.companyId))
          .where(inArray(tickets.id, wanted))
      : [];
    const found = new Map(rows.flatMap((r) => {
      const ref = ticketRef(r.prefix, r.number);
      return ref ? [[r.id, { ticketId: r.id, ref, title: r.title }] as const] : [];
    }));
    const all: DeployUpdate["changes"] = [];
    const otherCommits: string[] = [];
    const seen = new Set<string>();
    for (const e of entries) {
      const t = e.ticketId ? found.get(e.ticketId) : undefined;
      // A merge whose ticket can't be found (removed, or another install) is still shown as a commit.
      if (t && !seen.has(t.ticketId)) {
        seen.add(t.ticketId);
        all.push(t);
      } else if (!t) otherCommits.push(e.subject);
    }
    return {
      from: fromCommit,
      to: commit,
      total: entries.length,
      files: a?.paths.length ?? 0,
      changes: all.slice(0, 20),
      more: Math.max(0, all.length - 20),
      otherCommits,
      ...(extras.handBecause ? { handBecause: extras.handBecause } : {}),
      ...(extras.handFiles?.length ? { handFiles: extras.handFiles } : {}),
      ...(extras.handEffect ? { handEffect: extras.handEffect } : {}),
      ...(extras.needsDeployerCopy !== undefined ? { needsDeployerCopy: extras.needsDeployerCopy } : {}),
      ...(extras.needsRunnerUpdate !== undefined ? { needsRunnerUpdate: extras.needsRunnerUpdate } : {}),
      risks: extras.risks,
    };
  }

  /**
   * The merged tickets in the range that fix a live problem (BOS-639): only those whose "fixes live" marker
   * was set by hand, never guessed from priority. `repeat` when every one of them was already on an earlier
   * deploy card (open, withdrawn or answered): main moving on raises a new card, and that must not page
   * the owner again for the same fix.
   */
  async function urgentFor(a: Available | null): Promise<DeployUrgent | undefined> {
    const ids = [...new Set((a?.commits ?? []).flatMap((c) => { const id = c.subject ? mergedTicket(c.subject) : null; return id ? [id] : []; }))];
    if (!ids.length) return undefined;
    const rows = await db
      .select({ id: tickets.id, number: tickets.number, prefix: companies.ticketPrefix, fixesLive: tickets.fixesLive })
      .from(tickets)
      .innerJoin(companies, eq(companies.id, tickets.companyId))
      .where(and(inArray(tickets.id, ids), isNotNull(tickets.fixesLive)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    // In the range's own order; a ticket without a reference (another install's numbering) can't be named, so it is left out.
    const fixes: LiveFix[] = ids.flatMap((id) => {
      const r = byId.get(id);
      const ref = r ? ticketRef(r.prefix, r.number) : null;
      const symptom = r?.fixesLive?.trim();
      return r && ref && symptom ? [{ ticketId: r.id, ref, symptom }] : [];
    });
    if (!fixes.length) return undefined;
    let repeat = true;
    for (const f of fixes) {
      const [earlier] = await db
        .select({ id: decisions.id })
        .from(decisions)
        .where(and(sql`${decisions.context}->>'type' = 'self_deploy'`, sql`${decisions.context}->'urgent'->'fixes' @> ${JSON.stringify([{ ticketId: f.ticketId }])}::jsonb`))
        .limit(1);
      if (!earlier) repeat = false;
    }
    return { heading: fixesLiveHeading(fixes), fixes, ...(repeat ? { repeat } : {}) };
  }

  async function openFor(target: string) {
    return db
      .select()
      .from(decisions)
      .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'self_deploy'`, sql`${decisions.context}->>'target' = ${target}`));
  }

  /** Raises the decision for a commit. `again` lets the owner be asked about one they already put off. */
  async function raise(target: "server" | "runner", commit: string, fromCommit: string, a: Available | null, again = false) {
    const companyId = await homeCompany();
    if (!companyId) return null;
    const infra = target === "server" && (a?.infraPaths.length ?? 0) > 0;
    // Merge commits only repeat the ticket's title; the commits under them say what changed.
    const changes = (a?.commits ?? []).flatMap((c) => (c.subject && !c.subject.startsWith("Merge ") ? [c.subject] : [])).slice(0, 10);
    // An infra change can only be applied by hand on the host. The steps, the check and the rollback
    // are kept structured so the approval card and the to-do it leaves behind both show them (BOS-122).
    // The approved commit is pinned in every step (BOS-124): `main` may have moved on by the time the
    // owner applies it, and an unpinned step would bring in changes they never approved.
    const changed = new Set([...(a?.infraPaths ?? []), ...(a?.paths ?? [])]);
    const hostDeployerChanged = changed.has("scripts/host-deployer.sh");
    const launcherChanged = [...changed].some((p) => p.startsWith("apps/launcher/"));
    // BOS-419: what the update file doesn't say comes from the settings record (the host's own report, kept with
    // its source). The update file still wins, since it is written at the same moment as the update.
    const rec = await deps.facts?.().catch(() => ({} as Record<string, string>)) ?? {};
    const src = folder(a?.srcDir ?? rec["paths.src"]);
    const deployer = folder(a?.deployerDir ?? rec["paths.deployer"]);
    const shaOk = isSha(commit) && isSha(fromCommit);
    const ownerChanged = target === "server" ? OWNER_SERVICES.filter((s) => a?.changedServices.includes(s)) : [];
    const bg = a?.bluegreen ?? (rec["compose.bluegreen"] === "true" ? true : rec["compose.bluegreen"] === "false" ? false : undefined);
    const liveColour = a?.liveColour ?? rec["compose.liveColour"];
    const colour = liveColour === "blue" || liveColour === "green" ? liveColour : null;
    // The machine's recorded name (BOS-427): every command's block says "on <host>, as root". Without it the
    // card can't say where a command runs, so no command is shown (never a guessed name).
    const host = (await deps.hosts?.())?.[0]?.name ?? null;
    /** A command for a hand-apply card: always on the recorded host, as root (the deployer and deploy.sh run as root). */
    const cmd = (c: string) => sh(c, { host: host!, as: "root" });
    // git writes the checkout with the terminal's umask; under a root shell's 077 the image built from it can't
    // read its own code (the 6 Nov outage, DR-028). A subshell, never a bare umask: 022 left set in the owner's root
    // terminal would make their later hand-made backups world-readable. So the pin and the blue/green rollback below
    // each run as one (umask 022 && cd <src> && git …) subshell, and the card lint's R14 refuses any other form.
    // The single-server apply and rollback run deploy.sh, whose own git checkout/merge write the checkout too: they get
    // the same subshell. (BOS-562 makes deploy.sh run its own git under 022 too; the subshell still covers an older
    // deploy.sh on the host, which is the copy that runs the apply.)
    // Never a guide's folder (BOS-417): docs/06 is TrueNAS-only, and an owner card must not send them to a doc.
    const noSrc = NO_SRC;
    const noHost = NO_HOST;
    const handSteps: string[] = [];
    if (infra) {
      handSteps.push(
        bg === true
          ? `This install runs blue/green${colour ? ` (the live copy is ${colour})` : ""}, so use the blue/green steps below.`
          : bg === false
            ? "This install runs a single server, so use the single-server steps below."
            : "Boss Man can't tell whether this install runs blue/green or a single server, so the apply and rollback commands are not shown. Ask us on this ticket.",
      );
      handSteps.push(
        src && shaOk
          ? host
            ? step(`On the machine that runs Boss Man, pin the approved commit ${commit} with this command. The last line it prints must be exactly that commit; if it prints anything else, stop and tell us.`, cmd(`(umask 022 && cd ${src} && git checkout main && git fetch origin && git merge --ff-only ${commit} && git rev-parse HEAD)`))
            : noHost
          : noSrc,
      );
      if (bg !== undefined)
        handSteps.push(
          src && shaOk
            ? host
              ? bg
                ? step("Apply it with this command, on the same machine:", cmd(`cd ${src} && scripts/rebuild-live.sh`))
                : step(`Apply it with this command, on the same machine (it deploys exactly ${short(commit)}):`, cmd(`(umask 022 && cd ${src} && scripts/deploy.sh --commit ${commit})`))
              : noHost
            : noSrc,
        );
      handSteps.push(
        hostDeployerChanged
          ? src && deployer
            ? host
              ? step("Copy the changed host-deployer script into the deployer folder with this command, on the same machine. It prints the one file it copied:", cmd(`cp -v ${src}/scripts/host-deployer.sh ${deployer}/host-deployer.sh && chown root:root ${deployer}/host-deployer.sh && chmod 750 ${deployer}/host-deployer.sh`))
              : noHost
            : "host-deployer.sh changed and has to be copied into the deployer folder, but Boss Man can't tell where the install or deployer folder is, so no command is shown. Ask us on this ticket."
          : "host-deployer.sh didn't change; no copy needed.",
      );
      // A server apply never restarts the database or the proxy (BOS-458). The host works out which services this update
      // changes (BOS-487): a changed one gets its own card with a backup, so this card says so plainly or says nothing.
      if (ownerChanged.length) handSteps.push(`The steps above do not apply the ${ownerChanged.map((s) => `${SERVICE_WORDS[s]}'s`).join(" or ")} new settings, and never restart ${ownerChanged.length === 2 ? "them" : "it"}. A separate card follows, with a backup first.`);
      else if (a!.servicesChecked === false && a!.infraPaths.some((p) => /^docker-compose[^/]*\.ya?ml$|^deploy\//.test(p)))
        handSteps.push("Boss Man could not compare this host's service settings, so it can't say whether the database or proxy change. The steps above never restart them.");
      if (launcherChanged)
        handSteps.push(
          src
            ? host
              ? step("Rebuild the launcher with this command, on the same machine. Runners keep their old limits until the next runner update.", cmd(`cd ${src} && docker compose build launcher && docker compose up -d --no-deps launcher`))
              : `The launcher changed and has to be rebuilt, but ${noHost}`
            : `The launcher changed and has to be rebuilt, but ${noSrc}`,
        );
      if (bg === true)
        handSteps.push(
          src && colour
            ? host
              ? step(
                  `Check the new server has taken charge. Run this on the same machine; it asks the live copy (${colour}) whether it is ready:`,
                  cmd(`cd ${src} && docker compose exec -T server-${colour} node -e "fetch('http://127.0.0.1:3100/api/ready').then(async r=>console.log(await r.text()))"`),
                  "If it says standby, run this next:",
                  cmd(`cd ${src} && docker compose kill -s SIGUSR2 server-${colour}`),
                )
              : noHost
            : "Check the new server has taken charge. Boss Man can't tell which copy is live or where it is installed, so no command is shown. Open Settings → Server and runner → Server and ask us on this ticket.",
        );
      // Only when the runner's files changed: the same flag drives the summary line on the card.
      if (a?.runnerChanged) handSteps.push("Rebuild the runners: Settings → Server and runner → Updates → Build and update runners.");
    }
    const check = infra ? `Open Settings → Server and runner → Updates: it should show ${short(commit)}, Settings → Server and runner → Server: Role reads leader, and Settings → Reviews and CEO should still look as expected. The watchdog stays off unless you switched it on.` : undefined;
    const rollbackNote = "Database restore isn't a fallback yet.";
    const rollback = infra
      ? src && shaOk && bg !== undefined
        ? host
          ? step(
              bg ? "To go back, run this on the machine that runs Boss Man:" : "To go back, run this on the machine that runs Boss Man (code only, never the database):",
              cmd(bg ? `(umask 022 && cd ${src} && git checkout ${fromCommit} && scripts/rebuild-live.sh)` : `(umask 022 && cd ${src} && scripts/deploy.sh --rollback)`),
              rollbackNote,
            )
          : `To go back, ${noHost} ${rollbackNote}`
        : `To go back, Boss Man needs to know the install folder and layout, which it can't tell, so no command is shown. Ask us on this ticket. ${rollbackNote}`
      : undefined;
    const n = a?.paths.length ?? 0;
    const migrations = (a?.paths ?? []).filter((p) => /^apps\/server\/drizzle\/[^/]+\.sql$/.test(p)).length;

    // What changes the risk of the update, in plain words (BOS-213). The deploy itself is unchanged.
    const risks: string[] = [];
    if (migrations) risks.push(`${migrations} database migration${migrations === 1 ? "" : "s"} ${migrations === 1 ? "is" : "are"} included. Boss Man backs the database up first.`);
    for (const s of ownerChanged) risks.push(`This update changes the ${SERVICE_WORDS[s]}'s settings. Applying the update does not restart it; a separate card follows${s === "db" ? ", with a backup first" : ""}.`);
    if (hostDeployerChanged) risks.push("It changes host-deployer.sh, the script that runs deploys on your server. The hand steps include copying it into place.");
    if (launcherChanged) risks.push("It changes the launcher. The hand steps include rebuilding it.");
    if (a?.runnerChanged) risks.push("It changes the runner, the containers agents work in. You'll be asked separately about building the new runners.");
    const infraCount = a?.infraPaths.length ?? 0;
    // What a hand-apply touches, in plain words (BOS-218): the deployer script, the server itself, or both.
    const handPaths = new Set([...(a?.infraPaths ?? []), ...(hostDeployerChanged ? ["scripts/host-deployer.sh"] : [])]);
    const deployerTouched = handPaths.has("scripts/host-deployer.sh");
    const serverTouched = [...handPaths].some((p) => p !== "scripts/host-deployer.sh");
    const handEffect: DeployUpdate["handEffect"] = infra ? (deployerTouched ? (serverTouched ? "both" : "deployer") : "server") : undefined;
    const handBecause = infra
      ? `Needs applying by hand because this update changes ${a!.infraPaths[0]}${infraCount > 1 ? ` and ${infraCount - 1} other deployment file${infraCount === 2 ? "" : "s"}` : ""}.`
      : undefined;
    const update = await updateFor(commit, fromCommit, a, {
      ...(handBecause ? { handBecause } : {}),
      ...(infra ? { handFiles: a!.infraPaths } : {}),
      ...(handEffect ? { handEffect } : {}),
      ...(infra ? { needsDeployerCopy: hostDeployerChanged } : {}),
      ...(target === "server" ? { needsRunnerUpdate: !!a?.runnerChanged } : {}),
      risks,
    });
    // Only the server update carries the fix: the runner card that may follow it is unchanged (BOS-639).
    const urgent = target === "server" ? await urgentFor(a) : undefined;
    // (BOS-551) A server update restarts Boss Man, which resets anything a reading on the owner's queue
    // would measure. Point the update card at the open owner cards a restart would disturb: a card the
    // raising agent marked `resetsOnRestart`, and a hand-apply to-do that isn't itself a server or runner
    // update. Unrelated setup cards are left out so the "Do after" list is not noise.
    const doAfter = target === "server"
      ? (await db
          .select({ id: decisions.id, question: decisions.question, context: decisions.context })
          .from(decisions)
          .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open"), eq(decisions.tier, "owner"))))
          .filter((r) => {
            const c = r.context as DecisionContext;
            if (c.type === "self_deploy" || c.type === "deploy") return false;
            if (c.type === "question") return !!c.steps?.length && c.resetsOnRestart === true;
            if (c.type === "owner_todo") return !c.target;
            return false;
          })
          .slice(0, 10)
          .map((r) => ({ decisionId: r.id, label: r.question.split("\n")[0]!.replace(/\s+/g, " ").trim().slice(0, 80) }))
      : [];
    const ctx: SelfDeployContext = { type: "self_deploy", target, commit, fromCommit, ...(infra ? { infra: true, handSteps, ...(check ? { check } : {}), ...(rollback ? { rollback } : {}) } : {}), ...(a?.runnerChanged && target === "server" ? { runnerChanged: true } : {}), ...(changes.length ? { changes } : {}), ...(update ? { update } : {}), ...(doAfter.length ? { doAfter } : {}), ...(urgent ? { urgent } : {}) };
    const areas = `${n} file${n === 1 ? "" : "s"} changed${migrations ? `, ${migrations} database migration${migrations === 1 ? "" : "s"}` : ""}${a?.runnerChanged ? ", runner code changed (separate approval after this)" : ""}`;
    // The heading is the card's first paragraph, so the card, its phone push and the CEO's view all lead with it.
    const lead = urgent ? `${urgent.heading}.\n\n` : "";
    // The tickets this update carries, in the owner's words (BOS-683, DR-036): the new card lists them, so
    // the card that clears the older one says what it includes. Only the tickets, never the bare commits.
    const carried = (update?.changes ?? []).slice(0, 10).map((c) => `${c.ref}: ${c.title}`);
    const carries = carried.length ? ` It includes ${carried.join("; ")}${update && update.more > 0 ? `; and ${update.more} more` : ""}.` : "";
    const question =
      lead +
      (target === "runner"
        ? `Update the runners to ${short(commit)}?\n\nThis rebuilds the runner containers from the version Boss Man runs (${short(commit)}); the server itself doesn't change. The new image is built and checked first. Then nothing new starts in any company; runs in progress finish (you are asked after about 30 minutes if some are still going), and each company's runner is swapped as soon as it is idle. Without the launcher the runners restart at once and cut runs off.`
        : infra
          ? `Main has moved to ${short(commit)}. This update has to be applied by hand on the machine that runs Boss Man, so the steps stay on your queue until it's applied or you mark it done.${carries}`
          : `Deploy Boss Man ${short(fromCommit)} -> ${short(commit)}? ${areas}. The database is backed up first, then Boss Man restarts (a minute or two). If more work merges before the host runs it, the newest version that has passed its checks goes out instead.`);
    // An infra change can't be one-click: approving it leaves the owner a to-do on their queue with the
    // hand-apply steps, because the deploy only happens when they run it on the host (BOS-122).
    const options = infra ? [APPROVE_HAND_APPLY, NOT_NOW] : target === "runner" ? [UPDATE_RUNNERS, NOT_NOW] : [DEPLOY, NOT_NOW];
    const [row] = await db
      .insert(decisions)
      .values({
        companyId,
        kind: "approval",
        question,
        options,
        recommendedOption: options[0]!,
        dedupeKey: `self-deploy:${target}:${commit}${again ? `:${randomBytes(3).toString("hex")}` : ""}`,
        context: ctx,
      })
      .onConflictDoNothing()
      .returning();
    if (row && target === "server") {
      // One card per update: an older, still-open question about an earlier commit is replaced by this one. (Since BOS-753 an
      // approval of an older card would still deploy the newest checked commit, but two cards for one update only confuse.)
      // Free each one's dedupe key, as every other withdraw does, or a later offer for the same commit is silently dropped (Freddy).
      // BOS-739: each leaves a notice where it was, naming this card to follow instead.
      const label = infra ? `Main has moved to ${short(commit)}` : `Deploy Boss Man ${short(fromCommit)} -> ${short(commit)}`;
      for (const d of await openFor("server")) if (d.id !== row.id) await withdrawOpen(d.id, (steps) => newerNotice({ newerId: row.id, label, steps, now: new Date() }));
      // BOS-683 (DR-036): an older server hand-apply to-do, still open or waiting in the owner's queue, is now
      // covered by this newer card — applying the newer commit brings the older one's changes in too. So it is
      // cleared with a note naming the new card, instead of sitting beside it. A to-do for the same commit is left
      // alone (the new card is the same update, not a newer one). A runner to-do is left alone: it is its own thing.
      const todos = await db
        .select({ id: decisions.id, context: decisions.context })
        .from(decisions)
        .where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'owner_todo'`, sql`${decisions.context}->>'target' = 'server'`));
      const includes = carried.length ? ` It includes ${carried.join("; ")}.` : "";
      const newerLabel = `Main has moved to ${short(commit)}`;
      for (const t of todos) {
        const c = t.context as Extract<DecisionContext, { type: "owner_todo" }>;
        if (!c.commit || c.commit === commit) continue;
        const r = await clearOwnerTodo(db, `owner-todo:self-deploy:${c.commit}`, `Covered by the newer update card ("${newerLabel}"): applying ${short(commit)} brings this in too.${includes} Marked done.`);
        if (r) {
          // BOS-739: leave a notice where the card was, so an owner part-way through its steps knows why
          // it closed and is pointed at the newer card. The card's steps stay readable with it.
          await leaveClosedNotice(db, r.id, newerNotice({ newerId: row.id, label: newerLabel, steps: c.steps, now: new Date() }), { notify: deps.notify });
          deps.log?.(`self-deploy: older hand-apply to-do for ${short(c.commit)} covered by ${short(commit)} (BOS-683)`);
        }
      }
    }
    return row ?? null;
  }

  /** A card closed by the product, not answered: its notification is marked read here (BOS-413). */
  async function withdrawOpen(id: string, notice?: ClosedNotice | ((steps?: string[]) => ClosedNotice)) {
    const [row] = await db.select({ context: decisions.context }).from(decisions).where(eq(decisions.id, id));
    await db.update(decisions).set({ status: "withdrawn", answeredAt: new Date(), dedupeKey: null }).where(eq(decisions.id, id));
    await markDecisionNotificationRead(db, id);
    // BOS-739: a card the system closed leaves a notice where it was, so an owner part-way through its
    // hand steps knows why it closed (and where to carry on). Its steps stay readable with the notice.
    const ctx = row?.context as SelfDeployContext | undefined;
    const steps = ctx?.type === "self_deploy" ? ctx.handSteps : undefined;
    // Only a hand-apply card has steps the owner might be part-way through; a one-click deploy card
    // leaves nothing to explain, so it is just removed as before.
    const handApply = !!steps?.length || !!ctx?.ownerOpenedAt;
    const n = handApply ? (typeof notice === "function" ? notice(steps) : notice) : undefined;
    if (n) await leaveClosedNotice(db, id, n, { notify: deps.notify });
  }

  /** One request for the host: written beside its final name, then renamed, so the host never reads half a file. */
  /**
   * Writes one request beside its final name, then renames it, so the host never reads half a file.
   * `override`: the owner chose "Update now anyway", so the host's memory floor doesn't hold it (BOS-420). An older host ignores the field.
   */
  async function writeRequest(id: string, target: "server" | "runner" | "restart", commit: string, opts: { override?: boolean } = {}) {
    const [o] = await db.select({ id: owners.id }).from(owners).limit(1);
    const body = { id, target, commit, requestedAt: new Date().toISOString(), approvedBy: o?.id ?? "owner", ...(opts.override ? { quiet: "override" } : {}) };
    const tmp = `${inboxFile}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, `${JSON.stringify(body)}\n`, { mode: 0o640 });
    await rename(tmp, inboxFile!);
  }

  async function saveSeen(key: string) {
    await db.insert(settings).values({ key: "self_deploy", value: { notified: key } }).onConflictDoUpdate({ target: settings.key, set: { value: { notified: key } } });
  }

  // BOS-368: a server update reports "deployed" when it switches in, but it can still be switched back
  // during its trial (the host's standby window). The runner update is only offered once that trial is
  // over and the server is still on that commit; until then it is held here.
  // BOS-384: the length is the host's own setting (SOAK_SECONDS in its host.conf), published in
  // available.json as soakSeconds. It is not run through the server container, and the server can't read
  // host.conf, so an older or single-server host (no value) falls back to the old 900 s.
  const RUNNER_DUE = "self_deploy_runner_due";
  const LAST_SERVER = "self_deploy_last_server";
  /** `offer`: the runner needs updating once the window is over; without it the hold only blocks (a row from before BOS-401 is an offer). */
  type RunnerDue = { commit: string; fromCommit: string; after: string; offer?: boolean };
  const DEFAULT_SOAK_SECONDS = 900;
  const TRIAL_MARGIN_SECONDS = 120;
  type LastServer = { result: DeployStatus["result"]; from: string; to: string; ended: string };
  /** The window for this deploy: what the host wrote into status.json for it (BOS-401), else the length it publishes in available.json (BOS-384), else 900. */
  const statusSoak = (s?: DeployStatus | null) => {
    const raw = s?.soak_seconds;
    const n = typeof raw === "string" ? (raw.trim() === "" ? NaN : Number(raw)) : raw;
    return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 86400 ? Math.floor(n) : null;
  };
  const soakSeconds = (a: Available | null, s?: DeployStatus | null) => statusSoak(s) ?? a?.soakSeconds ?? DEFAULT_SOAK_SECONDS;
  const trialMs = (a: Available | null, s?: DeployStatus | null) => (soakSeconds(a, s) + TRIAL_MARGIN_SECONDS) * 1000;
  const trialWords = (seconds: number) => {
    const min = Math.round(seconds / 60);
    if (seconds === DEFAULT_SOAK_SECONDS) return "15-minute";
    if (seconds % 60 === 0) return `${min}-minute`;
    return seconds === 0 ? "trial" : `${seconds}-second`;
  };
  const trialMessage = (seconds: number) =>
    `The server update is still in its ${trialWords(seconds)} trial, so the runners can't be updated yet. Boss Man offers the runner update by itself when the trial ends.`;
  /** The trial length as Settings and the cards should show it now (the last host report, if any). */
  const currentTrial = async () => soakSeconds(await available());
  async function getSetting<T>(key: string): Promise<T | null> {
    const [row] = await db.select().from(settings).where(eq(settings.key, key));
    return (row?.value as T | undefined) ?? null;
  }
  async function putSetting(key: string, value: object | null) {
    if (value === null) await db.delete(settings).where(eq(settings.key, key));
    else await db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  }
  /** The held runner update, if its server update is still in its trial. */
  async function inTrial() {
    const due = await getSetting<RunnerDue>(RUNNER_DUE);
    return due && Date.now() < Date.parse(due.after) ? due : null;
  }
  /** Raises the held runner update once its trial is over, if the server is still on that commit; otherwise drops it quietly. */
  async function releaseRunnerDue(a: Available | null) {
    const due = await getSetting<RunnerDue>(RUNNER_DUE);
    if (!due || Date.now() < Date.parse(due.after)) return;
    await putSetting(RUNNER_DUE, null);
    if (due.offer === false) return;
    const last = await getSetting<LastServer>(LAST_SERVER);
    if (last?.result === "deployed" && last.to === due.commit && a?.deployed === due.commit) await raise("runner", due.commit, due.fromCommit, a);
    else deps.log?.(`self-deploy: runner update for ${short(due.commit)} dropped; the server is not on it after its trial`);
  }

  /**
   * A deploy has ended: tell the owner once, record it on the decision, and offer the runner update when it is due.
   * BOS-384: the "seen" mark is saved last, after the notify and the withdraws, so a crash in between doesn't lose them.
   * Re-running the rest is safe (Freddy): the notify dedupes on the same key, the withdraws only touch open cards and
   * free their dedupe key, and the settings writes and decision update are idempotent.
   */
  async function finished(s: DeployStatus, a: Available | null) {
    const [row] = await db.select().from(settings).where(eq(settings.key, "self_deploy"));
    const key = `${s.id}:${s.result}:${s.ended}`;
    if ((row?.value as { notified?: string } | undefined)?.notified === key) return;
    // The host writes an empty id when it refused a file it could not read.
    const [d] = z.string().uuid().safeParse(s.id).success ? await db.select().from(decisions).where(eq(decisions.id, s.id)) : [];
    const ctx = d?.context as DecisionContext | undefined;
    const what = s.target === "runner" ? "The runners" : "Boss Man";
    // A runner "deploy" now only builds the image and asks for the drain; the swap's own result is reported by the drain (maintenance.ts).
    // A refused runner update is not a failure and needs nothing from the owner (the message says why): a quiet note, not a flag.
    const runnerRefused = s.target === "runner" && s.result === "rejected";
    const restart = s.target === "restart";
    const title = restart
      ? s.result === "deployed"
        ? `Boss Man restarted (${short(s.to_commit)})`
        : s.result === "rejected"
          ? "Restart refused"
          : s.result === "rolled_back"
            ? `Restart switched back (${short(s.to_commit)})`
            : `Restart failed (${short(s.to_commit)})`
      : runnerRefused ?`Runner update not started (${short(s.to_commit)})` : s.result === "deployed" && s.target === "runner" ? `New runner image ready (${short(s.to_commit)}); update waiting for runs to finish` : s.result === "deployed" ? `${what} updated to ${short(s.to_commit)}` : s.result === "nothing_new" ? `${what} was already up to date` : `Update ${s.result === "rejected" ? "refused" : "failed"}: ${short(s.to_commit)}`;
    const changes = s.result === "deployed" && ctx?.type === "self_deploy" ? (ctx.changes ?? []) : [];
    // BOS-753: a newer checked commit than the card's went out, so the card's list is only part of what changed.
    const newer = ctx?.type === "self_deploy" && s.target === "server" && !!s.to_commit && s.to_commit !== ctx.commit;
    const changedHead = newer ? `What changed, up to the approved ${short(ctx.commit)} (the newer merges up to ${short(s.to_commit)} went out too):` : "What changed:";
    await deps.notify({ companyId: null, level: runnerRefused ? "note" : LEVEL[s.result], title, body: changes.length ? `${s.message}\n\n${changedHead}\n${changes.map((c) => `- ${c}`).join("\n")}` : s.message, link: "#/settings" });
    // BOS-364 withdrew only cards for the commit it never reached; BOS-368 withdraws every open runner card, whichever way round the host names the commits.
    if (s.target === "server") {
      await putSetting(LAST_SERVER, { result: s.result, from: s.from_commit, to: s.to_commit, ended: s.ended } satisfies LastServer);
      // Switched back or failed: no runner update is due, whichever way round the host names the commits.
      if (s.result === "rolled_back" || s.result === "failed") {
        await putSetting(RUNNER_DUE, null);
        // Free the dedupe key, as every other withdraw does, or a later offer for the same commit is silently dropped.
        for (const o of await openFor("runner")) await withdrawOpen(o.id);
      }
    }
    // Every way a server update can end "deployed" starts a standby window (deploy latest, hand-apply and a rollback have no self_deploy decision), so the hold is set here, not on the decision path.
    if (s.target === "server" && s.result === "deployed") {
      const ended = Date.parse(s.ended);
      const old = await getSetting<RunnerDue>(RUNNER_DUE);
      // BOS-753: when the host deployed a newer commit than the card's, it says whether that range changed the runner.
      const wants = s.runner_changed === "true" || s.runner_changed === "false" ? s.runner_changed === "true" : ctx?.type === "self_deploy" && !!ctx.runnerChanged;
      // A newer server update inside the window must not drop the older commit's runner change: keep its range and its offer.
      const held = old && old.offer !== false;
      await putSetting(RUNNER_DUE, { commit: s.to_commit, fromCommit: old ? old.fromCommit : s.from_commit, after: new Date((Number.isFinite(ended) ? ended : Date.now()) + trialMs(a, s)).toISOString(), offer: wants || !!held } satisfies RunnerDue);
    }
    if (d && ctx?.type === "self_deploy") {
      await db.update(decisions).set({ context: { ...ctx, result: { result: s.result, message: s.message, at: s.ended } } }).where(eq(decisions.id, d.id));
      await record(db, { companyId: d.companyId, kind: "self_deploy", summary: `${title}. ${s.message}` });
    }
    await saveSeen(key);
  }

  /**
   * The steps of the owner's own card for a changed database or proxy (BOS-487, DR-020 B and C): every command on the
   * recorded host and install folder, never a guessed one. The database gets a backup first.
   */
  function serviceSteps(svc: OwnerService, commit: string, a: Available, host: string | null) {
    const src = folder(a.srcDir);
    const colour = a.liveColour === "blue" || a.liveColour === "green" ? a.liveColour : null;
    const live = a.bluegreen === true ? (colour ? `server-${colour}` : null) : a.bluegreen === false ? "server" : null;
    const cmd = (c: string) => sh(c, { host: host!, as: "root" });
    const word = SERVICE_WORDS[svc];
    const down = `Boss Man is unreachable for a few seconds while the ${word} restarts. Pick a moment when nobody needs it.`;
    const steps: string[] = [down];
    const missing = !src ? NO_SRC : !host ? NO_HOST : null;
    const backupFile = src ? `${src}/db-backup-before-${short(commit)}.sql.gz` : "";
    if (svc === "db")
      steps.push(missing ?? step("Take a backup first. Run this on the machine that runs Boss Man. It prints the size of the new backup file; if it prints an error instead, stop and tell us:", cmd(`(set -o pipefail && umask 077 && cd ${src} && docker compose exec -T db pg_dump -U bossman bossman | gzip > ${backupFile}) && gzip -t "${backupFile}" && ls -l "${backupFile}"`)));
    steps.push(missing ?? step(`Restart just the ${word} with its new settings. Run this on the same machine:`, cmd(`cd ${src} && docker compose up -d --no-deps ${svc}`)));
    steps.push(
      missing ?? step(`Check it came back once. Run this on the same machine; it should say the ${word} was started a few seconds or minutes ago, not days:`, cmd(`cd ${src} && docker compose ps ${svc}`)),
    );
    steps.push(
      missing ??
        (live
          ? step(`Check Boss Man reconnected. Run this on the same machine; it asks the running server (${live}) whether it is ready. The answer should say ok is true and the role is leader:`, cmd(`cd ${src} && docker compose exec -T ${live} node -e "fetch('http://127.0.0.1:3100/api/ready').then(async r=>console.log(await r.text()))"`))
          : "Check Boss Man reconnected: open Settings → Server and runner → Server. Role should read leader. (Boss Man can't tell which server copy is live, so no command is shown.)"),
    );
    return steps;
  }
  /** What the hand-apply of a changed database or proxy undoes: no command, because only settings change and the data is never touched. */
  const serviceRollback = (svc: OwnerService) =>
    svc === "db"
      ? "This step only changes how the database runs; your data is not altered. The backup from the backup step is kept. If Boss Man does not come back, ask us on this ticket before doing anything else."
      : "This step only changes how the proxy runs. If Boss Man does not come back, ask us on this ticket before doing anything else.";

  /** Clears each service card whose service is no longer pending (the container was recreated), without the owner doing anything. */
  async function clearServiceCards(a: Available | null) {
    if (a?.servicesChecked !== true) return; // an older host script or a failed compare says nothing about pending: keep the card
    const open = await db
      .select({ key: decisions.dedupeKey })
      .from(decisions)
      .where(and(eq(decisions.status, "open"), sql`${decisions.dedupeKey} like ${`${SERVICE_KEY}%`}`));
    for (const { key } of open) {
      const svc = key?.slice(SERVICE_KEY.length).split(":")[0];
      if (key && svc && !a.pendingServices.includes(svc)) await clearOwnerTodo(db, key, `The host reports the ${svc === "db" ? "database" : svc} running with its new settings. Marked done.`);
    }
  }

  /**
   * Raises the separate card for a changed database or proxy (BOS-487). Only when the host says it is still running the old
   * settings, the server update that brought them has ended well and its standby window is over, and the host is quiet.
   * Never part of a server update. Quiet is retried on the next pass; one card per service and commit.
   */
  async function raiseServiceCards(a: Available | null) {
    if (!a?.deployed || a.servicesChecked !== true) return;
    const wanted = OWNER_SERVICES.filter((s) => a.pendingServices.includes(s));
    if (!wanted.length) return;
    const last = await getSetting<LastServer>(LAST_SERVER);
    if (last?.result !== "deployed" || last.to !== a.deployed) return;
    const ended = Date.parse(last.ended);
    if (!Number.isFinite(ended) || Date.now() < ended + trialMs(a)) return;
    if (deps.hostQuiet && !(await deps.hostQuiet().catch(() => false))) return;
    const companyId = await homeCompany();
    if (!companyId) return;
    const host = (await deps.hosts?.())?.[0]?.name ?? null;
    for (const svc of wanted) {
      const word = SERVICE_WORDS[svc];
      await raiseOwnerTodo(db, {
        companyId,
        question: `This update changes the ${word}'s settings, and they are not applied yet. Apply them when you are ready: Boss Man is unreachable for a few seconds.`,
        key: `${SERVICE_KEY}${svc}:${a.deployed}`,
        steps: serviceSteps(svc, a.deployed, a, host),
        check: `Settings → Server and runner → Server: Role reads leader, and this card clears by itself once the host sees the ${word} running with its new settings.`,
        rollback: serviceRollback(svc),
        ofDecisionId: "system",
      });
    }
  }

  return {
    enabled: !!dir,
    /** What the host deployer last reported: its last request's result, and what is live and on main (BOS-420's wait reads both). */
    status,
    available,

    /**
     * The owner's hand-apply to-dos the host has caught up with (BOS-122): once the live commit is no
     * longer the one that ran at approval, the hand-apply reached the host and the to-do clears without
     * the owner doing anything. (It may land on a later commit than the approved one, per BOS-124.)
     * Rows from before `fromCommit` existed fall back to an exact match on the approved commit.
     */
    async clearDoneOwnerTodos(a: Available | null, s?: DeployStatus | null) {
      if (!a?.deployed) return 0;
      // When the host says it deployed the live commit, its own end time is when it went live; otherwise
      // the poll's time is the best we have. Either way it is a real reading, never guessed.
      const deployed = s?.result === "deployed" && s.to_commit === a.deployed ? Date.parse(s.ended) : NaN;
      const liveAt = Number.isFinite(deployed) ? new Date(deployed) : new Date(a.checkedAt);
      const todos = await db
        .select({ id: decisions.id, context: decisions.context })
        .from(decisions)
        .where(and(eq(decisions.status, "open"), sql`${decisions.context}->>'type' = 'owner_todo'`, sql`${decisions.context}->>'target' = 'server'`));
      let cleared = 0;
      for (const todo of todos) {
        const ctx = todo.context as Extract<DecisionContext, { type: "owner_todo" }>;
        const caughtUp = ctx.fromCommit ? a.deployed !== ctx.fromCommit : ctx.commit === a.deployed;
        if (!caughtUp) continue;
        const r = await clearOwnerTodo(db, `owner-todo:self-deploy:${ctx.commit}`, `The approved change to ${short(a.deployed)} is applied: the host reports it running. Marked done.`);
        if (r) {
          // BOS-739: leave a notice where the card was, so an owner part-way through its steps knows why
          // it closed (the update went live by itself), and its steps stay readable with it.
          await leaveClosedNotice(db, r.id, liveNotice({ commit: a.deployed, liveAt, steps: ctx.steps, now: new Date() }), { notify: deps.notify });
          cleared++;
        }
      }
      return cleared;
    },

    /** One pass of the poller. Skips the pass when the host's files haven't changed (BOS-414). // leader-only: phase 3 runs this on the leader alone. */
    async sync() {
      if (!dir) return;
      // BOS-753: while a request waits for the host's next tick, keep its list of checked merges current, so a merge
      // that lands in that minute can still be the one that goes out. Nothing is queried while no request waits.
      if (await pending()) await writeChecked().catch((err: Error) => deps.log?.(`self-deploy: could not write the checked list: ${err.message}`));
      if (await unchanged()) return;
      const s = await status();
      const a = await available();
      if (s && s.result !== "running") await finished(s, a);
      // A to-do clears as soon as what runs is the approved commit, even if the rest below returns early.
      if (a) await this.clearDoneOwnerTodos(a, s);
      if (s?.result !== "running") await releaseRunnerDue(a);
      // The database/proxy step is its own card, never part of a server update (BOS-487).
      await clearServiceCards(a);
      if (s?.result !== "running") await raiseServiceCards(a);
      const woken = await this.noteLive(a, s);
      if (!a || !a.tip || s?.result === "running" || (await pending())) return woken;
      // The host just refused or deployed this very commit: the offer is stale until the host rewrites it.
      if (s && ["rejected", "deployed", "nothing_new"].includes(s.result) && s.to_commit === a.tip && Date.parse(a.checkedAt) <= Date.parse(s.ended)) return woken;
      if (a.tip === a.deployed) {
        // Free the dedupe key, as every other withdraw does, so a later offer for that commit is not silently dropped (Freddy).
        // BOS-739 (8 Nov 13:47): the owner may be part-way through this card's hand steps; the notice says it is live and they can stop.
        const liveAt = s?.result === "deployed" && s.to_commit === a.deployed && Number.isFinite(Date.parse(s.ended)) ? new Date(s.ended) : new Date(a.checkedAt);
        for (const d of await openFor("server")) await withdrawOpen(d.id, (steps) => liveNotice({ commit: a.deployed, liveAt, steps, now: new Date() }));
        return woken;
      }
      await raise("server", a.tip, a.deployed, a);
      return woken;
    },

    /**
     * Tells the release log what is live now (BOS-284): the commit the host says it deployed (a deploy,
     * a blue/green switch or switch-back, a rollback, or a hand-apply the host saw), then lets it wake
     * each company's Release Manager on one small ticket. The commit is the same one server_status
     * reports as live, so nothing here depends on where the host keeps its files. Returns how many
     * Release Managers were woken.
     */
    async noteLive(a: Available | null, s: DeployStatus | null) {
      if (!deps.releaseLog) return 0;
      const live = a?.deployed || ((s && (s.result === "deployed" || s.result === "rolled_back") && s.to_commit) || "") || process.env.BOSSMAN_COMMIT || "";
      if (!z.string().regex(/^[0-9a-f]{40}$/i).safeParse(live).success) return 0;
      const rows = await db.select({ id: companies.id }).from(companies);
      for (const c of rows) await deps.releaseLog.note(c.id, live);
      const how: ReleaseHow = !s ? "restarted" : s.result === "rolled_back" ? "rolled-back" : "deployed";
      return deps.releaseLog.releaseManagerWakes(how);
    },

    /** The "Deploy latest" button. Returns the open decision, or says why there is none. */
    async deployLatest() {
      const a = await available();
      if (!dir) return { error: "Self-deploy is not set up on this install." } as const;
      // BOS-753: no offer is not the same as no deployer: after a deploy the host removes its offer and rewrites it next tick.
      if (!a || !a.tip) return { error: await noOfferReason(a, await status()) } as const;
      if (a.tip === a.deployed) {
        // The host looks at main every few minutes; this file asks it to look on its next tick. Only its existence is read.
        const asked = await askHostToLook();
        return { error: `Already up to date (${short(a.deployed)}), checked ${a.checkedAt}.${asked ? " Looking at main again now: if something has just merged, the deploy question appears in Decisions within a minute or two." : ""}` } as const;
      }
      const open = (await openFor("server")).find((d) => (d.context as SelfDeployContext).commit === a.tip);
      const d = open ?? (await raise("server", a.tip, a.deployed, a, true));
      return d ? ({ decisionId: d.id } as const) : ({ error: "Create a company first: decisions belong to one." } as const);
    },

    /** The "Build and update runners" button: rebuilds the runner image from what is deployed, e.g. after a deploy by hand. */
    async updateRunners() {
      if (!dir) return { error: "Self-deploy is not set up on this install." } as const;
      const a = await available();
      if (!a?.deployed) return { error: await noOfferReason(a, await status()) } as const;
      if (await inTrial()) return { error: trialMessage(soakSeconds(a)) } as const;
      const open = (await openFor("runner")).find((d) => (d.context as SelfDeployContext).commit === a.deployed);
      const d = open ?? (await raise("runner", a.deployed, a.deployed, a, true));
      return d ? ({ decisionId: d.id } as const) : ({ error: "Create a company first: decisions belong to one." } as const);
    },

    /** What Settings shows. */
    async overview() {
      const [s, a] = [await status(), await available()];
      // BOS-753: when the host deployer last showed it is alive, so Settings only says "not reported" when it really is overdue.
      return { enabled: !!dir, status: s, available: a, pending: await pending(), deployer: await deployerSeen(a, s), lateAfterMinutes: DEPLOYER_LATE_MS / 60_000 };
    },

    /**
     * The facts the owner-card lint's R15 needs (DR-036): whether Boss Man raises its own update card here (the
     * deployer folder is set), the install folder the host reported, and the commit its open card offers. An
     * install without the deployer is `enabled: false`, so agent update cards are left alone there.
     */
    async cardFacts(): Promise<SelfDeployFacts> {
      if (!dir) return { enabled: false };
      const a = await available();
      const rec = await deps.facts?.().catch(() => ({} as Record<string, string>)) ?? {};
      const installDir = folder(a?.srcDir ?? rec["paths.src"]) ?? undefined;
      const open = (await openFor("server")).map((d) => (d.context as SelfDeployContext)).find((c) => !!c.commit);
      return { enabled: true, ...(installDir ? { installDir } : {}), ...(open?.commit ? { openCommit: open.commit } : {}) };
    },

    /** Checked before an approval is recorded: one request at a time. */
    async check(ctx: SelfDeployContext) {
      if (!inboxFile) throw new AnswerError("Self-deploy is not set up on this install (BOSSMAN_DEPLOYER_DIR).");
      const s = await status();
      if (s?.result === "running") throw new AnswerError("A deploy is running now. Wait for it to finish.");
      if (await pending()) throw new AnswerError("A deploy request is already waiting for the host. Try again in a minute.");
      if (ctx.target === "runner" && (await inTrial())) throw new AnswerError(trialMessage(await currentTrial()));
      // Only the commit that failed to deploy is refused: after a rollback or a deploy by hand, what runs can still be built.
      if (ctx.target === "runner" && s?.target === "server" && s.result !== "deployed" && s.to_commit === ctx.commit) throw new AnswerError("The server deploy has not succeeded, so the runners are not updated.");
    },

    /** The host's memory report (BOS-420); null when there is none (an older deployer) or it can't be read. */
    headroom: () => (dir ? readJson(path.join(dir, "outbox", "headroom.json"), Headroom) : Promise.resolve(null)),

    /** When the current server update's standby window (its trial) ends, if one is running. */
    async trialUntil(): Promise<string | null> {
      return (await inTrial())?.after ?? null;
    },

    /** Whether a runner update card is open (the drain hands over to it after a server update). */
    async runnerCardOpen(): Promise<boolean> {
      return (await openFor("runner")).length > 0;
    },

    /**
     * Takes back a request the host hasn't picked up yet (the owner cancelled a waiting update, BOS-420).
     * Only our own request, by its id. False when there is none, or the host already took it.
     */
    async takeBack(decisionId: string): Promise<boolean> {
      if (!(await this.requestWaiting(decisionId))) return false;
      return rm(inboxFile!).then(() => true, () => false);
    },

    /** True when our own request (by its id) is still in the inbox, not yet picked up by the host. */
    async requestWaiting(decisionId: string): Promise<boolean> {
      if (!inboxFile) return false;
      const raw = await readFile(inboxFile, "utf8").catch(() => "");
      try {
        return (JSON.parse(raw) as { id?: unknown }).id === decisionId;
      } catch {
        return false;
      }
    },

    /**
     * Hands the approved request to the host. // leader-only
     * `override`: the owner chose "Update now anyway", so the host's memory floor doesn't hold it (BOS-420).
     */
    async send(ctx: Pick<SelfDeployContext, "target" | "commit">, decisionId: string, opts: { override?: boolean } = {}) {
      // BOS-753: the checked merges go first, so the host can deploy the newest of them if main moves on before its tick.
      // A failure here never blocks the deploy: without the list the host deploys the approved commit (still on main).
      if (ctx.target === "server") await writeChecked().catch((err: Error) => deps.log?.(`self-deploy: could not write the checked list: ${err.message}`));
      await writeRequest(decisionId, ctx.target, ctx.commit, opts);
    },

    /**
     * The "Restart the server" button (BOS-647): asks the host for a fresh copy of the commit that runs now. The
     * owner's click is the approval (like the other owner-only Settings actions), so no decision card is raised.
     * The host checks the commit is still what runs, shares the server's rate limit and, with blue/green, refuses
     * during a trial window; the checks here only stop a request that could never be acted on. // leader-only
     */
    async restartServer() {
      if (!inboxFile) return { error: "Self-deploy is not set up on this install." } as const;
      const a = await available();
      if (!a?.deployed || !/^[0-9a-f]{40}$/.test(a.deployed)) return { error: "The host deployer has not reported yet. Check that its cron job is running." } as const;
      if ((await status())?.result === "running") return { error: "A deploy is running now. Wait for it to finish." } as const;
      if (await pending()) return { error: "A request is already waiting for the host. Try again in a minute." } as const;
      const id = randomUUID();
      await writeRequest(id, "restart", a.deployed);
      return { requestId: id, commit: a.deployed, bluegreen: a.bluegreen === true } as const;
    },
  };
}
export type SelfDeploy = ReturnType<typeof selfDeployService>;
