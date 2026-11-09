// Phone Approve (BOS-243): an "Approve" button on a decision's phone push that answers a plain agent
// question with its recommended option, without a login. Every rule of the binding spec lives here:
// [[product/specs/bos-243-spec-phone-approve-buttons-rules-from-the-bos-240-reviews]] (rules 0-8).
//
// Approve is deliberately narrow. It needs the owner's private channel (rule 0), a card that passes a
// fail-closed allowlist (rule 1) and an agent-written one-line summary (rule 2). The link is a random
// token sent only in the POST body (rule 3); only its hash is stored, it lives 15 minutes, is used once,
// and pins the card's text with decision_rev (rule 5). A tap claims it, answers with the stored option
// and finishes or releases it (rule 6), and every tap on a real token gets a reply push (rule 4).
import { createHash, randomBytes } from "node:crypto";
import { and, count, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { approveTokens, decisions, owners, phoneActionHits, ticketDependencies } from "../db/schema.js";
import { record } from "./activity.js";
import { adviceOf, type Settled } from "./decisions.js";
import { appUrl, fitBytes, type NotifySettings, type PushAction } from "./notifications.js";

export const TOKEN_TTL_MS = 15 * 60_000;
/** A claim older than this is taken to have died with its request, so a re-tap may claim again. */
export const CLAIM_MS = 60_000;
export const LIVE_CAP = 10;
export const PUSH_EVERY_MS = 3_600_000;
export const IP_LIMIT = { taps: 10, ms: 10 * 60_000 };
export const COMPANY_LIMIT = { taps: 60, ms: 3_600_000 };
export const SUMMARY_MAX = 120;

/**
 * Context keys whose mere presence makes a card ineligible (rule 1). setsUp/clearWhen (BOS-522) mark
 * an add-on setup card: an owner to-do that closes itself, never a plain choice to approve blind.
 * plan (BOS-531) marks a submit_plan card: approving it signs off a ticket's plan ("never plans").
 * doAfter (BOS-551) says another owner card must be done first: a lock-screen tap would skip that order.
 * doBefore and resetsOnRestart only order other cards around this one, so they don't block Approve.
 */
export const RULE1_KEYS = ["steps", "ownerMustDo", "ticketId", "stillNeeded", "advice", "ladder", "setsUp", "clearWhen", "plan", "doAfter"] as const;

/**
 * Text as the phone shows it (rules 2 and N4): the stored text with control and format characters
 * (Unicode Cc/Cf: bidi overrides, zero-width marks) taken out. Line and paragraph breaks become a space
 * so words don't run together. Nothing else is rewritten (no NFKC), so the push says what the card says.
 */
export function plainText(s: string): string {
  return s.replace(/[\t\r\n\u0085\u2028\u2029]/g, " ").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "");
}

/** An approveSummary as stored: one cleaned line, or null when nothing is left of it. */
export function cleanSummary(s: string): string | null {
  const out = plainText(s).trim();
  return out ? out : null;
}

type Decision = typeof decisions.$inferSelect;
type Ctx = Record<string, unknown>;
const ctxOf = (d: Decision): Ctx => (d.context && typeof d.context === "object" && !Array.isArray(d.context) ? (d.context as Ctx) : {});
const summaryOf = (d: Decision) => {
  const s = ctxOf(d).approveSummary;
  return typeof s === "string" ? s : null;
};

/** Rule 0: the owner's private channel. A publish token, an https ntfy URL and an https public URL; and the owner hasn't switched it off. */
export function approveGate(s: NotifySettings, ntfyToken: string | null): { on: true } | { on: false; why: string } {
  if (s.approveButtons === false) return { on: false, why: "switched off" };
  if (!s.ntfy) return { on: false, why: "phone push isn't set up" };
  if (!ntfyToken?.trim()) return { on: false, why: "the ntfy server has no access token (a private server)" };
  if (!/^https:/i.test(s.ntfy.url) || new URL(s.ntfy.url).protocol !== "https:") return { on: false, why: "the ntfy address isn't https" };
  if (!s.publicUrl || new URL(s.publicUrl).protocol !== "https:") return { on: false, why: "Boss Man's public address isn't https" };
  return { on: true };
}

/**
 * Rule 1, a fail-closed allowlist: only an agent's own plain question, with no ticket, steps, to-do,
 * "still needed", advice or alert ladder, 2-4 options including the recommended one, and an
 * approveSummary. Anything else, including kinds and types added later, is not eligible. Two checks go
 * beyond the spec: it must be the owner's own card (not the CEO's or a plan approver's), and not marked
 * possibly out of date by something the owner did (BOS-123).
 */
