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
import { FeedbackError, type feedbackService } from "./services/feedback.js";

export const PORTAL_CSP = "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const VOTER_COOKIE = "bm_portal_voter";

export type PortalLimits = { writesPerIpPerHour: number; writesPerPortalPerHour: number; readsPerIpPerMinute: number };
export const DEFAULT_PORTAL_LIMITS: PortalLimits = { writesPerIpPerHour: 40, writesPerPortalPerHour: 600, readsPerIpPerMinute: 120 };

/** A sliding-window counter per key, bounded in memory. */
function windowCounter(now: () => number) {
  // shortcut: rate-limit counters in memory; lost on restart, harmless because it only forgets recent hits.
  const hits = new Map<string, number[]>();
  return {
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
      if (hits.size > 20_000) hits.delete(hits.keys().next().value!);
      return true;
    },
  };
}

/** The logo's bytes as an inline image the browser may not reinterpret. */
export function sendLogo(reply: FastifyReply, logo: { bytes: Buffer; type: string }) {
  return reply.type(logo.type).header("x-content-type-options", "nosniff").header("content-disposition", "inline").header("cache-control", "private, no-cache").send(logo.bytes);
}

type Feedback = ReturnType<typeof feedbackService>;

export async function portalRoutes(app: FastifyInstance, deps: { feedback: Feedback; secureCookies: boolean | "auto"; limits?: Partial<PortalLimits>; now?: () => number }) {
  const limits = { ...DEFAULT_PORTAL_LIMITS, ...deps.limits };
  const counter = windowCounter(deps.now ?? (() => Date.now()));
  const Text = (max: number) => z.string().trim().min(1).max(max);
  const Who = { name: z.string().trim().max(100).nullable().optional(), email: z.string().trim().email().max(320).nullable().optional().or(z.literal("")) };

  /** The portal from the request's header, or a 404 that looks the same whatever was wrong. */
  async function portalOf(req: FastifyRequest, reply: FastifyReply) {
    const token = req.headers["x-portal-token"];
    const p = typeof token === "string" ? await deps.feedback.portalFor(token) : null;
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
    if (counter.take(`ip:${req.ip}`, limits.writesPerIpPerHour, 3_600_000) && counter.take(`portal:${companyId}`, limits.writesPerPortalPerHour, 3_600_000)) return true;
    reply.code(429).send({ error: "too_many", message: "That's a lot of feedback in a short time. Please try again later." });
    return false;
  }
  const errors = (reply: FastifyReply) => (err: unknown) => {
    if (err instanceof FeedbackError) return reply.code(err.status).send({ error: "rejected", message: err.message });
    if (err instanceof ZodError) return reply.code(400).send({ error: "invalid_request", message: "Some of that didn't look right; check the fields and try again." });
    throw err;
  };

  app.get("/api/portal", async (req, reply) => {
    if (!counter.take(`read:${req.ip}`, limits.readsPerIpPerMinute, 60_000)) return reply.code(429).send({ error: "too_many", message: "Please slow down a little." });
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
      back: backUrl ? { url: backUrl, text: p.backText?.trim() || title } : null,
      features: await deps.feedback.portalView(p.companyId, voter),
    };
  });

  app.get("/api/portal/logo", async (req, reply) => {
    if (!counter.take(`read:${req.ip}`, limits.readsPerIpPerMinute, 60_000)) return reply.code(429).send({ error: "too_many", message: "Please slow down a little." });
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
      return await deps.feedback.portalVote(p.companyId, voterOf(req, reply), { ...b, email: b.email || null });
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
      await deps.feedback.portalIdea(p.companyId, voterOf(req, reply), { ...b, email: b.email || null });
      return reply.code(201).send({ ok: true });
    } catch (err) {
      return errors(reply)(err);
    }
  });
}

/** A listener with only the portal: its page, its assets and its API. Nothing else answers. */
export async function buildPortalApp(opts: { feedback: Feedback; webDir?: string; secureCookies: boolean; logger?: boolean }) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: false });
  await app.register(cookie);
  await portalRoutes(app, { feedback: opts.feedback, secureCookies: opts.secureCookies });
  if (opts.webDir) {
    await app.register(fastifyStatic, {
      root: opts.webDir,
      wildcard: false,
      cacheControl: false,
      index: false,
      // The portal page and assets, but not the owner app's own bundle.
      allowedPath: (p) => p === "/portal.html" || (p.startsWith("/assets/") && !p.startsWith("/assets/main-")),
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
