// The feedback portal: the only part of Boss Man meant for people other than the owner. It is
// reached by a secret link (portal.html#<token>); the token stays after the "#", so browsers
// never send it in a URL, and the page passes it to this API in a header, which keeps it out
// of logs and Referer headers. Visitors can see the features the owner chose to show, vote on
// them with how much they matter, comment, and suggest ideas. Everything they send is stored
// as untrusted feedback. Writes are rate limited per visitor address and per portal.
//
// BOSSMAN_PORTAL_PORT starts a second listener that serves only the portal page and this API,
// so the portal can be exposed without exposing the owner's login or API.
import { randomBytes } from "node:crypto";
import path from "node:path";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { assetPathOf, IMPORTANCE, PRECOMPRESSED_SUFFIX_LIST } from "@boss-man/shared";
import { parseClientHeader, parseTrustedProxies, portalClientAddress } from "./portal-ip.js";
import { confirmationEmail, confirmLink, type ConfirmKind, type PortalMailer } from "./portal-emails.js";
import { emailHash, FeedbackError, type feedbackService } from "./services/feedback.js";

export const PORTAL_CSP = "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const VOTER_COOKIE = "bm_portal_voter";
/** BOS-1388: "this browser confirmed this address": `<address, base64url>.<secret>`. The secret is checked against a stored hash. */
const CONFIRMED_COOKIE = "bm_portal_confirmed";

export type PortalLimits = {
  writesPerIpPerHour: number;
  writesPerPortalPerHour: number;
  readsPerIpPerMinute: number;
  /** BOS-1388, per email address, so the form can't be used to fill someone's inbox or flood the owner's. */
  confirmEmailsPerEmailPerHour: number;
  ideasPerEmailPerDay: number;
  votesAndCommentsPerEmailPerHour: number;
};
export const DEFAULT_PORTAL_LIMITS: PortalLimits = { writesPerIpPerHour: 40, writesPerPortalPerHour: 600, readsPerIpPerMinute: 120, confirmEmailsPerEmailPerHour: 3, ideasPerEmailPerDay: 10, votesAndCommentsPerEmailPerHour: 5 };

/** A sliding-window counter per key, bounded in memory. */
export const WINDOW_COUNTER_MAX_KEYS = 20_000;
export function windowCounter(now: () => number, maxKeys = WINDOW_COUNTER_MAX_KEYS) {
  // shortcut: rate-limit counters in memory; lost on restart, harmless because it only forgets recent hits.
  const hits = new Map<string, number[]>();
  return {
    /** How many keys it holds; never more than WINDOW_COUNTER_MAX_KEYS. */
    get size() {
      return hits.size;
    },
    /** Records a hit and says whether it was within the limit. */
    take(key: string, limit: number, windowMs: number) {
      const cutoff = now() - windowMs;
      const list = (hits.get(key) ?? []).filter((t) => t > cutoff);
      if (list.length >= limit) {
        hits.set(key, list);
        return false;
      }
      list.push(now());
      hits.set(key, list);
      if (hits.size > maxKeys) hits.delete(hits.keys().next().value!);
      return true;
    },
  };
}

/** The logo's bytes as an inline image the browser may not reinterpret. */
export function sendLogo(reply: FastifyReply, logo: { bytes: Buffer; type: string }) {
  return reply.type(logo.type).header("x-content-type-options", "nosniff").header("content-disposition", "inline").header("cache-control", "private, no-cache").send(logo.bytes);
}

const xmlEscape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

type Feedback =ReturnType<typeof feedbackService>;

