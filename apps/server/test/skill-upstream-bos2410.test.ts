// BOS-2410: linked skills say when their GitHub source has a newer version; answers kept 6 hours per source;
// a source that can't be read is reported on that skill only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { openPglite } from "../src/db/client.js";
import { companies, skills } from "../src/db/schema.js";
import { skillsService, UPSTREAM_TTL_MS } from "../src/services/skills.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await close?.();
  close = undefined;
});

async function setup(answer: (url: string) => Response) {
  const { db, close: c } = await openPglite();
  close = c;
  const [co] = await db.insert(companies).values({ name: "Co" }).returning();
  const calls: Array<{ url: string; auth: string | null; method: string }> = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, auth: (init?.headers as Record<string, string>).authorization ?? null });
    return answer(url);
  }) as typeof fetch;
  const svc = skillsService(db, { fetch: fetchFn, gitToken: async () => "made-up-token-0001" });
  const add = async (name: string, sourceUrl: string, sourceRef: string) =>
    (await db.insert(skills).values({ companyId: co!.id, name, description: "d", source: "link", sourceUrl, sourceRef, files: [], sizeBytes: 1 }).returning())[0]!;
  return { svc, add, calls, db, companyId: co!.id };
}

const commit = (sha: string, date = "2026-11-20T10:00:00Z") => new Response(JSON.stringify([{ sha, commit: { committer: { date } } }]), { status: 200 });

describe("skill upstream check", () => {
  it("flags a moved folder, leaves an unchanged one, uses the token, and caches for 6 hours", async () => {
    const t = await setup((url) => {
      if (url.includes("/acme/moved/") || url.includes("/repos/acme/moved/")) return url.includes(`sha=${A}`) ? commit(A) : commit(B, "2026-11-22T09:00:00Z");
      // Head moved elsewhere in the repo, but the folder's last commit is still the same one.
      return url.includes(`sha=${A}`) ? commit(C) : commit(C);
    });
    const moved = await t.add("moved", "https://github.com/acme/moved/tree/main/x", A);
    const same = await t.add("same", "https://github.com/acme/same/tree/main/y", A);
    const r = await t.svc.upstream(t.companyId);
    // Read-only: the skill row (pinned commit, files) is untouched, and only GET calls were made.
    const [after] = await t.db.select().from(skills).where(eq(skills.id, moved.id));
    expect(after).toEqual(moved);
    expect(t.calls.every((c) => c.method === "GET")).toBe(true);
    expect(r[moved.id]).toEqual({ status: "newer", commit: B, date: "2026-11-22T09:00:00Z" });
    expect(r[same.id]).toEqual({ status: "current" });
    expect(t.calls.every((c) => c.auth === "Bearer made-up-token-0001")).toBe(true);
    const n = t.calls.length;
    await t.svc.upstream(t.companyId);
    expect(t.calls.length).toBe(n);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + UPSTREAM_TTL_MS + 1000);
    await t.svc.upstream(t.companyId);
    expect(t.calls.length).toBeGreaterThan(n);
  });

  it("reports an unreadable source on that skill only", async () => {
    const t = await setup((url) => (url.includes("/acme/gone/") ? new Response("{}", { status: 404 }) : commit(A)));
    const gone = await t.add("gone", "https://github.com/acme/gone", A);
    const ok = await t.add("fine", "https://github.com/acme/fine", A);
    const r = await t.svc.upstream(t.companyId);
    expect(r[gone.id]?.status).toBe("error");
    expect((r[gone.id] as { reason: string }).reason).toMatch(/Nothing found/);
    expect(r[ok.id]).toEqual({ status: "current" });
  });
});
