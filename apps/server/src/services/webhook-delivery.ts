// Alerts to Slack, Discord or any webhook (BOS-2199). The owner adds a destination on the Notifications page;
// each alert of a kind it ticked is sent after the alert is saved, never before and never awaited by it. The
// address is a secret: it lives in the secrets store, and nothing here logs it, puts it in an error note or
// returns it to the page. A failed send is tried once more a minute later (durable, so a restart keeps it), then
// shows on the destination as the HTTP status or a short reason. Three days of failures switch it off.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, asc, eq, lte } from "drizzle-orm";
import { isPrivateAddress } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { alertDestinations, alertRetries } from "../db/schema.js";
import { appUrl } from "./notifications.js";

export const ALERT_KINDS = ["decision_waiting", "merge_stuck", "spend_alert", "run_failed", "daily_summary"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];
/** What is ticked when the owner adds a destination. */
export const DEFAULT_ALERT_KINDS: AlertKind[] = ["decision_waiting", "merge_stuck"];
export const DESTINATION_TYPES = ["slack", "discord", "webhook"] as const;
export type DestinationType = (typeof DESTINATION_TYPES)[number];

export const SEND_TIMEOUT_MS = 5_000;
export const RETRY_AFTER_MS = 60_000;
export const SWITCH_OFF_AFTER_MS = 3 * 86_400_000;

