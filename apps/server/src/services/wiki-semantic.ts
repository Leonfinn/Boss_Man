// Optional semantic search over the wiki (per company, off by default). Each page's sections are
// embedded in the background after a write; wiki.search fuses the closest sections with full-text
// hits. Embedding failures are logged as one short line and never block a write or a search.
import { createHash } from "node:crypto";
import { and, cosineDistance, countDistinct, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { wikiPages, wikiSectionEmbeddings, wikiSemanticSettings } from "../db/schema.js";
import { splitSections } from "./wiki.js";

export const BATCH = 64;
const MAX_CHARS = 6000;
export const TOP = 50;

/** `ownerAnswers`: the same provider and key also embed the owner's past answers (BOS-1593); off by default, ticked apart from the wiki. */
export type SemanticSettings = { enabled: boolean; baseUrl: string; model: string; dims: number; secretId: string | null; ownerAnswers: boolean; ticketMeaning: boolean };
export const DEFAULTS: SemanticSettings = { enabled: false, baseUrl: "https://openrouter.ai/api/v1", model: "google/gemini-embedding-001", dims: 768, secretId: null, ownerAnswers: false, ticketMeaning: false };
/** Embeds texts with a company's saved provider, for a caller other than the wiki (owner answers, BOS-1593). */
export type Embedder = { model: string; dims: number; embed: (input: string[], timeoutMs?: number) => Promise<number[][]> };
/** `score`: cosine similarity (1 = same direction), used by the CEO brief's relevance floor (BOS-2116). */
export type SemanticHit = { slug: string; title: string; path: string; snippet: string; score?: number };

/** The first `dims` numbers (Matryoshka models allow cutting), scaled to length 1. */
function unit(v: number[], dims: number) {
  if (v.length < dims) throw new Error(`the provider returned ${v.length} dimensions, expected ${dims}`);
  const c = v.slice(0, dims);
  const n = Math.hypot(...c) || 1;
  return c.map((x) => x / n);
}

export function wikiSemanticService(db: Db, deps: { reveal: (secretId: string) => Promise<string | null>; fetch?: typeof fetch; log?: (msg: string) => void; debounceMs?: number }) {
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? (() => {});
  // shortcut: in-process debounce, lost on restart; the next write or "re-embed all" catches up. Use a job table if that hurts.
  const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; companyId: string }>();
  // shortcut: in-flight embeds in this process only; lost on restart, harmless because drain() waits for them on shutdown.
  const running = new Set<Promise<void>>();
  // The last provider error per company, for the settings panel. Lost on restart, harmless: the next embed or Test sets it again.
  const lastError = new Map<string, { message: string; at: Date }>();
  const failed = (companyId: string, err: Error) => (lastError.set(companyId, { message: err.message, at: new Date() }), log(`wiki embeddings: ${err.message}`));

  async function settings(companyId: string): Promise<SemanticSettings> {
    const [row] = await db.select().from(wikiSemanticSettings).where(eq(wikiSemanticSettings.companyId, companyId));
    return row ? { enabled: row.enabled, baseUrl: row.baseUrl, model: row.model, dims: row.dims, secretId: row.secretId, ownerAnswers: row.ownerAnswers, ticketMeaning: row.ticketMeaning } : DEFAULTS;
  }

  /** The settings, but only when semantic search is on and its key resolves. */
  async function ready(companyId: string) {
    const s = await settings(companyId);
    if (!s.enabled || !s.secretId) return null;
    const key = await deps.reveal(s.secretId);
    return key ? { s, key } : null;
  }

  /** POST {baseUrl}/embeddings. Errors carry no request or response body, and never the key. */
  async function embed(s: SemanticSettings, key: string, input: string[], timeoutMs = 30_000): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < input.length; i += BATCH) {
      const chunk = input.slice(i, i + BATCH);
      let res: Response;
      try {
        res = await doFetch(`${s.baseUrl.replace(/\/+$/, "")}/embeddings`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ model: s.model, input: chunk, dimensions: s.dims }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new Error("the embeddings provider could not be reached");
      }
      if (!res.ok) throw new Error(`the embeddings provider answered ${res.status}`);
      const data = ((await res.json().catch(() => null)) as { data?: Array<{ index?: number; embedding?: number[] }> } | null)?.data;
      if (!Array.isArray(data) || data.length !== chunk.length || data.some((d) => !Array.isArray(d.embedding))) throw new Error("the embeddings provider sent an unexpected reply");
      data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      out.push(...data.map((d) => unit(d.embedding!, s.dims)));
    }
    return out;
  }

  /** Brings one page's embeddings up to date: embeds new or changed sections, drops sections that are gone. */
  async function embedPage(companyId: string, pageId: string): Promise<boolean> {
    const r = await ready(companyId);
    if (!r) return false;
    const [p] = await db.select().from(wikiPages).where(and(eq(wikiPages.id, pageId), eq(wikiPages.companyId, companyId)));
    if (!p) return false;
    const seen = new Set<string>();
    const wanted = splitSections(p.body)
      .filter((s) => !seen.has(s.path) && !!seen.add(s.path) && p.body.slice(s.start, s.ownEnd).trim())
      .map((s) => {
        const text = `${p.title} > ${s.path}\n${p.body.slice(s.start, s.ownEnd)}`.slice(0, MAX_CHARS);
        return { path: s.path, text, hash: createHash("sha256").update(`${r.s.model}|${r.s.dims}|${s.path}|${text}`).digest("hex") };
      });
    const have = new Map((await db.select().from(wikiSectionEmbeddings).where(eq(wikiSectionEmbeddings.pageId, pageId))).map((e) => [e.sectionPath, e.contentHash]));
    const stale = [...have.keys()].filter((path) => !wanted.some((w) => w.path === path));
    if (stale.length) await db.delete(wikiSectionEmbeddings).where(and(eq(wikiSectionEmbeddings.pageId, pageId), inArray(wikiSectionEmbeddings.sectionPath, stale)));
    const todo = wanted.filter((w) => have.get(w.path) !== w.hash);
    if (!todo.length) return false;
    const vectors = await embed(r.s, r.key, todo.map((t) => t.text));
    for (const [i, t] of todo.entries()) {
      const row = { companyId, pageId, sectionPath: t.path, contentHash: t.hash, model: r.s.model, dims: r.s.dims, embedding: vectors[i]!, updatedAt: new Date() };
      await db.insert(wikiSectionEmbeddings).values(row).onConflictDoUpdate({ target: [wikiSectionEmbeddings.pageId, wikiSectionEmbeddings.sectionPath], set: row });
    }
    return true;
  }

  const run = (companyId: string, pageId: string) => {
    const job = embedPage(companyId, pageId).then(
      (embedded) => void (embedded && lastError.delete(companyId)),
      (err: Error) => failed(companyId, err),
    );
    running.add(job);
    void job.finally(() => running.delete(job));
    return job;
  };

  /**
   * The company's provider for a meaning search that has its own box (owner answers, BOS-1593; tickets and advice, BOS-2116),
   * or null when that box is off or the key doesn't resolve. A failure is kept as the panel's last error and rethrown for the caller to fall back.
   */
  async function embedderFor(companyId: string, box: "ownerAnswers" | "ticketMeaning"): Promise<Embedder | null> {
    const s = await settings(companyId);
    if (!s[box] || !s.secretId) return null;
    const key = await deps.reveal(s.secretId);
    if (!key) return null;
    return {
      model: s.model,
      dims: s.dims,
      embed: async (input, timeoutMs) => {
        try {
          return await embed(s, key, input, timeoutMs);
        } catch (err) {
          failed(companyId, err as Error);
          throw err;
        }
      },
    };
  }

  return {
    settings,
    ownerAnswerEmbedder: (companyId: string) => embedderFor(companyId, "ownerAnswers"),
    /** Companies with ticket meaning search on, for its background embedder (BOS-2116). */
    async ticketMeaningCompanies(): Promise<string[]> {
      return (await db.select({ id: wikiSemanticSettings.companyId }).from(wikiSemanticSettings).where(eq(wikiSemanticSettings.ticketMeaning, true))).map((r) => r.id);
    },
    ticketEmbedder: (companyId: string) => embedderFor(companyId, "ticketMeaning"),
    /** Companies with owner-answer meaning search on, for the background embedder (BOS-1593). */
    async ownerAnswerCompanies(): Promise<string[]> {
      return (await db.select({ id: wikiSemanticSettings.companyId }).from(wikiSemanticSettings).where(eq(wikiSemanticSettings.ownerAnswers, true))).map((r) => r.id);
    },
    async setSettings(companyId: string, patch: Partial<SemanticSettings>) {
      const set = { ...DEFAULTS, ...(await settings(companyId)), ...patch };
      await db.insert(wikiSemanticSettings).values({ companyId, ...set }).onConflictDoUpdate({ target: wikiSemanticSettings.companyId, set });
      return set;
    },

    /** After a page write: embed its sections once it has been quiet for debounceMs (default 30s). */
    enqueue(companyId: string, pageId: string) {
      clearTimeout(pending.get(pageId)?.timer);
      const timer = setTimeout(() => (pending.delete(pageId), void run(companyId, pageId)), deps.debounceMs ?? 30_000);
      timer.unref();
      pending.set(pageId, { timer, companyId });
    },

    /** "Re-embed all": every page of the company, in the background. Unchanged sections are skipped. */
    async reindexAll(companyId: string) {
      const pages = await db.select({ id: wikiPages.id }).from(wikiPages).where(eq(wikiPages.companyId, companyId));
      void (async () => {
        for (const p of pages) await run(companyId, p.id);
      })();
      return pages.length;
    },

    /** How far indexing has got: pages with sections embedded by the current model, of all pages, and the last provider error. */
    async status(companyId: string) {
      const s = await settings(companyId);
      const [all] = await db.select({ n: countDistinct(wikiPages.id) }).from(wikiPages).where(eq(wikiPages.companyId, companyId));
      const [done] = await db
        .select({ n: countDistinct(wikiSectionEmbeddings.pageId) })
        .from(wikiSectionEmbeddings)
        .where(and(eq(wikiSectionEmbeddings.companyId, companyId), eq(wikiSectionEmbeddings.model, s.model), eq(wikiSectionEmbeddings.dims, s.dims)));
      const err = lastError.get(companyId);
      return { pages: Number(all?.n ?? 0), indexed: Number(done?.n ?? 0), lastError: err ? { message: err.message, at: err.at.toISOString() } : null };
    },

    /** Embeds one short text with the saved settings, so the owner can see the provider answer. */
    async test(companyId: string): Promise<{ ok: boolean; message: string }> {
      const s = await settings(companyId);
      if (!s.enabled) return { ok: false, message: "Semantic search is off. Tick the box and save first." };
      if (!s.secretId) return { ok: false, message: "No API key is chosen." };
      const key = await deps.reveal(s.secretId);
      if (!key) return { ok: false, message: "The chosen API key couldn't be read from the secret store." };
      try {
        await embed(s, key, ["Boss Man connection test"]);
        lastError.delete(companyId);
        return { ok: true, message: `Working: ${s.model} returned a ${s.dims}-number embedding.` };
      } catch (err) {
        failed(companyId, err as Error);
        return { ok: false, message: `Not working: ${(err as Error).message}.` };
      }
    },

    /** Runs whatever is waiting now and waits for everything in flight. For tests and shutdown. */
    async drain() {
      for (const [pageId, { timer, companyId }] of [...pending]) (clearTimeout(timer), pending.delete(pageId), void run(companyId, pageId));
      while (running.size) await Promise.all([...running]);
    },
    stop() {
      for (const { timer } of pending.values()) clearTimeout(timer);
      pending.clear();
    },

    /** The company's sections closest to q, nearest first; null when semantic search is off, its key is missing or the provider fails. */
    async similar(companyId: string, q: string): Promise<SemanticHit[] | null> {
      const r = await ready(companyId);
      if (!r) return null;
      let qv: number[];
      try {
        qv = (await embed(r.s, r.key, [q]))[0]!;
      } catch (err) {
        failed(companyId, err as Error);
        return null;
      }
      const dist = cosineDistance(wikiSectionEmbeddings.embedding, qv);
      const rows = await db
        .select({ path: wikiSectionEmbeddings.sectionPath, slug: wikiPages.slug, title: wikiPages.title, body: wikiPages.body, d: dist })
        .from(wikiSectionEmbeddings)
        .innerJoin(wikiPages, eq(wikiPages.id, wikiSectionEmbeddings.pageId))
        .where(and(eq(wikiSectionEmbeddings.companyId, companyId), eq(wikiSectionEmbeddings.model, r.s.model), eq(wikiSectionEmbeddings.dims, r.s.dims)))
        .orderBy(dist)
        .limit(TOP);
      return rows.map((x) => {
        const s = splitSections(x.body).find((sec) => sec.path === x.path);
        const text = s ? x.body.slice(s.start, s.ownEnd).replace(/^#.*\n/, "") : "";
        return { slug: x.slug, title: x.title, path: x.path, snippet: text.replace(/\s+/g, " ").trim().slice(0, 200), score: 1 - Number(x.d) };
      });
    },
  };
}
export type WikiSemantic = ReturnType<typeof wikiSemanticService>;
