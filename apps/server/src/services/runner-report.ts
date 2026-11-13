// What the runner looks like NOW, and what the last runner update did, in words for Settings (BOS-465).
// The Settings panel used to lead with the last update attempt, so one past problem stayed red for hours
// after the runner came back healthy. Here the live state comes first; a past problem whose runner has
// since connected on the image that update installed (or newer) is only history, shown as "Resolved".
import { eq, like } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { companies, runners as runnersTable, settings } from "../db/schema.js";
import { getHold, SWAP_PUT_BACK, SWAP_PUT_BACK_FAILED, SWAP_PUT_BACK_RUNNING, SWAP_WINDOW_MS, type Hold, type LastUpdate } from "./maintenance.js";

/** Whether the runner's image is the one an update installed, or newer (both are date-time stamps, so they sort as strings). */
export function imageAtLeast(have: string | null | undefined, want: string | null | undefined): boolean | null {
  if (!have || !want) return null;
  if (/^\d{8,}$/.test(have) && /^\d{8,}$/.test(want)) return have >= want;
  // A build that lost its stamp ("dev", blank) can't be ordered: only an exact match counts.
  return have === want;
}

/** The one image an update's history is about, when every stamp in it is the same; null when there is none or several. */
export function imageFor(last: LastUpdate | null): string | null {
  const stamps = [...new Set([...String(last?.body ?? "").matchAll(/\b(\d{8,})\b/g)].map((m) => m[1]!))];
  return stamps.length === 1 ? stamps[0]! : null;
}

export type RunnerLive = {
  registered: boolean;
  connected: boolean;
  /** When the current connection opened, or when it was last seen if it is away. */
  at: string | null;
  imageVersion: string | null;
  /** The launcher's own words when it can't give a state for this company (e.g. it is down). */
  fault: string | null;
  /** BOS-382: a planned runner swap for this company is under way (the update hold is on, and it hasn't failed). */
  swap?: { retryAt: string | null; tries: number } | null;
  /** BOS-382: the swap for this company failed while the hold is on, in the drain's own words. */
  swapFailed?: string | null;
  /** BOS-382 slice A: the launcher froze this runner because its network guard isn't healthy. */
  guard?: { reason: string; since: string | null } | null;
};

/** What the panel shows now: drives the tag colour and whether Start runner may be pressed. */
export type LiveState = "connected" | "updating" | "paused" | "failed" | "offline" | "none";

export type UpdateReport = {
  at: string;
  title: string;
  body: string;
  /** "ok" for a success, "resolved" for a past problem the runner has since got past, "problem" for one that is still real. */
  state: "ok" | "resolved" | "problem";
  /** Only on a problem: one plain sentence saying what to do, or that there is nothing to do. */
  todo: string | null;
};

