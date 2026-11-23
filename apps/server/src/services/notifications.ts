// Owner notifications (R44). Everything the owner is told goes through here: decisions that
// need them, alerts, and agents' own notes. Each has a level (note, flag, page, ask); quiet
// hours and each agent's hourly cap lower it rather than drop it, and every one links to its
// evidence. Pages and asks also go to the owner's phone through their own ntfy server, so
// Boss Man only ever sends outbound requests and is never exposed at the router.
import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { effectiveLevel, inQuietHours, isTimeZone, NOTIFY_LEVELS, sinceHours, type NotifyLevel } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, notifications, settings } from "../db/schema.js";
import type { DecisionContext } from "./decisions.js";
import type { AlertKind } from "./webhook-delivery.js";

/** Which alert kind an owner card is, from its type (BOS-2199). Everything else on the owner's tier is a decision waiting. */
export function alertKindOfCard(ctx: { type?: string } | null): AlertKind {
  switch (ctx?.type) {
    case "stalled_run":
    case "run_time_limit":
      return "run_failed";
    case "budget_limit":
      return "spend_alert";
    case "check_stuck":
      return "merge_stuck";
    default:
      return "decision_waiting";
  }
}

/** Handed each saved alert for Slack, Discord and webhook delivery; must return at once and never throw. */
export type AlertHook = (alert: { kind: AlertKind; title: string; text: string; link: string; publicUrl: string | null }) => void;

/**
 * The ntfy server's address. Pushes go to it with its path kept (BOS-243 rule 8), so one served under
 * a path such as https://host/ntfy works; a query or # part would be dropped silently, so it is refused.
 */
export const NtfyTopic = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "The topic can only use letters, digits, - and _ (up to 64 characters)");
export const NtfyUrl = z
  .string()
  .url()
  .refine((u) => {
    const p = new URL(u);
    return !p.search && !p.hash && !u.includes("?") && !u.includes("#");
  }, "Use the ntfy server's address without a ? or # part, e.g. https://ntfy.example.ts.net or https://host/ntfy");

/** Which cards reach the phone (BOS-1006): the urgent ones by default, or everything the old tick boxes did. */
export const PHONE_PUSH_MODES = ["urgent", "all"] as const;
export type PhonePushMode = (typeof PHONE_PUSH_MODES)[number];

/** Which phone the owner uses (BOS-1484), so agents and the Notifications page don't guess. Unset until the owner says. */
export const PHONE_TYPES = ["android", "iphone", "both"] as const;
export type PhoneType = (typeof PHONE_TYPES)[number];

export const NotifySettings = z.object({
  quietHours: z
    .object({
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM"),
      end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM"),
      timeZone: z.string().refine((tz) => isTimeZone(tz), "Use a time zone name such as Europe/London"),
    })
    .nullable(),
  /** Notifications per agent per hour before the rest become notes. */
  agentHourlyCap: z.number().int().min(1).max(100),
  /** Phone push through the owner's own ntfy server; the token is held as a secret. */
  ntfy: z.object({ url: NtfyUrl, topic: NtfyTopic, tokenSecretId: z.string().uuid().nullable() }).nullable(),
  /**
   * Which cards go to the phone (BOS-1006). "urgent" (the default, and what an install saved before the
   * setting existed reads as) sends only a blocking card, a fixesLive deploy, a page and the test push.
   * "all" sends the routine ones too, at a normal priority. Kept for installs that saved it.
   */
  phonePush: z.enum(PHONE_PUSH_MODES).optional(),
  /**
   * The old tick boxes, which "all" stands in for (BOS-1006). Kept so an install saved before the setting
   * still loads: its list of levels says whether it wanted pages and asks on the phone.
   */
  pushLevels: z.array(z.enum(NOTIFY_LEVELS)).optional(),
  /** Boss Man's address as the phone should open it, e.g. https://bossman.tailnet.ts.net. */
  publicUrl: z.string().url().nullable(),
  /** The owner's off switch for phone Approve buttons (BOS-243); on unless set to false. */
  approveButtons: z.boolean().optional(),
  /** The owner's phone type (BOS-1484): android, iphone or both. Null or missing means the owner hasn't said. */
  phoneType: z.enum(PHONE_TYPES).nullable().optional(),
});
export type NotifySettings = z.infer<typeof NotifySettings>;

