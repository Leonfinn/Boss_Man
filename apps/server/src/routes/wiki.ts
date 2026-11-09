// The company wiki, and what each ticket produced (R69). Owner routes: app.ts registers these inside
// its owner scope, so the owner check and error handling are the same as for its other routes.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { wikiSemanticService } from "../services/wiki-semantic.js";
import { cleanFolder, HISTORY_PAGE_MAX, MAX_BODY, pageSlug, WikiError, type wikiService } from "../services/wiki.js";

const Uuid = z.string().uuid();
const IdParam = z.object({ id: Uuid });

export function wikiRoutes(owner: FastifyInstance, deps: { wiki: ReturnType<typeof wikiService>; semantic: ReturnType<typeof wikiSemanticService> }) {
  const { wiki, semantic } = deps;
  const wikiErrors = (reply: FastifyReply) => (err: unknown) => {
    if (err instanceof WikiError) return reply.code(err.status).send({ error: "wiki", message: err.message });
    throw err;
  };
  // A page's address can hold folders ("research/agent-landscape"), so it's the rest of the path.
  const SlugParams = z.object({ id: Uuid, "*": z.string().min(1).max(500) }).transform((p) => ({ id: p.id, slug: p["*"] }));
  const PageBody = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(MAX_BODY), folder: z.string().max(400).optional() });
  // The owner's own editor may replace a page outright; the shrink guard is for agents (BOS-430).
  const OwnerPageBody = PageBody.extend({ replace: z.boolean().optional() });
  owner.get("/api/companies/:id/wiki", async (req) => wiki.list(IdParam.parse(req.params).id, z.object({ q: z.string().max(200).optional() }).parse(req.query).q));
  owner.post("/api/companies/:id/wiki", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = PageBody.parse(req.body);
    try {
      const slug = pageSlug(cleanFolder(b.folder ?? ""), b.title);
      const [taken] = (await wiki.list(id)).filter((p) => p.slug === slug);
      if (taken) return reply.code(409).send({ error: "wiki", message: `There's already a page called "${taken.title}" there. Open it to change it, or pick another title.` });
      const r = await wiki.write(id, { ...b, slug, folder: b.folder ?? "", agentId: null, runId: null });
      return reply.code(201).send(r.page);
    } catch (err) {
      return wikiErrors(reply)(err);
    }
  });
  owner.get("/api/companies/:id/wiki/*", async (req, reply) => {
    const { id, slug } = SlugParams.parse(req.params);
    // versions=1 lists every saved version of the page, newest first, in pages: the history
    // screen uses it to reach versions past the newest 100 the page itself carries (BOS-496).
    if ((req.query as Record<string, string | undefined>).versions === "1") {
      const q = z.object({ offset: z.coerce.number().int().min(0).optional(), limit: z.coerce.number().int().min(1).max(HISTORY_PAGE_MAX).optional() }).parse(req.query);
      return wiki.versions(id, slug, q).catch(wikiErrors(reply));
    }
    return wiki.get(id, slug).catch(wikiErrors(reply));
  });
  owner.put("/api/companies/:id/wiki/*", async (req, reply) => {
    const { id, slug } = SlugParams.parse(req.params);
    return wiki.write(id, { ...OwnerPageBody.parse(req.body), slug, agentId: null, runId: null }).then((r) => r.page, wikiErrors(reply));
  });
  owner.delete("/api/companies/:id/wiki/*", async (req, reply) => {
    const { id, slug } = SlugParams.parse(req.params);
    return wiki.remove(id, slug).then(() => reply.code(204).send(), wikiErrors(reply));
  });
  // Put an old version back (BOS-430): a new version of its own, so the restore can be undone.
  // The page's slug goes in the body, as a page address can hold folders and Fastify's wildcard must be last.
  owner.post("/api/companies/:id/wiki-restore", async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ slug: z.string().min(1).max(500), revisionId: Uuid }).parse(req.body);
    return wiki.restore(id, { ...b, agentId: null, runId: null, isCeo: true }).then((r) => r.page, wikiErrors(reply));
  });
  owner.get("/api/companies/:id/wiki-revisions/:rev", async (req, reply) => {
    const { id, rev } = z.object({ id: Uuid, rev: Uuid }).parse(req.params);
    return wiki.revision(id, rev).catch(wikiErrors(reply));
  });
  // Semantic wiki search settings. dims stays at the 768 the embeddings column holds.
  const semanticView = (s: Awaited<ReturnType<typeof semantic.settings>>) => ({ enabled: s.enabled, baseUrl: s.baseUrl, model: s.model, dims: s.dims, secretId: s.secretId });
  owner.get("/api/companies/:id/wiki-semantic", async (req) => {
    const id = IdParam.parse(req.params).id;
    return { ...semanticView(await semantic.settings(id)), status: await semantic.status(id) };
  });
  owner.post("/api/companies/:id/wiki-semantic/test", async (req) => semantic.test(IdParam.parse(req.params).id));
  owner.put("/api/companies/:id/wiki-semantic", async (req) => {
    const { id } = IdParam.parse(req.params);
    const b = z.object({ enabled: z.boolean(), baseUrl: z.string().url().max(300).regex(/^https?:/), model: z.string().trim().min(1).max(200), secretId: Uuid.nullable() }).parse(req.body);
    const before = await semantic.settings(id);
    const after = await semantic.setSettings(id, b);
    if (after.enabled && (!before.enabled || before.model !== after.model || before.baseUrl !== after.baseUrl || before.secretId !== after.secretId)) await semantic.reindexAll(id);
    return semanticView(after);
  });
  owner.post("/api/companies/:id/wiki-semantic/reindex", async (req, reply) => reply.code(202).send({ pages: await semantic.reindexAll(IdParam.parse(req.params).id) }));
  owner.get("/api/tickets/:id/artifacts", async (req) => wiki.artifacts(IdParam.parse(req.params).id, { family: true }));
  owner.delete("/api/artifacts/:id", async (req, reply) => wiki.removeArtifact(IdParam.parse(req.params).id).then(() => reply.code(204).send(), wikiErrors(reply)));
}