export function phoneApprovable(d: Decision, isBlocker: boolean): boolean {
  const ctx = ctxOf(d);
  if (d.kind !== "question" || ctx.type !== "question") return false;
  if (RULE1_KEYS.some((k) => Object.hasOwn(ctx, k))) return false;
  if (isBlocker) return false;
  if (!d.raisedByAgentId) return false;
  const options = d.options;
  if (!Array.isArray(options) || options.length < 2 || options.length > 4 || !options.every((o) => typeof o === "string")) return false;
  if (!options.includes(d.recommendedOption)) return false;
  const summary = summaryOf(d);
  if (!summary || cleanSummary(summary) !== summary || summary.length > SUMMARY_MAX) return false;
  if (d.status !== "open" || d.tier !== "owner" || d.forAgentId || d.staleAt) return false;
  return true;
}

/** JSON with object keys sorted, so the same card always hashes the same however jsonb ordered it. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Ctx)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Rule 5's decision_rev: the hash of what the owner approves on, exactly the question, the options in
 * order, the recommended option, the approveSummary and the rule-1 fields (presence and value). Other
 * context (CEO notes, settled bookkeeping, triedFirst) may change while a link is live.
 */
export function decisionRev(d: Decision): string {
  const ctx = ctxOf(d);
  const fields = [d.question, d.options, d.recommendedOption, summaryOf(d), d.kind, ctx.type ?? null, d.raisedByAgentId, ...RULE1_KEYS.map((k) => [k, Object.hasOwn(ctx, k), ctx[k] ?? null])];
  return createHash("sha256").update(canonical(fields)).digest("hex");
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** The largest message a push carries (notifications.ts push() cuts the body to this many bytes). */
export const PUSH_BODY_MAX = 3500;

/**
 * The text of a push about this card (rules 2 and N4): the question, then what Approve does. The Approve
 * line is what the owner approves on, so it is never cut: when the two together are over the push limit
 * (a 1000-character question in 4-byte characters is 4000 bytes) the question is trimmed to make room
 * for it whole, so the owner can't tap a button without seeing the summary and option it sends (BOS-943).
 */
export function approveMessage(d: Decision): string {
  const approve = `Approve = ${plainText(summaryOf(d) ?? "")} ('${plainText(d.recommendedOption)}')`;
  const room = PUSH_BODY_MAX - new TextEncoder().encode(`\n\n${approve}`).length;
  return `${fitBytes(plainText(d.question).trim(), room)}\n\n${approve}`;
}

export type Outcome = "approved" | "already_answered" | "being_applied" | "try_again" | "no_longer_works" | "too_many_taps";
export type RedeemResult = { status: number; body: { ok: boolean; outcome?: Outcome; error?: string } };

export function phoneApproveService(
  db: Db,
  deps: {
    getSettings: () => Promise<NotifySettings>;
    reveal: (secretId: string) => Promise<string | null>;
    pushPlain: (n: { title: string; body: string; link: string; actions?: PushAction[] }) => Promise<boolean>;
    answer: (id: string, answer: string, extra: { by?: string }) => Promise<unknown>;
    now?: () => Date;
  },
) {
  const now = deps.now ?? (() => new Date());
  /** Unknown-token taps, counted rather than logged (rule 8). */
  let unknownTaps = 0;
  /** When each IP was last told "Too many taps", so a flood gets one reply per window. Leader memory only. */
  // shortcut: lost on restart, harmless because a restart costs at most one extra "Too many taps" push per IP;
  // entries older than the window are pruned on each write, so it stays small.
  const toldTooMany = new Map<string, number>();

  async function gate(s?: NotifySettings) {
    const settings = s ?? (await deps.getSettings());
    const token = settings.ntfy?.tokenSecretId ? await deps.reveal(settings.ntfy.tokenSecretId) : null;
    return { settings, gate: approveGate(settings, token) };
  }
  const isBlocker = async (decisionId: string) => (await db.select({ id: ticketDependencies.id }).from(ticketDependencies).where(eq(ticketDependencies.blockerDecisionId, decisionId)).limit(1)).length > 0;
  const loadDecision = async (id: string) => (await db.select().from(decisions).where(eq(decisions.id, id)))[0];

  /** Rule 7: under the live cap, and no link for this card (or its dedupe key) in the last hour. */
  async function underCaps(d: Decision, t: Date) {
    const [live] = await db
      .select({ n: count() })
      .from(approveTokens)
      .where(and(eq(approveTokens.companyId, d.companyId), isNull(approveTokens.usedAt), isNull(approveTokens.revokedAt), gt(approveTokens.expiresAt, t)));
    if (Number(live?.n ?? 0) >= LIVE_CAP) return false;
    const since = new Date(t.getTime() - PUSH_EVERY_MS);
    const [recent] = await db
      .select({ n: count() })
      .from(approveTokens)
      .innerJoin(decisions, eq(decisions.id, approveTokens.decisionId))
      .where(and(eq(approveTokens.companyId, d.companyId), gt(approveTokens.createdAt, since), d.dedupeKey ? or(eq(approveTokens.decisionId, d.id), eq(decisions.dedupeKey, d.dedupeKey)) : eq(approveTokens.decisionId, d.id)));
    return Number(recent?.n ?? 0) === 0;
  }

  /** Mints a link for a push that is about to go out. Null means Open only. The token exists only in the returned value. */
  async function mint(decisionId: string, s?: NotifySettings): Promise<{ token: string; tokenId: string; message: string } | null> {
    const { gate: g } = await gate(s);
    if (!g.on) return null;
    const d = await loadDecision(decisionId);
    if (!d || !phoneApprovable(d, await isBlocker(d.id))) return null;
    const t = now();
    if (!(await underCaps(d, t))) return null;
    const token = randomBytes(32).toString("base64url");
    const row = await db.transaction(async (tx) => {
      // An expired link nobody revoked still holds the one live slot in the partial index.
      await tx
        .update(approveTokens)
        .set({ revokedAt: t })
        .where(and(eq(approveTokens.decisionId, d.id), isNull(approveTokens.usedAt), isNull(approveTokens.revokedAt), lte(approveTokens.expiresAt, t)));
      const [r] = await tx
        .insert(approveTokens)
        .values({ companyId: d.companyId, decisionId: d.id, answer: d.recommendedOption, tokenHash: hashToken(token), decisionRev: decisionRev(d), createdAt: t, expiresAt: new Date(t.getTime() + TOKEN_TTL_MS) })
        .onConflictDoNothing()
        .returning({ id: approveTokens.id });
      return r;
    });
    if (!row) return null;
    return { token, tokenId: row.id, message: approveMessage(d) };
  }

  /** The hook notifications.ts asks while building a decision push. */
  async function forPush(decisionId: string, s: NotifySettings) {
    const m = await mint(decisionId, s);
    if (!m || !s.publicUrl) return null;
    const action: PushAction = {
      action: "http",
      label: "Approve",
      url: `${s.publicUrl.replace(/\/$/, "")}/api/phone/approve`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: m.token }),
      clear: true,
    };
    return { action, message: m.message, revoke: () => db.update(approveTokens).set({ revokedAt: now() }).where(and(eq(approveTokens.id, m.tokenId), isNull(approveTokens.usedAt))) };
  }

  /**
   * One tap's record for the rate limit, inserted only while the IP (and the company, when known) are
   * under their limits, in one statement, so a flood never grows the table (rule 8). False = limited.
   */
  async function hit(ip: string, companyId: string | null, t: Date) {
    const ipSince = new Date(t.getTime() - IP_LIMIT.ms).toISOString();
    const coSince = new Date(t.getTime() - COMPANY_LIMIT.ms).toISOString();
    const res = await db.execute(sql`
      insert into ${phoneActionHits} (ip, company_id, at)
      select ${ip}, ${companyId}::uuid, ${t.toISOString()}::timestamptz
      where (select count(*) from ${phoneActionHits} where ip = ${ip} and at > ${ipSince}::timestamptz) < ${IP_LIMIT.taps}
        and (${companyId}::uuid is null or (select count(*) from ${phoneActionHits} where company_id = ${companyId}::uuid and at > ${coSince}::timestamptz) < ${COMPANY_LIMIT.taps})
      returning id`);
    const rows = (res as unknown as { rows?: unknown[] }).rows ?? (res as unknown as unknown[]);
    return Array.isArray(rows) && rows.length > 0;
  }

  async function ownerName() {
    const [o] = await db.select({ username: owners.username }).from(owners).limit(1);
    return o?.username ?? "owner";
  }

  /** Who closed a card, for "Already answered ... by <who>". */
  function answeredBy(d: Decision) {
    const settled = ctxOf(d).settled as Settled | undefined;
    if (settled?.name) return plainText(settled.name);
    if (adviceOf(d.context)?.state === "handled") return "the CEO";
    return "you";
  }

  const say = (body: string, link: string, open = false) =>
    gate().then(({ settings }) =>
      deps.pushPlain({ title: "Boss Man", body: fitBytes(body, 1000), link, ...(open && settings.publicUrl ? { actions: [{ action: "view", label: "Open in Boss Man", url: appUrl(settings.publicUrl, link), clear: false } satisfies PushAction] } : {}) }),
    );
  const LINK = "#/decisions";
  const tell = {
    approved: (d: Decision, option: string) => say(`Approved: ${plainText(d.question).trim()}, answered '${plainText(option)}'`, LINK),
    answered: (d: Decision) => say(`Already answered: '${plainText(d.answer ?? "")}' by ${answeredBy(d)}`, LINK),
    applying: () => say("Already being applied; you'll get a notification in a moment", LINK),
    tryAgain: () => say("Couldn't apply it yet; tap Approve again, or open Boss Man", LINK, true),
    dead: () => say("That Approve link no longer works; open Boss Man", LINK, true),
    tooMany: () => say("Too many taps; wait a few minutes or open Boss Man", LINK, true),
  };
  // A real token's outcome answers 200 whatever it was: the reply push tells the owner, and an error
  // status would make the ntfy app show its own failure notice on top. Only the rate limit says 429.
  const reply = (status: number, outcome: Outcome): RedeemResult => ({ status, body: { ok: outcome === "approved", outcome } });
  const notFound = (): RedeemResult => ({ status: 404, body: { ok: false, error: "not_found" } });

  /** A tap (rules 4, 6, 8). Never logs, echoes or returns the token. */
  async function redeem(raw: unknown, ip: string): Promise<RedeemResult> {
    const t = now();
    if (typeof raw !== "string" || !TOKEN_SHAPE.test(raw)) return notFound();
    const hash = hashToken(raw);
    const [tok] = await db.select().from(approveTokens).where(eq(approveTokens.tokenHash, hash));
    if (!tok) {
      unknownTaps++;
      await hit(ip, null, t);
      return notFound();
    }
    const live = () => !tok.usedAt && !tok.revokedAt && tok.expiresAt > t;
    if (!(await hit(ip, tok.companyId, t))) {
      // Over a limit, a live link still hears why nothing happened, once per IP per window.
      if (live() && (toldTooMany.get(ip) ?? 0) <= t.getTime() - IP_LIMIT.ms) {
        for (const [k, at] of toldTooMany) if (at <= t.getTime() - IP_LIMIT.ms) toldTooMany.delete(k);
        toldTooMany.set(ip, t.getTime());
        await tell.tooMany();
      }
      return reply(429, "too_many_taps");
    }

    // Rule 6: claim it. A claim older than CLAIM_MS died with its request and may be taken again.
    const [claimed] = await db
      .update(approveTokens)
      .set({ claimedAt: t })
      .where(
        and(
          eq(approveTokens.tokenHash, hash),
          isNull(approveTokens.usedAt),
          isNull(approveTokens.revokedAt),
          gt(approveTokens.expiresAt, t),
          or(isNull(approveTokens.claimedAt), lt(approveTokens.claimedAt, new Date(t.getTime() - CLAIM_MS))),
        ),
      )
      .returning();
    if (!claimed) {
      const [now2] = await db.select().from(approveTokens).where(eq(approveTokens.id, tok.id));
      const d = await loadDecision(tok.decisionId);
      if (d?.status === "answered") {
        await tell.answered(d);
        return reply(200, "already_answered");
      }
      if (now2 && !now2.usedAt && !now2.revokedAt && now2.expiresAt > t && now2.claimedAt) {
        await tell.applying();
        return reply(200, "being_applied");
      }
      await tell.dead();
      return reply(200, "no_longer_works");
    }

    const release = () => db.update(approveTokens).set({ claimedAt: null }).where(and(eq(approveTokens.id, tok.id), isNull(approveTokens.usedAt)));
    const revoke = () => db.update(approveTokens).set({ revokedAt: now(), claimedAt: null }).where(and(eq(approveTokens.id, tok.id), isNull(approveTokens.usedAt)));

    // Re-check everything the mint checked: the channel, the allowlist and the card's text.
    const d = await loadDecision(tok.decisionId);
    if (d?.status === "answered") {
      await revoke();
      await tell.answered(d);
      return reply(200, "already_answered");
    }
    const { gate: g } = await gate();
    if (!d || !g.on || !phoneApprovable(d, await isBlocker(d.id)) || decisionRev(d) !== tok.decisionRev || d.recommendedOption !== tok.answer) {
      await revoke();
      await tell.dead();
      return reply(200, "no_longer_works");
    }

    // Only ever the option stored on the link, never a custom answer (rule 1).
    let result: unknown = null;
    try {
      result = await deps.answer(d.id, tok.answer, { by: await ownerName() });
    } catch {
      result = null;
    }
    if (result) {
      await db.update(approveTokens).set({ usedAt: now() }).where(eq(approveTokens.id, tok.id));
      await record(db, { companyId: d.companyId, kind: "decision_phone_approved", summary: `Approved from phone: "${plainText(d.question)}", answered "${tok.answer}"`, at: now() });
      await tell.approved(d, tok.answer);
      return reply(200, "approved");
    }
    await release();
    const after = await loadDecision(d.id);
    if (after?.status === "answered") {
      await tell.answered(after);
      return reply(200, "already_answered");
    }
    await tell.tryAgain();
    return reply(200, "try_again");
  }

  return { mint, forPush, redeem, unknownTaps: () => unknownTaps, gate };
}

export type PhoneApprove = ReturnType<typeof phoneApproveService>;
