import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/api";
import { resetServerWatch } from "../src/server-watch";

afterEach(() => {
  vi.unstubAllGlobals();
  resetServerWatch();
});
const reply = (status: number, body: string) => vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status })));
const failure = async () => (await api("/api/decisions/x/answer", { method: "POST", body: {} }).catch((e) => e)) as ApiError;

describe("plain error messages (BOS-342)", () => {
  it("never shows 'HTTP 503' when the front door answers with an empty body", async () => {
    reply(503, "");
    const e = await failure();
    expect(e.status).toBe(503);
    expect(e.message).not.toMatch(/HTTP/);
    expect(e.message).toMatch(/press the button again/);
  });

  it("copes with a proxy's HTML error page", async () => {
    reply(502, "<html>Bad gateway</html>");
    expect((await failure()).message).toMatch(/restarting or switching versions/);
  });

  it("says a closed card needs nothing more", async () => {
    reply(404, JSON.stringify({ error: "not_open" }));
    expect((await failure()).message).toMatch(/already closed/);
  });

  it.each([
    [404, "not_found", /no longer exists/],
    [409, "already_exists", /already exists/],
    [409, "unknown_reference", /has been removed/],
    [409, "constraint_violated", /clashes with existing data/],
    [500, "internal_error", /Something went wrong on the server/],
  ])("turns %i %s into a sentence", async (status, code, sentence) => {
    reply(status, JSON.stringify({ error: code }));
    const e = await failure();
    expect(e.message).toMatch(sentence);
    expect(e.message).not.toContain(code);
  });

  it("falls back to the generic line for an empty error", async () => {
    reply(500, JSON.stringify({}));
    expect((await failure()).message).toMatch(/Something went wrong \(code 500\)/);
  });

  it("keeps the server's own message over a known code", async () => {
    reply(404, JSON.stringify({ error: "not_found", message: "No such ticket." }));
    expect((await failure()).message).toBe("No such ticket.");
  });

  it("keeps the server's own message", async () => {
    reply(422, JSON.stringify({ error: "invalid_answer", message: "Pick one." }));
    expect((await failure()).message).toBe("Pick one.");
  });
});
