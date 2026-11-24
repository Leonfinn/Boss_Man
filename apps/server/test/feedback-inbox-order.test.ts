import { afterEach, describe, expect, it } from "vitest";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

describe("feedback inbox: oldest first, the after cursor and the summary", () => {
  it("pages forward with after=, and summarises what waits and where this week's notes came from", async () => {
    t = await makeApp();
    const { cookie } = await signIn(t);
    const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
    const base = `/api/companies/${company.id}`;
    const ids: string[] = [];
    for (const text of ["one", "two", "three", "four"]) {
      ids.push((await req("POST", `${base}/feedback`, { text })).json().id);
      // test-lines-ok: not waiting for readiness; it only makes each note's created time (ms) differ so the order is defined
      await new Promise((r) => setTimeout(r, 5));
    }
    await req("PATCH", `/api/feedback/${ids[3]}`, { state: "processed" });

    const oldest = (await req("GET", `${base}/feedback?order=oldest&limit=2`)).json() as Array<{ id: string; createdAt: string }>;
    expect(oldest.map((n) => n.id)).toEqual([ids[0], ids[1]]);
    const next = (await req("GET", `${base}/feedback?order=oldest&limit=2&after=${encodeURIComponent(oldest[1]!.createdAt)}`)).json() as Array<{ id: string }>;
    expect(next.map((n) => n.id)).toEqual([ids[2], ids[3]]);
    const newest = (await req("GET", `${base}/feedback?limit=2`)).json() as Array<{ id: string }>;
    expect(newest.map((n) => n.id)).toEqual([ids[3], ids[2]]);

    const s = (await req("GET", `${base}/feedback-summary`)).json() as { waiting: number; oldest: { id: string; title: string } | null; week: { portal: number; github: number; owner: number } };
    expect(s.waiting).toBe(3);
    expect(s.oldest).toMatchObject({ id: ids[0], title: "one" });
    expect(s.week).toEqual({ portal: 0, github: 0, owner: 4 });
  });
});