/** What goes out: a plain webhook gets this as JSON; Slack and Discord get it as one message. */
export type AlertPayload = { kind: AlertKind | "test"; title: string; text: string; url: string | null; at: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The request body for each destination type. Slack: title in bold, one line, a link. Discord: the same in its markup. */
export function formatBody(type: DestinationType, p: AlertPayload): unknown {
  const one = clip(p.text.replace(/\s+/g, " ").trim(), 300);
  if (type === "slack") return { text: [`*${slackEscape(clip(p.title, 150))}*`, slackEscape(one), ...(p.url ? [`<${p.url}|Open in Boss Man>`] : [])].filter(Boolean).join("\n") };
  if (type === "discord") return { content: clip([`**${clip(p.title, 150).replace(/[*_`~|>]/g, "")}**`, one,...(p.url ? [`<${p.url}>`] : [])].filter(Boolean).join("\n"), 1900), allowed_mentions: { parse: [] } };
  return { kind: p.kind, title: p.title, text: p.text, url: p.url, at: p.at };
}

/**
 * Why an address can't be used, or null. https only, and no private, loopback or link-local address unless the owner
 * ticked "this is on my own network" (the same rule skill links and the permission check follow). Never echoes the address.
 */
export async function addressProblem(raw: string, allowPrivate: boolean, lookup: (host: string) => Promise<string[]>): Promise<string | null> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "That isn't a web address.";
  }
  if (u.protocol !== "https:") return "The address must start with https://.";
  if (u.username || u.password) return "Leave the user name and password out of the address.";
  if (allowPrivate) return null;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  let addrs: string[];
  try {
    addrs = isIP(h) ? [h] : await lookup(h);
  } catch {
    return "Boss Man couldn't find that address on the internet.";
  }
  if (!addrs.length || addrs.some(isPrivateAddress)) return "That address is on a private or local network. Tick \"this is on my own network\" if that is on purpose.";
  return null;
}

const realLookup = async (host: string) => (await dnsLookup(host, { all: true })).map((a) => a.address);

type Destination = typeof alertDestinations.$inferSelect;
export type SendResult = { ok: true } | { ok: false; note: string; status?: number };

export function webhookDeliveryService(
  db: Db,
  deps: {
    reveal: (secretId: string) => Promise<string | null>;
    /** Tells the owner once in Boss Man when a destination is switched off. */
    notifyOwner?: (n: { title: string; body: string }) => Promise<unknown>;
    fetch?: typeof fetch;
    lookup?: (host: string) => Promise<string[]>;
    now?: () => Date;
    /** Fixed lines only: never the address, never a response body. */
    log?: (msg: string) => void;
  },
) {
  const now = deps.now ?? (() => new Date());
  const doFetch = deps.fetch ?? fetch;
  const lookup = deps.lookup ?? realLookup;

  /** One attempt. The note is a status code or a short reason, never the address or anything the other side said. */
  async function attempt(d: Destination, payload: AlertPayload): Promise<SendResult> {
    const address = d.secretId ? await deps.reveal(d.secretId) : null;
    if (!address) return { ok: false, note: "the address is missing" };
    const problem = await addressProblem(address, d.allowPrivate, lookup);
    if (problem) return { ok: false, note: problem.startsWith("The address must") ? "the address isn't https" : "the address is on a private network" };
    try {
      const res = await doFetch(address, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "Boss-Man" },
        body: JSON.stringify(formatBody(d.type as DestinationType, payload)),
        // A redirect would leave the address that was checked.
        redirect: "manual",
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true };
      return { ok: false, status: res.status, note: String(res.status) };
    } catch (err) {
      const name = (err as { name?: string }).name;
      return { ok: false, note: name === "TimeoutError" || name === "AbortError" ? `timed out after ${SEND_TIMEOUT_MS / 1000} s` : "could not connect" };
    }
  }

  async function recordSuccess(d: Destination) {
    if (d.failingSince || d.lastFailureNote) await db.update(alertDestinations).set({ failingSince: null, lastFailureNote: null, lastFailedAt: null }).where(eq(alertDestinations.id, d.id));
  }

  async function recordFailure(d: Destination, note: string) {
    const t = now();
    const since = d.failingSince ?? t;
    const off = t.getTime() - since.getTime() >= SWITCH_OFF_AFTER_MS;
    await db.update(alertDestinations).set({ lastFailureNote: note.slice(0, 200), lastFailedAt: t, failingSince: since, ...(off ? { enabled: false } : {}) }).where(eq(alertDestinations.id, d.id));
    if (off && d.enabled) {
      deps.log?.(`alert destination ${d.id} switched off after 3 days of failures`);
      await deps.notifyOwner?.({ title: `Alerts to "${d.name}" switched off`, body: `Boss Man couldn't reach "${d.name}" for 3 days (last answer: ${note}). Open the Notifications page, check the address, then switch it back on.` }).catch(() => undefined);
    }
  }

  async function sendOne(d: Destination, payload: AlertPayload, canRetry: boolean) {
    const r = await attempt(d, payload);
    if (r.ok) return recordSuccess(d);
    await recordFailure(d, r.note);
    if (canRetry) await db.insert(alertRetries).values({ destinationId: d.id, payload, dueAt: new Date(now().getTime() + RETRY_AFTER_MS) });
  }

  return {
    /** Why this address can't be saved, or null (see addressProblem). */
    problem: (address: string, allowPrivate: boolean) => addressProblem(address, allowPrivate, lookup),

    /**
     * Called after a notification is saved (and pushed to the phone). Returns at once; each send runs on its own and
     * can never fail the caller. Only destinations that are on and ticked for this kind get it.
     */
    onAlert(alert: { kind: AlertKind; title: string; text: string; link: string; publicUrl: string | null }): void {
      void (async () => {
        const payload: AlertPayload = { kind: alert.kind, title: alert.title, text: alert.text, url: alert.publicUrl ? appUrl(alert.publicUrl, alert.link) : null, at: now().toISOString() };
        const dests = await db.select().from(alertDestinations).where(eq(alertDestinations.enabled, true));
        await Promise.all(dests.filter((d) => d.kinds.includes(alert.kind)).map((d) => sendOne(d, payload, true).catch(() => deps.log?.(`alert destination ${d.id}: send failed inside the server`))));
      })().catch(() => deps.log?.("alert delivery failed inside the server"));
    },

    /** "Send a test message": answers with success or the HTTP status. Changes no failure count. */
    async test(id: string, publicUrl: string | null): Promise<{ ok: boolean; status?: number; message: string } | null> {
      const [d] = await db.select().from(alertDestinations).where(eq(alertDestinations.id, id));
      if (!d) return null;
      const r = await attempt(d, { kind: "test", title: "Boss Man test", text: "Alerts from Boss Man reach this place.", url: publicUrl ? appUrl(publicUrl, "#/notifications") : null, at: now().toISOString() });
      return r.ok ? { ok: true, message: "Sent. Check the channel." } : { ok: false, ...(r.status ? { status: r.status } : {}), message: r.status ? `The other side answered ${r.status}.` : `Not sent: ${r.note}.` };
    },

    /** The retries that are due, once each. Run by the once-a-minute sweep. */
    async sweepRetries(): Promise<number> {
      const due = await db.select().from(alertRetries).where(lte(alertRetries.dueAt, now())).orderBy(asc(alertRetries.dueAt)).limit(50);
      for (const r of due) {
        await db.delete(alertRetries).where(eq(alertRetries.id, r.id));
        const [d] = await db.select().from(alertDestinations).where(and(eq(alertDestinations.id, r.destinationId), eq(alertDestinations.enabled, true)));
        if (d) await sendOne(d, r.payload as AlertPayload, false).catch(() => deps.log?.(`alert destination ${d.id}: retry failed inside the server`));
      }
      return due.length;
    },
  };
}
