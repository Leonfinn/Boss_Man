import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, plainStatus } from "../src/api";
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

describe("plainStatus", () => {
  it.each([502, 503, 504])("says a %i is a restart or version switch, so try the button again", (status) => {
    expect(plainStatus(status)).toMatch(/restarting or switching versions/);
    expect(plainStatus(status)).toMatch(/press the button again/);
  });

  it("says a closed card needs nothing more only when the server says not_open", () => {
    expect(plainStatus(404, "not_open")).toBe("This card was already closed, so there is nothing more to do here.");
    expect(plainStatus(404, "not_found")).toBe("That item no longer exists. Reload the page.");
    expect(plainStatus(404)).not.toMatch(/already closed/);
  });

  it("says the owner was signed out on a 401", () => {
    expect(plainStatus(401)).toBe("You have been signed out. Sign in again, then repeat that.");
    expect(plainStatus(401, "not_found")).toBe("You have been signed out. Sign in again, then repeat that.");
  });

  it.each([
    ["not_found", "That item no longer exists. Reload the page."],
    ["already_exists", "Something with that name already exists."],
    ["unknown_reference", "Something this refers to has been removed. Reload and try again."],
    ["constraint_violated", "That change clashes with existing data, so it wasn't saved."],
    ["internal_error", "Something went wrong on the server. Try again; if it keeps happening, tell the CEO."],
  ])("turns the %s code into a sentence", (code, sentence) => {
    expect(plainStatus(500, code)).toBe(sentence);
  });

  it("keeps a string the server sent that is not one of its codes", () => {
    expect(plainStatus(422, "Pick one.")).toBe("Pick one.");
  });

  it("falls back to a generic line with the code for an unlisted number", () => {
    expect(plainStatus(418)).toBe("Something went wrong (code 418). Nothing needs doing from you; try again, and tell the CEO if it keeps happening.");
  });

  it("falls back to the generic line for an empty or non-text error", () => {
    const generic = "Something went wrong (code 500). Nothing needs doing from you; try again, and tell the CEO if it keeps happening.";
    expect(plainStatus(500)).toBe(generic);
    expect(plainStatus(500, "")).toBe(generic);
    expect(plainStatus(500, { error: "not_found" })).toBe(generic);
    expect(plainStatus(500, null)).toBe(generic);
  });
});
