// Owner notifications (R44). Everything the owner is told goes through here: decisions that
// need them, alerts, and agents' own notes. Each has a level (note, flag, page, ask); quiet
// hours and each agent's hourly cap lower it rather than drop it, and every one links to its
// evidence. Pages and asks also go to the owner's phone through their own ntfy server, so
// Boss Man only ever sends outbound requests and is never exposed at the router.
import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { effectiveLevel, inQuietHours, isTimeZone, NOTIFY_LEVELS, sinceHours, type NotifyLevel } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, notifications, settings } from "../db/schema.js";
import type { DecisionContext } from "./decisions.js";

/**
 * The ntfy server's address. Pushes go to it with its path kept (BOS-243 rule 8), so one served under
 * a path such as https://host/ntfy works; a query or # part would be dropped silently, so it is refused.
 */
export const NtfyUrl = z
  .string()
  .url()
  .refine((u) => {
    const p = new URL(u);
    return !p.search && !p.hash && !u.includes("?") && !u.includes("#");
  }, "Use the ntfy server's address without a ? or # part, e.g. https://ntfy.example.ts.net or https://host/ntfy");

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
  ntfy: z.object({ url: NtfyUrl, topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Letters, digits, - and _ only"), tokenSecretId: z.string().uuid().nullable() }).nullable(),
  /** Levels that go to the phone. */
  pushLevels: z.array(z.enum(NOTIFY_LEVELS)),
  /** Boss Man's address as the phone should open it, e.g. https://bossman.tailnet.ts.net. */
  publicUrl: z.string().url().nullable(),
  /** The owner's off switch for phone Approve buttons (BOS-243); on unless set to false. */
  approveButtons: z.boolean().optional(),
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
export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { quietHours: null, agentHourlyCap: 6, ntfy: null, pushLevels: ["page", "ask"], publicUrl: null };

const KEY = "notifications";
const PHONE_TEST_KEY = "notifications.phone-test";
const PHONE_TEST_TTL_MS = 15 * 60_000;
type PhoneTestRecord = { sentAt: string; tokenHash: string | null; expiresAt: string | null; confirmedAt: string | null };
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
const PRIORITY: Record<NotifyLevel, number> = { note: 2, flag: 3, page: 4, ask: 4 };

export type NotifyInput = { companyId: string | null; agentId?: string | null; level: NotifyLevel; title: string; body?: string | null; link: string; decisionId?: string | null };

export function notificationsService(db: Db, deps: { reveal: (secretId: string) => Promise<string | null>; fetch?: typeof fetch; now?: () => Date; log?: (msg: string) => void }) {
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? fetch;
  let approveHook: ApproveHook | null = null;

  async function getSettings(): Promise<NotifySettings> {
    const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
    return { ...DEFAULT_NOTIFY_SETTINGS, ...((row?.value as Partial<NotifySettings> | undefined) ?? {}) };
  }

  /**
   * Publishes to ntfy as JSON (to the server's URL, path kept), so titles needn't fit in a header.
   * `plain` turns markdown off, for text that is shown exactly as stored (BOS-243).
   */
  async function push(s: NotifySettings, n: { title: string; body: string | null; link: string; level: NotifyLevel; actions?: PushAction[]; plain?: boolean }) {
    if (!s.ntfy) throw new Error("Phone push isn't set up.");
    const token = s.ntfy.tokenSecretId ? await deps.reveal(s.ntfy.tokenSecretId) : null;
    const res = await doFetch(ntfyPublishUrl(s.ntfy.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        topic: s.ntfy.topic,
        title: fitBytes(n.title, 250),
        // ntfy turns a message over 4,096 bytes into an attachment.
        message: fitBytes(n.body ?? n.title, 3500),
        priority: PRIORITY[n.level],
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
    if (s.ntfy && s.pushLevels.includes(level)) {
      const { actions, approve } = row.decisionId ? await decisionButtons(s, row.decisionId, row.link) : { actions: [], approve: null };
      try {
        await push(s, { ...row, actions, ...(approve ? { body: approve.message, plain: true } : {}) });
        await db.update(notifications).set({ pushedAt: now() }).where(eq(notifications.id, row.id));
      } catch (err) {
        const msg = (err as Error).message;
        // A link the phone never received must not stay live.
        await approve?.revoke().catch(() => undefined);
        deps.log?.(`phone push failed: ${msg}`);
        await db.update(notifications).set({ pushError: msg.slice(0, 500) }).where(eq(notifications.id, row.id));
      }
    }
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

  return {
    getSettings,
    async setSettings(next: NotifySettings) {
      const value = NotifySettings.parse(next);
      await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return value;
    },

    notify,

    setApproveHook(hook: ApproveHook) {
      approveHook = hook;
    },

    /**
     * A push with no notification row (the table holds one per decision): the phone Approve outcome
     * replies (BOS-243). Plain text, sent whatever the push levels, since the owner has just tapped.
     */
    async pushPlain(n: { title: string; body: string; link: string; actions?: PushAction[] }) {
      const s = await getSettings();
      if (!s.ntfy) return false;
      try {
        await push(s, { ...n, level: "flag", plain: true });
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
        const urgent = c.type === "self_deploy" && d.tier !== "ceo" ? c.urgent : undefined;
        const level: NotifyLevel = d.tier === "ceo" ? "note" : urgent && !urgent.repeat ? "page" : alertOnly ? "flag" : "ask";
        await notify({ companyId: d.companyId, agentId: null, level, title: d.tier === "ceo" ? `${company}: for the CEO` : urgent ? urgent.heading : `${company} needs a decision`, body: d.question, link: evidenceLink(c), decisionId: d.id });
      }
      return open.length;
    },

    async list(opts: { before?: Date; limit?: number; status?: "unread" | "read"; level?: NotifyLevel; company?: string } = {}) {
      // The read path only reads (BOS-413): a settled card's notification was marked read when it settled.
      const where = and(
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
     */
    async test() {
      const s = await getSettings();
      const t = now();
      const actions: PushAction[] = [];
      let rec: PhoneTestRecord = { sentAt: t.toISOString(), tokenHash: null, expiresAt: null, confirmedAt: null };
      if (s.publicUrl && new URL(s.publicUrl).protocol === "https:") {
        const token = randomBytes(32).toString("base64url");
        rec = { ...rec, tokenHash: hashTestToken(token), expiresAt: new Date(t.getTime() + PHONE_TEST_TTL_MS).toISOString() };
        actions.push({ action: "http", label: "Got it", url: `${s.publicUrl.replace(/\/$/, "")}/api/phone/got-it`, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }), clear: true });
      }
      await push(s, { title: "Boss Man test", body: "Phone notifications from Boss Man reach this device." + (actions.length ? " Tap Got it to confirm." : ""), link: "#/notifications", level: "page", actions });
      await db.insert(settings).values({ key: PHONE_TEST_KEY, value: rec }).onConflictDoUpdate({ target: settings.key, set: { value: rec } });
    },

    /** The last test push: when it was sent and whether the phone tapped Got it (null: none sent yet). */
    async testStatus(): Promise<{ sentAt: string; confirmedAt: string | null } | null> {
      const [row] = await db.select().from(settings).where(eq(settings.key, PHONE_TEST_KEY));
      const r = row?.value as PhoneTestRecord | undefined;
      return r ? { sentAt: r.sentAt, confirmedAt: r.confirmedAt } : null;
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
