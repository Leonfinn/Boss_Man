// BOS-1227 (941c), the skew rule, server side: a server one release newer than the launcher (the updater moves the server first, the
// launcher after soak) may only call what the previous launcher serves, or a call listed below as optional (it tolerates a 404).
// The previous release's surface is a recorded fixture in the launcher package (apps/launcher/test/fixtures/launcher-api-previous.json),
// replaced at each release; the launcher's own test (apps/launcher/test/launcher-skew.test.ts) keeps the other direction.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(here, "../../launcher/test/fixtures/launcher-api-previous.json"), "utf8")) as { routes: { method: string; path: string }[] };
const source = readFileSync(path.join(here, "../src/services/launcher.ts"), "utf8");

/** Calls the server makes that the previous launcher does not serve, each with the reason it is safe. Empty today. */
const OPTIONAL_NEW_CALLS: string[] = [];

/** Every `call("METHOD", "/path")` in the server's launcher service, with template holes written as :slug. */
function serverCalls(): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\bcall(?:<[^(]*?>)?\(\s*"([A-Z]+)",\s*(`[^`]*`|"[^"]*")/g)) {
    const p = m[2]!.slice(1, -1).replace(/\$\{[^}]*\}/g, ":slug");
    out.add(`${m[1]} ${p}`);
  }
  return [...out].sort();
}

describe("the skew rule: server N against launcher N-1 (BOS-1227)", () => {
  it("finds the server's launcher calls (the extraction itself works)", () => {
    expect(serverCalls().length).toBeGreaterThanOrEqual(10);
    expect(serverCalls()).toContain("GET /runners");
    expect(serverCalls()).toContain("PUT /runners/:slug/allow");
  });
  it("every call the server makes is served by the previous launcher, or is listed as optional", () => {
    const served = new Set(fixture.routes.map((r) => `${r.method} ${r.path}`));
    const missing = serverCalls().filter((c) => !served.has(c) && !OPTIONAL_NEW_CALLS.includes(c));
    expect(missing, `The server now calls ${missing.join(", ")}, which the previous launcher does not serve. Make the call tolerate a 404 and list it in OPTIONAL_NEW_CALLS with the reason, or keep it out of this release.`).toEqual([]);
  });
});
