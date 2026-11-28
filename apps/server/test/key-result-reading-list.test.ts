import { afterEach, expect, it } from "vitest";
import { makeApp, signIn, type TestApp } from "./helpers.js";
import { agents } from "../src/db/schema.js";
import type { Db } from "../src/db/client.js";
import { READINGS_SHOWN, readingsFor, setKeyResultValue } from "../src/services/key-result-readings.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function seed() {
  t = await makeApp();
  const { cookie } = await signIn(t);
  const req = (method: "GET" | "POST", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const obj = (await req("POST", `/api/companies/${company.id}/objectives`, { title: "Launch", priority: 1 })).json();
  const made = async (title: string) => (await req("POST", `/api/objectives/${obj.id}/key-results`, { title, target: 50 })).json() as { id: string };
  const dev = (await t.db.insert(agents).values({ companyId: company.id, name: "Dana", role: "worker", agentKind: "claude" }).returning())[0]!;
  return { kr: await made("Users"), other: await made("Revenue"), bare: await made("Never set"), dev };
}

const at = (minute: number) => new Date(`2026-10-01T10:${String(minute).padStart(2, "0")}:00Z`);

it("an empty id list returns an empty map without querying", async () => {
  const db = {
    select: () => {
      throw new Error("readingsFor queried for an empty id list");
    },
  } as unknown as Db;
  expect((await readingsFor(db, [])).size).toBe(0);
});

it("readings come back oldest first with who gave each", async () => {
  const { kr, dev } = await seed();
  await setKeyResultValue(t!.db, kr.id, 10, { kind: "agent", agentId: dev.id }, at(3));
  await setKeyResultValue(t!.db, kr.id, 5, { kind: "owner" }, at(0));
  await setKeyResultValue(t!.db, kr.id, 8, { kind: "agent", agentId: null }, at(2));
  await setKeyResultValue(t!.db, kr.id, 7, { kind: "check" }, at(1));

  const readings = (await readingsFor(t!.db, [kr.id])).get(kr.id)!;
  expect(readings).toEqual([
    { at: "2026-10-01T10:00:00.000Z", value: 5, by: "the owner" },
    { at: "2026-10-01T10:01:00.000Z", value: 7, by: "automatic check" },
    { at: "2026-10-01T10:02:00.000Z", value: 8, by: "an agent" },
    { at: "2026-10-01T10:03:00.000Z", value: 10, by: "Dana" },
  ]);
});

it("keeps only the newest READINGS_SHOWN readings, still oldest first", async () => {
  const { kr } = await seed();
  const total = READINGS_SHOWN + 5;
  for (let i = 0; i < total; i++) await setKeyResultValue(t!.db, kr.id, i, { kind: "owner" }, at(i));

  const readings = (await readingsFor(t!.db, [kr.id])).get(kr.id)!;
  expect(readings).toHaveLength(READINGS_SHOWN);
  expect(readings.map((r) => r.value)).toEqual(Array.from({ length: READINGS_SHOWN }, (_, i) => i + 5));
});

it("each key result gets its own list and a key result with no readings is absent", async () => {
  const { kr, other, bare } = await seed();
  await setKeyResultValue(t!.db, kr.id, 1, { kind: "owner" }, at(0));
  await setKeyResultValue(t!.db, other.id, 2, { kind: "check" }, at(0));
  await setKeyResultValue(t!.db, other.id, 3, { kind: "owner" }, at(1));

  const map = await readingsFor(t!.db, [kr.id, other.id, bare.id]);
  expect([...map.keys()].sort()).toEqual([kr.id, other.id].sort());
  expect(map.get(kr.id)!.map((r) => r.value)).toEqual([1]);
  expect(map.get(other.id)!.map((r) => r.value)).toEqual([2, 3]);
  expect(map.has(bare.id)).toBe(false);
});
