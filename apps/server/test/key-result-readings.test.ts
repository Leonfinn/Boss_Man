import { afterEach, expect, it } from "vitest";
import { makeApp, signIn, type TestApp } from "./helpers.js";
import { keyResultReadings } from "../src/db/schema.js";
import { setKeyResultValue } from "../src/services/key-result-readings.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

it("each new key result value is stored with when and who (BOS-2458)", async () => {
  t = await makeApp();
  const { cookie } = await signIn(t);
  const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const obj = (await req("POST", `/api/companies/${company.id}/objectives`, { title: "Launch", priority: 1 })).json();
  const kr = (await req("POST", `/api/objectives/${obj.id}/key-results`, { title: "Users", target: 50, current: 20 })).json();
  const bare = (await req("POST", `/api/objectives/${obj.id}/key-results`, { title: "Never set", target: 5 })).json();

  // Saving the form with the same value is not a new reading; a changed value is.
  await req("PATCH", `/api/key-results/${kr.id}`, { title: "Users!", current: 20 });
  await req("PATCH", `/api/key-results/${kr.id}`, { current: 30 });
  await setKeyResultValue(t.db, kr.id, 35, { kind: "check" });

  const rows = (await t.db.select().from(keyResultReadings)).filter((r) => r.keyResultId === kr.id);
  expect(rows.map((r) => [r.value, r.byKind]).sort()).toEqual([[20, "owner"], [30, "owner"], [35, "check"]]);

  const tree = (await req("GET", "/api/roadmap?today=2026-10-16")).json();
  const krs = tree[0].objectives[0].keyResults as Array<{ id: string; readings: Array<{ value: number; by: string }> }>;
  expect(krs.find((k) => k.id === kr.id)!.readings.map((r) => [r.value, r.by])).toEqual([[20, "the owner"], [30, "the owner"], [35, "automatic check"]]);
  expect(krs.find((k) => k.id === bare.id)!.readings).toEqual([]);
});