export async function portalRoutes(app: FastifyInstance, deps: { feedback: Feedback; secureCookies: boolean | "auto"; limits?: Partial<PortalLimits>; now?: () => number; counterMaxKeys?: number; clientAddress?: (req: FastifyRequest) => string; mailer?: PortalMailer; portalUrl?: string }) {
  const limits = { ...DEFAULT_PORTAL_LIMITS, ...deps.limits };
  /** The address the per-visitor limits count against (the proxy-aware one when the portal listener sets it). */
  const addressOf = (req: FastifyRequest) => (deps.clientAddress ? deps.clientAddress(req) : req.ip);
  // `counterMaxKeys` (BOS-1926) is for tests: a small bound shows the eviction in a few requests instead of 20,001.
  const counter = windowCounter(deps.now ?? (() => Date.now()), deps.counterMaxKeys);
  // BOS-1407: the per-portal caps live apart from the per-address ones. In one shared Map a flood of
  // reads from new addresses evicted the oldest key, usually `portal:<id>`, and reset the portal's
  // write cap. Portal keys are only made after the token checks out, so this Map holds one key per
  // live portal and its 20,000 bound is never reached.
  const portalCounter = windowCounter(deps.now ?? (() => Date.now()));
  // BOS-1388: per-address counters, kept apart so a flood of other keys can't evict one (the same reason as above).
  const emailCounter = windowCounter(deps.now ?? (() => Date.now()));
  const Text = (max: number) => z.string().trim().min(1).max(max);
  const Who = { name: z.string().trim().max(100).nullable().optional(), email: z.string().trim().email().max(320).nullable().optional().or(z.literal("")) };

  /** The portal from the request's header, or a 404 that looks the same whatever was wrong. */
  async function portalOf(req: FastifyRequest, reply: FastifyReply) {
    const token = req.headers["x-portal-token"];
    // BOS-1680: no link secret at all means the bare public address; it opens the portal the owner chose for it, if any.
    // A wrong secret is still refused, so a guess never falls back to the shared portal.
    const p = token === undefined || token === "" ? await deps.feedback.bareAddressPortal() : typeof token === "string" ? await deps.feedback.portalFor(token) : null;
    if (!p) {
      reply.code(404).send({ error: "not_found", message: "This portal link doesn't work. Ask for a new one." });
      return null;
    }
    return p;
  }
  function voterOf(req: FastifyRequest, reply: FastifyReply) {
    const existing = req.cookies[VOTER_COOKIE];
    if (existing && /^[A-Za-z0-9_-]{22}$/.test(existing)) return existing;
    const voter = randomBytes(16).toString("base64url");
    reply.setCookie(VOTER_COOKIE, voter, { path: "/api/portal", httpOnly: true, sameSite: "strict", secure: deps.secureCookies === "auto" ? req.protocol === "https" : deps.secureCookies, maxAge: 365 * 86_400 });
    return voter;
  }
  function allowWrite(req: FastifyRequest, reply: FastifyReply, companyId: string) {
    if (counter.take(`ip:${addressOf(req)}`, limits.writesPerIpPerHour, 3_600_000) && portalCounter.take(`portal:${companyId}`, limits.writesPerPortalPerHour, 3_600_000)) return true;
    reply.code(429).send({ error: "too_many", message: "That's a lot of feedback in a short time. Please try again later." });
    return false;
  }
  const cookieSecure = (req: FastifyRequest) => (deps.secureCookies === "auto" ? req.protocol === "https" : deps.secureCookies);
  /** The address and secret the browser's confirmed-address cookie claims, or null; nothing about it is trusted yet. */
  function confirmedCookie(req: FastifyRequest) {
    const raw = req.cookies[CONFIRMED_COOKIE];
    const m = typeof raw === "string" ? /^([A-Za-z0-9_-]{4,430})\.([A-Za-z0-9_-]{43})$/.exec(raw) : null;
    if (!m) return null;
    const email = Buffer.from(m[1]!, "base64url").toString("utf8");
    return /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 320 ? { email, secret: m[2]! } : null;
  }
  /** Whether this browser has confirmed `email` here: the cookie names it AND its secret is one the server issued and still holds. */
  async function rememberedFor(req: FastifyRequest, companyId: string, email: string) {
    const c = confirmedCookie(req);
    return !!c && c.email.toLowerCase() === email.trim().toLowerCase() && (await deps.feedback.addressRemembered(companyId, c.email, c.secret));
  }
  async function rememberedAddress(req: FastifyRequest, companyId: string) {
    const c = confirmedCookie(req);
    return c && (await deps.feedback.addressRemembered(companyId, c.email, c.secret)) ? c.email : null;
  }
  /**
   * With "Confirm posts by email" on: the address is required, and unless this browser already confirmed it the post is saved hidden
   * and an email goes out. Past a per-address cap nothing is saved or sent but the answer is the same, so the form can't be used to
   * find out which addresses are being mailed. Returns what to do: "now" (post as usual), "pending" (save hidden, with this
   * confirm), or "quiet" (answer as if sent). Throws FeedbackError when the portal can't take posts or the address is missing.
   */
  async function confirmMode(req: FastifyRequest, p: { companyId: string; confirmByEmail: boolean; confirmLinkHours: number }, email: string | null | undefined, kind: ConfirmKind) {
    if (!p.confirmByEmail) return { mode: "now" as const };
    if (!email) throw new FeedbackError(422, "Please enter your email address: we send a link to confirm it.");
    if (!deps.mailer || !deps.portalUrl || !(await deps.mailer.isConfigured())) throw new FeedbackError(503, "This page can't take feedback right now. Please try again later.");
    const h = emailHash(email);
    const known = await rememberedFor(req, p.companyId, email);
    const act = kind === "idea" ? emailCounter.take(`idea:${p.companyId}:${h}`, limits.ideasPerEmailPerDay, 86_400_000) : emailCounter.take(`act:${p.companyId}:${h}`, limits.votesAndCommentsPerEmailPerHour, 3_600_000);
    // A browser that proved the address may be told it is posting too much; anyone else gets the usual answer and nothing is sent.
    if (known) {
      if (!act) throw new FeedbackError(429, "That's a lot from one address. Please try again later.");
      return { mode: "now" as const };
    }
    if (!act || !emailCounter.take(`mail:${p.companyId}:${h}`, limits.confirmEmailsPerEmailPerHour, 3_600_000)) return { mode: "quiet" as const };
    return { mode: "pending" as const, confirm: { email, hours: p.confirmLinkHours } };
  }
  async function sendConfirmation(p: { company: string; title: string | null }, email: string, kind: ConfirmKind, about: string, token: string, hours: number) {
    try {
      await deps.mailer!.send(confirmationEmail({ to: email, kind, portalTitle: p.title ?? p.company, about, link: confirmLink(deps.portalUrl!, token), hours }));
    } catch {
      // The address and the error stay out of the log; the post stays hidden and is deleted when its link expires.
    }
  }
  const errors = (reply: FastifyReply) => (err: unknown) => {
    if (err instanceof FeedbackError) return reply.code(err.status).send({ error: "rejected", message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid_request", message: "Some of that didn't look right; check the fields and try again." });
    throw err;
  };

  app.get("/api/portal", async (req, reply) => {
    if (!counter.take(`read:${addressOf(req)}`, limits.readsPerIpPerMinute, 60_000)) return reply.code(429).send({ error: "too_many", message: "Please slow down a little." });
    const p = await portalOf(req, reply);
    if (!p) return;
    const voter = voterOf(req, reply);
    reply.header("cache-control", "no-store");
    // BOS-967: the optional "← Back to …" links. The address was checked to be https when it was saved;
    // only an https one is ever sent, so a stored value can't point a visitor at javascript: or http.
    const backUrl = p.backUrl && /^https:\/\//i.test(p.backUrl) ? p.backUrl : null;
    const title = p.title ?? `${p.company}: what's next`;
    return {
      title,
      intro: p.intro,
      hasLogo: p.hasLogo,
      // BOS-1388: whether posts need an email, and (only to the browser that holds it) the address it confirmed.
      confirmByEmail: p.confirmByEmail,
      rememberedEmail: p.confirmByEmail ? await rememberedAddress(req, p.companyId) : null,
      back: backUrl ? { url: backUrl, text: p.backText?.trim() || title } : null,
      features: await deps.feedback.portalView(p.companyId, voter),
    };
  });

  // The Atom feed of new releases. A feed reader can't send the link secret header, so this answers for the portal at the
  // bare public address only (the same one `GET /api/portal` shows with no secret); any other request gets the usual 404.
  app.get("/api/portal/feed.atom", async (req, reply) => {
    if (!counter.take(`read:${addressOf(req)}`, limits.readsPerIpPerMinute, 60_000)) return reply.code(429).send({ error: "too_many", message: "Please slow down a little." });
    const p = await portalOf(req, reply);
    if (!p) return;
    reply.header("cache-control", "no-store");
    const title = p.title ?? `${p.company}: what's next`;
    const base = (deps.portalUrl ?? `${req.protocol}://${req.headers.host ?? "localhost"}`).replace(/\/+$/, "");
    const entries = await deps.feedback.portalFeed(p.companyId);
    const home = `${base}/portal.html`;
    const xml = [
      `<?xml version="1.0" encoding="utf-8"?>`,
      `<feed xmlns="http://www.w3.org/2005/Atom">`,
      `<title>${xmlEscape(`${title}: what's new`)}</title>`,
      `<id>urn:uuid:${p.companyId}</id>`,
      `<updated>${(entries[0]?.releasedAt ?? new Date(0)).toISOString()}</updated>`,
      `<link rel="self" type="application/atom+xml" href="${xmlEscape(`${base}/api/portal/feed.atom`)}"/>`,
      `<link rel="alternate" type="text/html" href="${xmlEscape(home)}"/>`,
      ...entries.map((e) => `<entry><title>${xmlEscape(e.title)}</title><id>urn:uuid:${e.id}</id><updated>${e.releasedAt.toISOString()}</updated><link rel="alternate" type="text/html" href="${xmlEscape(home)}"/><summary>${xmlEscape(e.summary)}</summary></entry>`),
      `</feed>`,
    ].join("\n");
    return reply.type("application/atom+xml; charset=utf-8").send(xml);
  });

  app.get("/api/portal/logo",async (req, reply) => {
    if (!counter.take(`read:${addressOf(req)}`, limits.readsPerIpPerMinute, 60_000)) return reply.code(429).send({ error: "too_many", message: "Please slow down a little." });
    const p = await portalOf(req, reply);
    const logo = p && p.hasLogo ? await deps.feedback.portalLogo(p.companyId) : null;
    if (!p) return;
    if (!logo) return reply.code(404).send({ error: "not_found", message: "No logo." });
    return sendLogo(reply, logo);
  });

  app.post("/api/portal/votes", async (req, reply) => {
    const p = await portalOf(req, reply);
    if (!p || !allowWrite(req, reply, p.companyId)) return;
    try {
      const b = z.object({ featureId: z.string().uuid(), importance: z.enum(IMPORTANCE), comment: z.string().trim().max(2000).nullable().optional(), ...Who, website: z.string().max(0).optional() }).parse(req.body);
      const kind: ConfirmKind = b.comment?.trim() ? "comment" : "vote";
      const c = await confirmMode(req, p, b.email, kind);
      if (c.mode === "quiet") return { importance: b.importance, comment: b.comment?.trim() || null, needsConfirm: true };
      const done = await deps.feedback.portalVote(p.companyId, voterOf(req, reply), { ...b, email: b.email || null, ...(c.mode === "pending" ? { confirm: c.confirm } : {}) });
      if (c.mode === "pending" && done.confirmToken) await sendConfirmation(p, c.confirm.email, kind, done.featureTitle, done.confirmToken, c.confirm.hours);
      return { importance: done.importance, comment: done.comment, ...(c.mode === "pending" ? { needsConfirm: true } : {}) };
    } catch (err) {
      return errors(reply)(err);
    }
  });

  app.delete("/api/portal/votes/:featureId", async (req, reply) => {
    const p = await portalOf(req, reply);
    if (!p || !allowWrite(req, reply, p.companyId)) return;
    try {
      const { featureId } = z.object({ featureId: z.string().uuid() }).parse(req.params);
      await deps.feedback.portalUnvote(p.companyId, voterOf(req, reply), featureId);
      return reply.code(204).send();
    } catch (err) {
      return errors(reply)(err);
    }
  });

  app.post("/api/portal/ideas", async (req, reply) => {
    const p = await portalOf(req, reply);
    if (!p || !allowWrite(req, reply, p.companyId)) return;
    try {
      // "website" is a field people never see; bots that fill it in are thanked and ignored.
      const b = z.object({ title: Text(200), text: Text(5000), ...Who, website: z.string().max(200).optional() }).parse(req.body);
      if (b.website) return reply.code(201).send({ ok: true });
      const c = await confirmMode(req, p, b.email, "idea");
      if (c.mode === "quiet") return reply.code(201).send({ ok: true, needsConfirm: true });
      const done = await deps.feedback.portalIdea(p.companyId, voterOf(req, reply), { ...b, email: b.email || null, ...(c.mode === "pending" ? { confirm: c.confirm } : {}) });
      if (c.mode === "pending" && done.confirmToken) await sendConfirmation(p, c.confirm.email, "idea", done.what, done.confirmToken, c.confirm.hours);
      return reply.code(201).send({ ok: true, ...(c.mode === "pending" ? { needsConfirm: true } : {}) });
    } catch (err) {
      return errors(reply)(err);
    }
  });

  // BOS-1388: the emailed link's page posts the token here (in the body, so it is never in a URL or a log). It needs no portal
  // link: the token is its own proof. Whatever is wrong with it (unknown, used, expired, a guess) gets the one same answer.
  app.post("/api/portal/confirm", async (req, reply) => {
    if (!counter.take(`confirm:${addressOf(req)}`, 30, 3_600_000)) return reply.code(429).send({ error: "too_many", message: "Please slow down a little." });
    try {
      const { token } = z.object({ token: z.string().max(100) }).parse(req.body);
      const done = await deps.feedback.confirmPortalNote(token);
      if (!done) return reply.code(404).send({ error: "not_found", message: "This link has already been used or has run out. Post again and we'll send a new one." });
      const s = await deps.feedback.settings(done.companyId);
      const secret = await deps.feedback.rememberAddress(done.companyId, done.email, s.rememberAddressDays);
      reply.header("cache-control", "no-store");
      reply.setCookie(CONFIRMED_COOKIE, `${Buffer.from(done.email, "utf8").toString("base64url")}.${secret}`, { path: "/api/portal", httpOnly: true, sameSite: "strict", secure: cookieSecure(req), maxAge: s.rememberAddressDays * 86_400 });
      return { ok: true };
    } catch (err) {
      return errors(reply)(err);
    }
  });
}

/** A listener with only the portal: its page, its assets and its API. Nothing else answers. */
export async function buildPortalApp(opts: { feedback: Feedback; webDir?: string; secureCookies: boolean; logger?: boolean; trustedProxies?: string[]; clientHeader?: string; limits?: Partial<PortalLimits>; counterMaxKeys?: number; mailer?: PortalMailer; portalUrl?: string }) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: false });
  await app.register(cookie);
  // BOSSMAN_PORTAL_TRUSTED_PROXY: empty means the connecting address is the visitor, as before.
  const { matcher } = parseTrustedProxies(opts.trustedProxies);
  const { header } = parseClientHeader(opts.clientHeader);
  await portalRoutes(app, {
    feedback: opts.feedback,
    secureCookies: opts.secureCookies,
    limits: opts.limits,
    counterMaxKeys: opts.counterMaxKeys,
    mailer: opts.mailer,
    portalUrl: opts.portalUrl,
    clientAddress: matcher.size ? (req) => portalClientAddress(req.socket.remoteAddress ?? req.ip, req.headers, matcher, header) : undefined,
  });
  if (opts.webDir) {
    await app.register(fastifyStatic, {
      root: opts.webDir,
      wildcard: false,
      cacheControl: false,
      index: false,
      // The portal page and assets, but not the owner app's own bundle.
      allowedPath: (p) => p === "/portal.html" || p === "/confirm.html" || (p.startsWith("/assets/") && !p.startsWith("/assets/main-")),
      // Serves the build's .br/.gz sidecars (BOS-411) with no CPU per request. Only the negotiation may
      // pick one: a sidecar is never a route of its own. setHeaders sees the sibling's path, so the
      // suffix is stripped before the immutable rule.
      preCompressed: true,
      globIgnore: PRECOMPRESSED_SUFFIX_LIST.map((suffix) => `**/*${suffix}`),
      setHeaders(res, file) {
        res.header("cache-control", assetPathOf(file).includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.get("/", async (_req, reply) => reply.redirect("/portal.html"));
  }
  app.addHook("onSend", async (req, reply) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    if (!req.url.startsWith("/api/")) reply.header("content-security-policy", PORTAL_CSP);
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).type("text/plain").send("Not found"));
  return app;
}
