// Owner notifications (R44). Everything the owner is told goes through here: decisions that
// need them, alerts, and agents' own notes. Each has a level (note, flag, page, ask); quiet
// hours and each agent's hourly cap lower it rather than drop it, and every one links to its
// evidence. Pages and asks also go to the owner's phone through their own ntfy server, so
// Boss Man only ever sends outbound requests and is never exposed at the router.
import { and, count, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { effectiveLevel, inQuietHours, NOTIFY_LEVELS, type NotifyLevel } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { companies, decisions, notifications, settings } from "../db/schema.js";
import type { DecisionContext } from "./decisions.js";

export const NotifySettings = z.object({
  quietHours: z
    .object({
      start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM"),
      end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM"),
      timeZone: z.string().refine((tz) => {
        try {
          new Intl.DateTimeFormat("en-GB", { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, "Use a time zone name such as Europe/London"),
    })
    .nullable(),
  /** Notifications per agent per hour before the rest become notes. */
  agentHourlyCap: z.number().int().min(1).max(100),
  /** Phone push through the owner's own ntfy server; the token is held as a secret. */
  ntfy: z.object({ url: z.string().url(), topic: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Letters, digits, - and _ only"), tokenSecretId: z.string().uuid().nullable() }).nullable(),
  /** Levels that go to the phone. */
  pushLevels: z.array(z.enum(NOTIFY_LEVELS)),
  /** Boss Man's address as the phone should open it, e.g. https://bossman.tailnet.ts.net. */
  publicUrl: z.string().url().nullable(),
});
export type NotifySettings = z.infer<typeof NotifySettings>;
export const DEFAULT_NOTIFY_SETTINGS: NotifySettings = { quietHours: null, agentHourlyCap: 6, ntfy: null, pushLevels: ["page", "ask"], publicUrl: null };

const KEY = "notifications";

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

  async function getSettings(): Promise<NotifySettings> {
    const [row] = await db.select().from(settings).where(eq(settings.key, KEY));
    return { ...DEFAULT_NOTIFY_SETTINGS, ...((row?.value as Partial<NotifySettings> | undefined) ?? {}) };
  }

  /** Publishes to ntfy as JSON (to the server's root URL), so titles needn't fit in a header. */
  async function push(s: NotifySettings, n: { title: string; body: string | null; link: string; level: NotifyLevel }) {
    if (!s.ntfy) throw new Error("Phone push isn't set up.");
    const token = s.ntfy.tokenSecretId ? await deps.reveal(s.ntfy.tokenSecretId) : null;
    const res = await doFetch(new URL("/", s.ntfy.url), {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({
        topic: s.ntfy.topic,
        title: fitBytes(n.title, 250),
        // ntfy turns a message over 4,096 bytes into an attachment.
        message: fitBytes(n.body ?? n.title, 3500),
        priority: PRIORITY[n.level],
        tags: [n.level === "ask" ? "question" : n.level === "page" ? "rotating_light" : "bell"],
        ...(s.publicUrl ? { click: `${s.publicUrl.replace(/\/$/, "")}/${n.link}` } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`ntfy answered ${res.status}`);
  }

  async function notify(input: NotifyInput) {
    const s = await getSettings();
    const t = now();
    let overCap = false;
    if (input.agentId) {
      const [row] = await db
        .select({ n: count() })
        .from(notifications)
        .where(and(eq(notifications.agentId, input.agentId), gt(notifications.createdAt, new Date(t.getTime() - 3_600_000)), sql`${notifications.level} <> 'note'`));
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
      try {
        await push(s, row);
        await db.update(notifications).set({ pushedAt: now() }).where(eq(notifications.id, row.id));
      } catch (err) {
        const msg = (err as Error).message;
        deps.log?.(`phone push failed: ${msg}`);
        await db.update(notifications).set({ pushError: msg.slice(0, 500) }).where(eq(notifications.id, row.id));
      }
    }
    return row;
  }

  return {
    getSettings,
    async setSettings(next: NotifySettings) {
      const value = NotifySettings.parse(next);
      await db.insert(settings).values({ key: KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return value;
    },

    notify,

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
        .where(and(eq(decisions.status, "open"), isNull(notifications.id), gt(decisions.createdAt, new Date(now().getTime() - 7 * 86_400_000))))
        .orderBy(decisions.createdAt)
        .limit(100);
      for (const { d, company } of open) {
        const options = d.options as string[];
        const alertOnly = options.length === 1 && options[0] === "Got it";
        const level: NotifyLevel = d.tier === "ceo" ? "note" : alertOnly ? "flag" : "ask";
        await notify({ companyId: d.companyId, agentId: null, level, title: d.tier === "ceo" ? `${company}: for the CEO` : `${company} needs a decision`, body: d.question, link: evidenceLink(d.context as DecisionContext), decisionId: d.id });
      }
      return open.length;
    },

    async list(opts: { before?: Date; limit?: number } = {}) {
      return db
        .select({ n: notifications, company: companies.name })
        .from(notifications)
        .leftJoin(companies, eq(companies.id, notifications.companyId))
        .where(opts.before ? lt(notifications.createdAt, opts.before) : undefined)
        .orderBy(desc(notifications.createdAt))
        .limit(Math.min(opts.limit ?? 50, 200))
        .then((rows) => rows.map((r) => ({ ...r.n, company: r.company })));
    },

    async unread() {
      const [row] = await db.select({ n: count() }).from(notifications).where(isNull(notifications.readAt));
      return Number(row?.n ?? 0);
    },

    async markRead(ids: string[] | "all") {
      await db
        .update(notifications)
        .set({ readAt: now() })
        .where(ids === "all" ? isNull(notifications.readAt) : and(inArray(notifications.id, ids), isNull(notifications.readAt)));
    },

    /** Sends a test push with the current settings and says how it went. */
    async test() {
      const s = await getSettings();
      await push(s, { title: "Boss Man test", body: "Phone notifications from Boss Man reach this device.", link: "#/notifications", level: "page" });
    },
  };
}