/** An ntfy action button: "view" opens a page, "http" sends a request from the phone. */
export type PushAction =
  | { action: "view"; label: string; url: string; clear?: boolean }
  | { action: "http"; label: string; url: string; method: "POST"; headers: Record<string, string>; body: string; clear: boolean };

/**
 * Phone Approve (services/phone-approve.ts), wired in from app.ts like the alert ladder. Asked only
 * when a decision push is really about to go out, so quiet hours and demoted levels mint nothing.
 * It returns the Approve button, the push text it needs, and how to kill the link if the push fails.
 */
export type ApproveHook = { forPush(decisionId: string, s: NotifySettings): Promise<{ action: PushAction; message: string; revoke(): Promise<unknown> } | null> };

/** Where a push goes: the ntfy URL with its path kept and a trailing slash (rule 8), never just the host's root. */
export function ntfyPublishUrl(url: string): string {
  const u = new URL(url);
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  // Settings refuse these now; an address saved before that still posts where it always did.
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** A link in the app as the phone opens it on the public URL. */
export const appUrl = (publicUrl: string, link: string) => `${publicUrl.replace(/\/$/, "")}/${link}`;
export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { quietHours: null, agentHourlyCap: 6, ntfy: null, phonePush: "urgent", publicUrl: null };

/** Whether the owner wants routine cards on the phone too (BOS-1006); urgent-only unless they chose all. */
export function wantsEveryPush(s: NotifySettings): boolean {
  return s.phonePush === "all";
}

const KEY = "notifications";
export const PHONE_TEST_KEY = "notifications.phone-test";
const PHONE_TEST_TTL_MS = 15 * 60_000;
/**
 * The last test push. `url` is the public address its Got it button posted to (BOS-1797): a tap proves the phone
 * reached Boss Man at that address, not at whatever the box holds later. Absent on a record from before it was kept.
 */
export type PhoneTestRecord = { sentAt: string; tokenHash: string | null; expiresAt: string | null; confirmedAt: string | null; url?: string | null };
const hashTestToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Cuts text to fit in `max` bytes of UTF-8, without splitting a character. */
export function fitBytes(text: string, max: number): string {
  const enc = new TextEncoder();
  if (enc.encode(text).length <= max) return text;
  let out = "";
  let used = 0;
  for (const ch of text) {
    const n = enc.encode(ch).length;
    if (used + n > max - 3) break;
    out += ch;
    used += n;
  }
  return `${out}...`;
}
/** Where "See the evidence" goes: the run that stalled, the ticket that is blocked, else the decision list. */
function evidenceLink(ctx: DecisionContext): string {
  if (ctx.type === "stalled_run") return `#/runs/${ctx.runId}`;
  if (ctx.type === "stale_blocker") return `#/tickets/${ctx.blockedTicketId}`;
  return "#/decisions";
}
/** An urgent push breaks through on the phone (BOS-1006); a routine one sent under "All decisions" is normal. */
export const URGENT_PRIORITY = 5;
export const ROUTINE_PRIORITY = 3;

/**
 * `noPush` keeps a routine card (BOS-1010's runner update) in the feed and the browser only, never on the phone,
 * whatever the owner's push levels say: it is not urgent, and the owner should see it when they next look, not be
 * buzzed for it.
 */
export type NotifyInput = { companyId: string | null; agentId?: string | null; level: NotifyLevel; /** Which alert kind this is for the owner's Slack, Discord and webhook destinations (BOS-2199). Unset: a card's own type decides, and anything else goes to none. */ kind?: AlertKind; title: string; body?: string | null; link: string; decisionId?: string | null; noPush?: boolean; /** Why the card is urgent (BOS-1097): a live-fix deploy or the CEO's urgent mark. Set, it goes to the phone whatever the setting; the text is shown on the Notifications page. */ urgentReason?: string };

/** What the CEO sets to mark an owner card urgent (BOS-1097): decisions escalate with urgent true; stored on the card's context. */
export type UrgentPush = { by: string; at: string; why: string };
export const urgentPushOf = (context: unknown): UrgentPush | null => {
  const u = (context as { urgentPush?: UrgentPush } | null)?.urgentPush;
  return u && typeof u.why === "string" ? u : null;
};
/** "fetch failed" plus the underlying code and message, and the host (no path, query or token) the push went to. */
export function describeFetchError(err: unknown, input: Parameters<typeof fetch>[0]): string {
  const e = err as { name?: string; message?: string; code?: string; cause?: unknown };
  const parts: string[] = [];
  let cur: unknown = e;
  // Walk the cause chain (an AggregateError holds one per address tried).
  for (let i = 0; i < 4 && cur && typeof cur === "object"; i++) {
    const c = cur as { code?: string; message?: string; errors?: Array<{ code?: string }>; cause?: unknown };
    if (c.code) parts.push(c.code);
    else if (c.errors?.length) parts.push(...c.errors.map((x) => x.code).filter((x): x is string => !!x));
    if (c.message && i > 0 && c.message !== "fetch failed") parts.push(c.message);
    cur = c.cause;
  }
  let host = "";
  try {
    host = new URL(typeof input === "string" || input instanceof URL ? input : input.url).host;
  } catch {
    /* no host to show */
  }
  const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
  const why = timedOut ? "timed out after 10 s" : [...new Set(parts)].join(": ");
  return `${timedOut ? "ntfy request" : (e.message ?? "fetch failed")}${host ? ` to ${host}` : ""}${why ? ` (${why})` : ""}`;
}
/** ntfy answers these when the server has no clear endpoint (before 2.14): 404/405, or 400 for the sequence id form. */
const CLEAR_UNSUPPORTED = /^ntfy answered (400|404|405|501)$/;

export function notificationsService(db: Db, deps: { reveal: (secretId: string) => Promise<string | null>; fetch?: typeof fetch; now?: () => Date; log?: (msg: string) => void }) {
  const now = deps.now ?? (() => new Date());
  const rawFetch = deps.fetch ?? fetch;
  // Node's fetch throws a bare "fetch failed" and keeps the real reason (ENOTFOUND, ECONNREFUSED, a TLS
  // error, a timeout) on `cause`. Say it, with the host tried, so the add-on state explains itself (BOS-1290).
  const doFetch: typeof fetch = async (input, init) => {
    try {
      return await rawFetch(input, init);
    } catch (err) {
      throw new Error(describeFetchError(err, input), { cause: err });
    }
  };
  let approveHook: ApproveHook | null = null;
  let alertHook: AlertHook | null = null;

  /** After the card is saved and the phone push is done: hand it to the owner's other destinations. Never blocks, never throws. */
  async function toDestinations(s: NotifySettings, input: NotifyInput, row: { title: string; body: string | null; link: string; decisionId: string | null }, level: NotifyLevel) {
    if (!alertHook) return;
    try {
      let kind = input.kind ?? null;
      if (!kind && row.decisionId && level !== "note") {
        const [d] = await db.select({ context: decisions.context }).from(decisions).where(eq(decisions.id, row.decisionId));
        kind = alertKindOfCard(d?.context as { type?: string } | null);
      }
      if (kind) alertHook({ kind, title: row.title, text: row.body ?? row.title, link: row.link, publicUrl: s.publicUrl });
    } catch (err) {
      deps.log?.(`alert destinations skipped: ${(err as Error).name}`);
    }
  }

  async function getSettings(): Promise<NotifySettings> {
    const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
    return { ...DEFAULT_NOTIFY_SETTINGS, ...((row?.value as Partial<NotifySettings> | undefined) ?? {}) };
  }

  /**
   * Publishes to ntfy as JSON (to the server's URL, path kept), so titles needn't fit in a header.
   * `plain` turns markdown off, for text that is shown exactly as stored (BOS-243).
   */
  async function push(s: NotifySettings, n: { title: string; body: string | null; link: string; level: NotifyLevel; urgent: boolean; actions?: PushAction[]; plain?: boolean; /** Lets a later clear find this message (ntfy 2.14+; older servers ignore it). */ sequenceId?: string }) {
    if (!s.ntfy) throw new Error("Phone push isn't set up.");
    const token = s.ntfy.tokenSecretId ? await deps.reveal(s.ntfy.tokenSecretId) : null;
    const res = await doFetch(ntfyPublishUrl(s.ntfy.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        topic: s.ntfy.topic,
        ...(n.sequenceId ? { sequence_id: n.sequenceId } : {}),
        title: fitBytes(n.title, 250),
        // ntfy turns a message over 4,096 bytes into an attachment.
        message: fitBytes(n.body ?? n.title, 3500),
        priority: n.urgent ? URGENT_PRIORITY : ROUTINE_PRIORITY,
        tags: [n.level === "ask" ? "question" : n.level === "page" ? "rotating_light" : "bell"],
        ...(s.publicUrl ? { click: appUrl(s.publicUrl, n.link) } : {}),
        ...(n.actions?.length ? { actions: n.actions } : {}),
        ...(n.plain ? { markdown: false } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  }

  /** The buttons on a decision push: Open always (with a public URL), Approve when phone-approve allows it. */
  async function decisionButtons(s: NotifySettings, decisionId: string, link: string) {
    const actions: PushAction[] = [];
    if (s.publicUrl) actions.push({ action: "view", label: "Open in Boss Man", url: appUrl(s.publicUrl, link), clear: false });
    let approve: Awaited<ReturnType<ApproveHook["forPush"]>> = null;
    try {
      approve = approveHook ? await approveHook.forPush(decisionId, s) : null;
    } catch (err) {
      // Approve is an extra: if it can't be offered, the push still goes out with Open only.
      deps.log?.(`phone approve skipped: ${(err as Error).message}`);
    }
    if (approve) actions.push(approve.action);
    return { actions, approve };
  }

  async function notify(input: NotifyInput) {
    const s = await getSettings();
    const t = now();
    let overCap = false;
    if (input.agentId) {
      const [row] = await db
        .select({ n: count() })
        .from(notifications)
        .where(and(eq(notifications.agentId, input.agentId), gt(notifications.createdAt, sinceHours(t)), sql`${notifications.level} <> 'note'`));
      overCap = Number(row?.n ?? 0) >= s.agentHourlyCap;
    }
    const { level, demotedBy } = effectiveLevel(input.level, { overCap, quiet: inQuietHours(t, s.quietHours) });
    const [row] = await db
      .insert(notifications)
      .values({ companyId: input.companyId, agentId: input.agentId ?? null, requested: input.level, level, demotedBy, title: input.title, body: input.body ?? null, link: input.link, decisionId: input.decisionId ?? null, createdAt: t })
      .onConflictDoNothing()
      .returning();
    if (!row) return null;
    // BOS-1006: only an urgent card reaches the phone unless the owner chose "All decisions". Quiet hours
    // still demote first, so an urgent ask in quiet hours arrives as a flag and doesn't push.
    // A routine card marked noPush (BOS-1010) never reaches the phone: the feed and the browser still show it.
    const urgent = input.level === "page" || !!input.urgentReason;
    const flagsToPhone = s.pushLevels?.includes("flag") ?? false;
    const routineToPhone = wantsEveryPush(s) && (level === "page" || level === "ask");
    const toPhone = s.ntfy && !input.noPush && (urgent ? level === "page" || level === "ask" : routineToPhone || (level === "flag" && flagsToPhone));
    if (toPhone) {
      // BOS-1097: re-read the card just before sending. One answered, withdrawn or no longer the owner's
      // (back with the CEO) while we were busy sends nothing.
      if (row.decisionId && !(await stillOwnersOpenCard(row.decisionId))) {
        deps.log?.(`phone push skipped: card ${row.decisionId} is settled or no longer the owner's`);
        return row;
      }
      const pushReason = input.level === "page" ? (input.urgentReason ?? "A page: Boss Man marked it urgent") : urgent ? input.urgentReason! : routineToPhone ? "You chose to send all decisions to your phone" : "You chose to send flags to your phone";
      const { actions, approve } = row.decisionId ? await decisionButtons(s, row.decisionId, row.link) : { actions: [], approve: null };
      try {
        await push(s, { ...row, actions, urgent, sequenceId: row.id, ...(approve ? { body: approve.message, plain: true } : {}) });
        await db.update(notifications).set({ pushedAt: now(), pushReason }).where(eq(notifications.id, row.id));
      } catch (err) {
        const msg = (err as Error).message;
        // A link the phone never received must not stay live.
        await approve?.revoke().catch(() => undefined);
        deps.log?.(`phone push failed: ${msg}`);
        await db.update(notifications).set({ pushError: msg.slice(0, 500) }).where(eq(notifications.id, row.id));
      }
    }
    // BOS-2199: the owner's other destinations (Slack, Discord, webhook), after the card is saved and the phone push is done.
    await toDestinations(s, input, row, level);
    return row;
  }

  /**
   * A notification about a decision is read once the decision is settled, whoever answered it and however.
   * Cards answered or withdrawn through the decisions service mark their own notification read at that
   * moment (BOS-413). This sweep is the safety net for a close made anywhere else, and runs once a minute
   * rather than on every feed poll, so a read never writes.
   */
  const readAnswered = () =>
    db
      .update(notifications)
      .set({ readAt: now() })
      .where(and(isNull(notifications.readAt), sql`${notifications.decisionId} in (select ${decisions.id} from ${decisions} where ${decisions.status} <> 'open')`));

  /** The card is open and on the owner's tier now (and not parked on an alert-ladder rung before the owner). */
  async function stillOwnersOpenCard(decisionId: string): Promise<boolean> {
    const [d] = await db.select({ status: decisions.status, tier: decisions.tier, context: decisions.context }).from(decisions).where(eq(decisions.id, decisionId));
    if (!d || d.status !== "open" || d.tier !== "owner") return false;
    const rung = (d.context as { ladder?: { rung?: string } } | null)?.ladder?.rung;
    return !rung || rung === "owner";
  }

  /**
   * Takes a settled card's push off the phone (BOS-1097): ntfy 2.14+ clears a message by its sequence id (the
   * notification's id). Never throws, and never holds up the answer: a failure is written on the row and shown
   * on the Notifications page. An older server answers 404/405, noted as "unsupported" and not retried.
   */
  async function clearPush(decisionId: string): Promise<void> {
    try {
      const [n] = await db.select().from(notifications).where(and(eq(notifications.decisionId, decisionId), isNotNull(notifications.pushedAt), isNull(notifications.pushClearedAt)));
      if (!n) return;
      const s = await getSettings();
      if (!s.ntfy) return;
      const setNote = (note: string | null, clearedAt: Date | null) => db.update(notifications).set({ pushClearNote: note, pushClearedAt: clearedAt }).where(eq(notifications.id, n.id));
      try {
        const token = s.ntfy.tokenSecretId ? await deps.reveal(s.ntfy.tokenSecretId) : null;
        const url = new URL(`${encodeURIComponent(s.ntfy.topic)}/${n.id}/clear`, ntfyPublishUrl(s.ntfy.url));
        const res = await doFetch(url, { method: "PUT", headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(10_000) });
        if (res.ok) await setNote(null, now());
        else {
          const msg = `ntfy answered ${res.status}`;
          await setNote(CLEAR_UNSUPPORTED.test(msg) ? "unsupported: this ntfy server is too old to clear a push (it needs version 2.14 or newer)" : `clear failed: ${msg}`, null);
        }
      } catch (err) {
        await setNote(`clear failed: ${(err as Error).message}`.slice(0, 300), null);
      }
    } catch (err) {
      deps.log?.(`phone push clear failed: ${(err as Error).message}`);
    }
  }

  /** Safety net for a card settled anywhere that did not call clearPush, and for a clear that failed in passing. */
  async function clearSettledPushes(): Promise<number> {
    const rows = await db
      .select({ decisionId: notifications.decisionId })
      .from(notifications)
      .where(
        and(
          isNotNull(notifications.pushedAt),
          isNull(notifications.pushClearedAt),
          gt(notifications.pushedAt, sinceHours(now(), 24)),
          sql`(${notifications.pushClearNote} is null or ${notifications.pushClearNote} not like 'unsupported:%')`,
          sql`${notifications.decisionId} in (select ${decisions.id} from ${decisions} where ${decisions.status} <> 'open')`,
        ),
      )
      .limit(20);
    for (const r of rows) if (r.decisionId) await clearPush(r.decisionId);
    return rows.length;
  }

  return {
    getSettings,
    clearPush,
    clearSettledPushes,

    /** The last 20 phone pushes with why each counted as urgent and whether its card is still open (BOS-1097). */
    async recentPushes(limit = 20) {
      const rows = await db
        .select({ n: notifications, status: decisions.status, tier: decisions.tier, company: companies.name })
        .from(notifications)
        .leftJoin(decisions, eq(decisions.id, notifications.decisionId))
        .leftJoin(companies, eq(companies.id, notifications.companyId))
        .where(isNotNull(notifications.pushedAt))
        .orderBy(desc(notifications.pushedAt))
        .limit(Math.min(limit, 50));
      return rows.map((r) => ({
        id: r.n.id,
        title: r.n.title,
        body: r.n.body,
        link: r.n.link,
        company: r.company,
        pushedAt: r.n.pushedAt,
        reason: r.n.pushReason,
        /** open: the card still waits on the owner; settled: answered or withdrawn; notice: not a card (a page). */
        state: r.status === null ? "notice" : r.status === "open" ? (r.tier === "owner" ? "open" : "with_ceo") : "settled",
        clearedAt: r.n.pushClearedAt,
        clearNote: r.n.pushClearNote,
      }));
    },

    async setSettings(next: NotifySettings) {
      const value = NotifySettings.parse(next);
      await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return value;
    },

    notify,

    setApproveHook(hook: ApproveHook) {
      approveHook = hook;
    },

    setAlertHook(hook: AlertHook) {
      alertHook = hook;
    },

    /**
     * A push with no notification row (the table holds one per decision): the phone Approve outcome
     * replies (BOS-243). Plain text, sent whatever the push levels, since the owner has just tapped.
     */
    async pushPlain(n: { title: string; body: string; link: string; actions?: PushAction[] }) {
      const s = await getSettings();
      if (!s.ntfy) return false;
      try {
        await push(s, { ...n, level: "flag", urgent: false, plain: true });
        return true;
      } catch (err) {
        deps.log?.(`phone push failed: ${(err as Error).message}`);
        return false;
      }
    },

    /**
     * Tells the owner about each open decision once: an ask when it's theirs to answer (a flag
     * when it's only an alert), a note when the CEO is handling it.
     */
    async syncDecisions() {
      const open = await db
        .select({ d: decisions, company: companies.name })
        .from(decisions)
        .innerJoin(companies, eq(companies.id, decisions.companyId))
        .leftJoin(notifications, eq(notifications.decisionId, decisions.id))
        .where(
          and(
            eq(decisions.status, "open"),
            isNull(notifications.id),
            gt(decisions.createdAt, new Date(now().getTime() - 7 * 86_400_000)),
            // Boss Man's own alerts (BOS-64) reach the owner only once they climb to them.
            sql`coalesce(${decisions.context}->'ladder'->>'rung', 'owner') = 'owner'`,
            // Lesson decisions are the CEO's (BOS-105); the owner hears the outcome in the feed.
            sql`coalesce(${decisions.context}->>'type', '') not in ('lesson', 'lesson_replace')`,
          ),
        )
        .orderBy(decisions.createdAt)
        .limit(100);
      for (const { d, company } of open) {
        const options = d.options as string[];
        const alertOnly = options.length === 1 && options[0] === "Got it";
        // A deploy card carrying the fix for a live problem (BOS-639) is paged, once per fix: a later card for
        // the same fix (main moved on) is a plain ask. Quiet hours still lower it, in notify, as for any page.
        const c = d.context as DecisionContext;
        const urgentFix = (c.type === "self_deploy" || c.type === "deploy") && d.tier !== "ceo" ? c.urgent : undefined;
        const level: NotifyLevel = d.tier === "ceo" ? "note" : urgentFix && !urgentFix.repeat ? "page" : alertOnly ? "flag" : "ask";
        // BOS-1097: only two kinds of card are urgent by themselves: a live-problem deploy, and a card the CEO
        // marked urgent when escalating it (context.urgentPush). Blocking a ticket no longer counts, and a
        // "Got it" notice never pushes. Pages come from notify_owner and the test push is urgent in `test`.
        const mark = urgentPushOf(d.context);
        const urgentReason = d.tier === "ceo" || alertOnly ? undefined : urgentFix ? (urgentFix.kind === "ready" ? "Work you marked Priority 1 has merged and is ready to put live" : "A deploy that carries the fix for a live problem") : mark ? `The CEO marked it urgent: ${mark.why}` : undefined;
        // BOS-1010: the runner update is routine. It stays in the feed and the browser, and never goes to the phone,
        // even under "All decisions". (A self_deploy card that is not the runner update is unchanged.)
        // BOS-1462: unless it carries a live fix that pages (urgentFix, not a repeat): then it pages like a server card.
        const routineRunner = c.type === "self_deploy" && c.target === "runner" && !(urgentFix && !urgentFix.repeat);
        await notify({ companyId: d.companyId, agentId: null, level, ...(urgentReason ? { urgentReason } : {}), title: d.tier === "ceo" ? `${company}: for the CEO` : urgentFix ? urgentFix.heading : `${company} needs a decision`, body: d.question, link: evidenceLink(c), decisionId: d.id, ...(routineRunner ? { noPush: true } : {}) });
      }
      return open.length;
    },

    async list(opts: { before?: Date; limit?: number; status?: "unread" | "read"; level?: NotifyLevel; company?: string; q?: string } = {}) {
      // The read path only reads (BOS-413): a settled card's notification was marked read when it settled.
      // Text search (BOS-2316): a case-insensitive ILIKE on title and body, run only over the rows the other filters and `before`
      // leave, newest first, stopping at the limit. % _ and \ in the text match as typed.
      const text = opts.q?.trim();
      const like = text ? `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
      const where = and(
        like ? or(sql`${notifications.title} ilike ${like}`, sql`${notifications.body} ilike ${like}`) : undefined,
        opts.before ? lt(notifications.createdAt, opts.before) : undefined,
        opts.status === "unread" ? isNull(notifications.readAt) : opts.status === "read" ? isNotNull(notifications.readAt) : undefined,
        opts.level ? eq(notifications.level, opts.level) : undefined,
        opts.company === "none" ? isNull(notifications.companyId) : opts.company ? eq(notifications.companyId, opts.company) : undefined,
      );
      return db
        .select({ n: notifications, company: companies.name })
        .from(notifications)
        .leftJoin(companies, eq(companies.id, notifications.companyId))
        .where(where)
        .orderBy(desc(notifications.createdAt))
        .limit(Math.min(opts.limit ?? 50, 200))
        .then((rows) => rows.map((r) => ({ ...r.n, company: r.company })));
    },

    async unread() {
      // The read path only reads (BOS-413): a settled card's notification was marked read when it settled.
      const [row] = await db.select({ n: count() }).from(notifications).where(isNull(notifications.readAt));
      return Number(row?.n ?? 0);
    },

    /** Unread notices by level and by company ("none" for no company), across everything (BOS-1277). */
    async unreadCounts() {
      const rows = await db
        .select({ level: notifications.level, companyId: notifications.companyId, n: count() })
        .from(notifications)
        .where(isNull(notifications.readAt))
        .groupBy(notifications.level, notifications.companyId);
      const level: Record<string, number> = {};
      const company: Record<string, number> = {};
      for (const r of rows) {
        const n = Number(r.n);
        level[r.level] = (level[r.level] ?? 0) + n;
        const key = r.companyId ?? "none";
        company[key] = (company[key] ?? 0) + n;
      }
      return { level, company };
    },

    /** A read never writes (BOS-413). This is the once-a-minute sweep that catches cards closed outside the decisions service. */
    markAnsweredRead: readAnswered,

    async markRead(ids: string[] | "all") {
      await db
        .update(notifications)
        .set({ readAt: now() })
        .where(ids === "all" ? isNull(notifications.readAt) : and(inArray(notifications.id, ids), isNull(notifications.readAt)));
    },

    /**
     * Sends a test push with the current settings. With a public https address it carries a "Got it" button: a
     * random one-use link (only its hash is kept, 15 minutes) whose tap proves the phone received the push.
     * Urgent (BOS-1006): it is what the owner pressed.
     */
    async test() {
      const s = await getSettings();
      const t = now();
      const actions: PushAction[] = [];
      let rec: PhoneTestRecord = { sentAt: t.toISOString(), tokenHash: null, expiresAt: null, confirmedAt: null, url: null };
      if (s.publicUrl && new URL(s.publicUrl).protocol === "https:") {
        const token = randomBytes(32).toString("base64url");
        const base = s.publicUrl.replace(/\/$/, "");
        rec = { ...rec, tokenHash: hashTestToken(token), expiresAt: new Date(t.getTime() + PHONE_TEST_TTL_MS).toISOString(), url: base };
        actions.push({ action: "http", label: "Got it", url: `${base}/api/phone/got-it`, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }), clear: true });
      }
      await push(s, { title: "Boss Man test", body: "Phone notifications from Boss Man reach this device." + (actions.length ? " Tap Got it to confirm." : ""), link: "#/notifications", level: "page", urgent: true, actions });
      await db.insert(settings).values({ key: PHONE_TEST_KEY, value: rec }).onConflictDoUpdate({ target: settings.key, set: { value: rec } });
    },

    /** The last test push: when it was sent, whether the phone tapped Got it (null: none sent yet), and the address the tap went to (null: not kept). */
    async testStatus(): Promise<{ sentAt: string; confirmedAt: string | null; url?: string | null } | null> {
      const [row] = await db.select().from(settings).where(eq(settings.key, PHONE_TEST_KEY));
      const r = row?.value as PhoneTestRecord | undefined;
      return r ? { sentAt: r.sentAt, confirmedAt: r.confirmedAt, url: r.url ?? null } : null;
    },

    /** A tap on Got it. True only for the live, unused link of the last test; the link then stops working. */
    async confirmTest(token: unknown): Promise<boolean> {
      if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
      const [row] = await db.select().from(settings).where(eq(settings.key, PHONE_TEST_KEY));
      const r = row?.value as PhoneTestRecord | undefined;
      const t = now();
      if (!r || !r.tokenHash || r.confirmedAt || !r.expiresAt || new Date(r.expiresAt) <= t || r.tokenHash !== hashTestToken(token)) return false;
      const next: PhoneTestRecord = { ...r, confirmedAt: t.toISOString() };
      // Compare-and-set on the unconfirmed record, so two taps can't both win.
      const res = await db.update(settings).set({ value: next }).where(and(eq(settings.key, PHONE_TEST_KEY), sql`${settings.value}->>'confirmedAt' is null`)).returning({ key: settings.key });
      return res.length > 0;
    },
  };
}
