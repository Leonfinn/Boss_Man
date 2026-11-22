import { afterEach, expect, it } from "vitest";
import { makeApp, signIn, type TestApp } from "./helpers.js";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const MISSING = "00000000-0000-4000-8000-000000000009";

it("the owner can change and remove a key result (BOS-2250)", async () => {
  t = await makeApp();
  const { cookie } = await signIn(t);
  const req = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => t!.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json();
  const obj = (await req("POST", `/api/companies/${company.id}/objectives`, { title: "Launch", priority: 1 })).json();
  const kr = (await req("POST", `/api/objectives/${obj.id}/key-results`, { title: "Beta usres", target: 50, current: 20, unit: "users" })).json();

  const patched = await req("PATCH", `/api/key-results/${kr.id}`, { title: "Beta users", current: 30, target: 60 });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toMatchObject({ title: "Beta users", current: 30, target: 60, unit: "users", method: "manual" });

  expect((await req("PATCH", `/api/key-results/${kr.id}`, { unit: null, target: null })).json()).toMatchObject({ unit: null, target: null, current: 30 });
  expect((await req("PATCH", `/api/key-results/${kr.id}`, { title: "  " })).statusCode).toBe(400);
  expect((await req("PATCH", `/api/key-results/${kr.id}`, { title: "x".repeat(201) })).statusCode).toBe(400);
  expect((await req("PATCH", `/api/key-results/${kr.id}`, { unit: "x".repeat(21) })).statusCode).toBe(400);
  expect((await req("PATCH", `/api/key-results/${MISSING}`, { current: 1 })).statusCode).toBe(404);

  const tree = (await req("GET", "/api/roadmap?today=2026-10-16")).json();
  expect(tree[0].objectives[0].keyResults[0]).toMatchObject({ title: "Beta users", current: 30 });

  expect((await req("DELETE", `/api/key-results/${kr.id}`)).statusCode).toBe(204);
  expect((await req("DELETE", `/api/key-results/${kr.id}`)).statusCode).toBe(404);
  const after = (await req("GET", "/api/roadmap?today=2026-10-16")).json();
  expect(after[0].objectives[0].keyResults).toEqual([]);
});