/** "business-co: Removing the runner failed: …", as the launcher wrote it, split back into its companies. */
function historyLines(body: string): Array<{ slug: string; message: string }> {
  return String(body ?? "")
    .split(/;\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((raw) => {
      const m = /^([^:]+):\s*(.+)$/.exec(raw);
      return m ? { slug: m[1]!.trim(), message: m[2]!.trim() } : { slug: "", message: raw };
    });
}

/** The last update, judged against what each company's runner is doing now. */
export function judgeUpdate(last: LastUpdate | null, live: Record<string, RunnerLive>): UpdateReport | null {
  if (!last) return null;
  const base = { at: last.at, title: last.title, body: last.body };
  if (last.ok) return { ...base, state: "ok", todo: null };
  const image = imageFor(last);
  const lines = historyLines(last.body);
  const still: string[] = [];
  for (const l of lines) {
    const r = live[l.slug];
    if (/^has not reconnected$/i.test(l.message)) {
      // It only needed longer: if it is connected now, on that image or a newer one, it got there.
      const ok = r?.connected && (imageAtLeast(r.imageVersion, image) ?? true);
      if (ok) continue;
      still.push(`${l.slug}: still not connected`);
      continue;
    }
    // A removal that raced another is not a failure once the runner is here: the rush was the other removal finishing.
    if (/already in progress/i.test(l.message) && r?.connected) continue;
    still.push(l.slug ? `${l.slug}: ${l.message}` : l.message);
  }
  const faults = Object.entries(live)
    .filter(([, r]) => r.fault)
    .map(([slug, r]) => `${slug}: ${r.fault}`);
  const broken = [...still, ...faults];
  if (!broken.length) {
    // Nothing it named is still wrong: the runner came back, so this is history.
    return { ...base, state: "resolved", todo: null };
  }
  // Most specific first: slice C (BOS-382) quotes the launcher error inside its own words.
  const rules: Array<[RegExp, string]> = [
    [/reach the launcher/i, "The launcher isn't answering: start it, then try Settings → Runner again."],
    [new RegExp(SWAP_PUT_BACK_FAILED, "i"), "The update failed and the runner couldn't be put back: press Start runner in Settings → Runner."],
    [new RegExp(SWAP_PUT_BACK, "i"), "Nothing to do now: the runner is running its previous version, and the next runner update tries again."],
    [/network guard/i, "The runner's network guard wouldn't start: press Restart in Settings → Runner."],
    [/Creating the runner failed|Removing the runner failed/i, "A runner couldn't be replaced: start it again from Settings → Runner."],
    [/still not connected/i, "A runner hasn't connected since: start it again from Settings → Runner."],
  ];
  const todo = rules.find(([re]) => broken.some((b) => re.test(b)))?.[1] ?? "Nothing to do: this was a one-off and runs are starting normally.";
  return { ...base, state: "problem", todo };
}

/** The hour and minute of a stored time, as the panel's other times show them (the browser's own zone). */
export function clock(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

/** The live state in one line: "Runner connected since 16:23 · image 202611040849", or red "Not connected since …". */
export function describeLive(r: RunnerLive | null): { ok: boolean; text: string; state: LiveState } {
  if (!r || !r.registered) return { ok: false, text: "No runner is registered for this company yet.", state: "none" };
  if (r.connected) return { ok: true, text: `Runner connected${r.at ? ` since ${clock(r.at)}` : ""}${r.imageVersion ? ` · image ${r.imageVersion}` : ""}`, state: "connected" };
  // BOS-382: away because of a planned swap is not a fault, and pressing Start mid-swap would race it.
  if (r.swap) {
    const again = r.swap.retryAt ? ` The last try failed; trying again at ${clock(r.swap.retryAt)} (try ${r.swap.tries + 1}).` : "";
    return { ok: true, text: `Updating: swapping to the new runner.${again} It starts by itself; no need to press anything.`, state: "updating" };
  }
  // The swap failed but the launcher put the old runner back: it is starting by itself, so don't invite a second press.
  if (r.swapFailed && new RegExp(SWAP_PUT_BACK_RUNNING, "i").test(r.swapFailed)) {
    return { ok: true, text: "The update failed, so the runner was put back on its previous version and is starting by itself. No need to press anything.", state: "updating" };
  }
  if (r.swapFailed) return { ok: false, text: `Update failed: ${r.swapFailed}. Press Start runner below.`, state: "failed" };
  if (r.guard) return { ok: false, text: `Paused: the network guard isn't working (${r.guard.reason}). Boss Man keeps retrying it and the runner carries on by itself once it works. If this lasts, press Restart below.`, state: "paused" };
  // A runner that is down always says what to do, whether or not an update problem is also recorded.
  const when = r.at ? ` since ${clock(r.at)}` : "";
  return { ok: false, text: `Not connected${when} — start it again from Settings → Runner.`, state: "offline" };
}

/**
 * This company's part of the update hold, if any (BOS-382). A company is "swapping" only while its own swap
 * is in progress: it was recreated within the dial-in window, or it is on its retry schedule. A hold that is
 * only waiting for busy agents, a wrap-up hold, or a runner that crashed after it was swapped is not a swap:
 * that runner is just down, and Start runner must stay available.
 */
export function swapFor(hold: Hold | null, slug: string | undefined, nowMs: number = Date.now()): Pick<RunnerLive, "swap" | "swapFailed"> {
  const none = { swap: null, swapFailed: null };
  if (!hold || !slug || hold.kind === "wrapup") return none;
  const failed = hold.failed?.[slug];
  if (failed) return { swap: null, swapFailed: failed };
  const t = hold.tries?.[slug];
  if (t) return { swap: { retryAt: t.next, tries: t.n }, swapFailed: null };
  const at = hold.swapped?.[slug];
  if (at && nowMs - new Date(at).getTime() < SWAP_WINDOW_MS) return { swap: { retryAt: null, tries: 0 }, swapFailed: null };
  return none;
}

type MaintenanceLike = { status: () => Promise<{ last?: LastUpdate | null }> };

export type RunnerReportDeps = {
  /** Whether this company's runner has an open socket (runnersService.isConnected). */
  isConnected: (runnerId: string) => boolean;
  /** When its current connection opened (runnersService.connectedSince). */
  connectedSince: (runnerId: string) => Date | null;
  /** The launcher's view of a company's container; absent or null when the launcher is off (launcherService.status). */
  launcher?: (companyId: string) => Promise<{ slug: string; container: { state: string; status: string; image: string; guardReason?: string; guardSince?: string } | null; error?: string } | null>;
};

const SLUG_KEY = "runner-slug:";

export function runnerReportService(db: Db, maintenance: MaintenanceLike, deps: RunnerReportDeps) {
  /** companyId -> launcher slug, for the companies that have one. */
  async function slugs(): Promise<Map<string, string>> {
    const rows = await db.select({ key: settings.key, value: settings.value }).from(settings).where(like(settings.key, `${SLUG_KEY}%`));
    return new Map(rows.map((r) => [r.key.slice(SLUG_KEY.length), r.value as string]));
  }

  const nowMs = () => Date.now();

  async function liveOne(companyId: string, runner: (typeof runnersTable.$inferSelect) | null, slug?: string, hold?: Hold | null): Promise<RunnerLive> {
    let fault: string | null = null;
    let guard: RunnerLive["guard"] = null;
    if (deps.launcher) {
      const l = await deps.launcher(companyId).catch(() => null);
      fault = l?.error ?? null;
      if (l?.container?.guardReason) guard = { reason: l.container.guardReason, since: l.container.guardSince ?? null };
    }
    if (!runner) return { registered: false, connected: false, at: null, imageVersion: null, fault };
    const connected = deps.isConnected(runner.id);
    const since = connected ? deps.connectedSince(runner.id) : null;
    return { registered: true, connected, at: (since ?? runner.lastSeenAt)?.toISOString() ?? null, imageVersion: runner.imageVersion, fault, guard, ...swapFor(hold ?? null, slug, nowMs()) };
  }

  return {
    /** Whether this company's own runner swap is under way right now (server_status `swapping`). */
    async swappingFor(companyId: string): Promise<boolean> {
      const slug = (await slugs()).get(companyId);
      return !!swapFor(await getHold(db), slug, nowMs()).swap;
    },

    /** The update panel: every runner's live state first, then the last update as history. */
    async updatePanel() {
      const list = await db.select({ id: companies.id, name: companies.name }).from(companies);
      const slugOf = await slugs();
      const hold = await getHold(db);
      const rows = await db.select().from(runnersTable);
      const live: Record<string, RunnerLive> = {};
      const now: Array<{ slug: string; name: string } & RunnerLive> = [];
      for (const c of list) {
        const slug = slugOf.get(c.id);
        const runner = rows.find((r) => r.companyId === c.id) ?? null;
        const l = await liveOne(c.id, runner, slug, hold);
        if (slug) {
          live[slug] = l;
          now.push({ slug, name: c.name, ...l });
        } else now.push({ slug: c.name, name: c.name, ...l });
      }
      const { last } = await maintenance.status();
      return { live: now, update: judgeUpdate(last ?? null, live) };
    },

    /** One company's Settings → Runner: the same live-first state, and the same rule for a past problem. */
    async companyPanel(companyId: string) {
      const [c] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
      if (!c) return null;
      const [runner] = await db.select().from(runnersTable).where(eq(runnersTable.companyId, companyId));
      const slug = (await slugs()).get(companyId);
      const live = await liveOne(companyId, runner ?? null, slug, await getHold(db));
      const { last } = await maintenance.status();
      // A company a problem's lines don't name gets no blame for it; a named one is judged by what its runner is doing now.
      const named = !!last && !last.ok && !reportNames(last, slug) && !!slug;
      return { live: describeLive(live), last: last && !named ? judgeUpdate(last, slug ? { [slug]: live } : {}) : null };
    },
  };
}

/** Whether an update's history names this company (a success names no company, so it is about all of them). */
export function reportNames(last: LastUpdate, slug: string | undefined): boolean {
  if (!slug) return false;
  return new RegExp(`(^|[^a-z0-9-])${slug}([^a-z0-9-]|$)`).test(last.body);
}
