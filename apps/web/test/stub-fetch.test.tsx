// @vitest-environment jsdom
// The shared fetch stub (BOS-2451): answers by path, and names and fails on a request it has no answer for.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Workflow } from "../src/pages/Workflow";
import { matchRoute, stubFetchByUrl, urlStub } from "./stub-fetch";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("matchRoute", () => {
  const routes = { "/api/a": 1, "/api/a/b": 2, "/api/p/*": 3, "/api/p/x/*": 4, "/api/q?days=30": 5 };
  it("matches the exact path and ignores the query", () => {
    expect(matchRoute(routes, "/api/a")).toBe("/api/a");
    expect(matchRoute(routes, "/api/a?company=c1")).toBe("/api/a");
    expect(matchRoute(routes, "http://localhost/api/a/b")).toBe("/api/a/b");
  });
  it("does not let a plain key answer a longer path (the wrong-shape fault)", () => {
    expect(matchRoute(routes, "/api/a/week")).toBeUndefined();
  });
  it("treats a trailing * as a prefix, and the longest key wins", () => {
    expect(matchRoute(routes, "/api/p/1/status")).toBe("/api/p/*");
    expect(matchRoute(routes, "/api/p/x/1")).toBe("/api/p/x/*");
  });
  it("compares the query when the key has one", () => {
    expect(matchRoute(routes, "/api/q?days=30")).toBe("/api/q?days=30");
    expect(matchRoute(routes, "/api/q?days=14")).toBeUndefined();
  });
});

describe("stubFetchByUrl", () => {
  it("answers each URL with its own body, as JSON, and passes a Response through", async () => {
    const f = stubFetchByUrl({ "/api/x": { x: 1 }, "/api/y": (url: string) => ({ url }), "/api/z": () => new Response("no", { status: 503 }) });
    expect(await (await fetch("/api/x")).json()).toEqual({ x: 1 });
    expect(await (await fetch("/api/y?n=2")).json()).toEqual({ url: "/api/y?n=2" });
    expect((await fetch("/api/z")).status).toBe(503);
    expect(f.stub.calls).toEqual(["GET /api/x", "GET /api/y?n=2", "GET /api/z"]);
  });

  it("rejects an unknown URL at once, naming it, and keeps it for the after-test check", async () => {
    const f = stubFetchByUrl({ "/api/x": {} });
    await expect(fetch("/api/nope", { method: "post" })).rejects.toThrow("no stub for POST /api/nope");
    // The after-test check in stub-fetch.ts would fail this test with the same words; take the miss so it passes.
    expect(f.stub.takeMisses()).toEqual(["POST /api/nope"]);
  });

  it("catches a page request the test forgot, even when the page handles the error (BOS-2425's case)", async () => {
    // Only the scorecard is stubbed; the Workflow page's "Latest retro" request has no answer.
    const card = { days: 14, costBasis: null, byRole: [], byAgent: [], handoffs: [], features: [], sizes: [], sizeNotes: [] };
    const f = stubFetchByUrl({ "/api/companies/c1/workflow": card });
    render(<Workflow company={{ id: "c1", name: "Acme" } as Company} />);
    await screen.findByText("Not enough finished tickets yet.");
    await waitFor(() => expect(f.stub.misses).toEqual(["GET /api/companies/c1/retros/latest"]));
    f.stub.takeMisses();
  });
});

describe("urlStub", () => {
  it("serves a browser test's http server and records misses", () => {
    const s = urlStub({ "/api/me": { username: "owner" } });
    expect(s.answer("/api/me")).toEqual({ found: true, body: { username: "owner" } });
    expect(s.answer("/api/new-thing?x=1", { method: "GET" })).toEqual({ found: false });
    expect(s.takeMisses()).toEqual(["GET /api/new-thing?x=1"]);
    expect(s.misses).toEqual([]);
  });
});
