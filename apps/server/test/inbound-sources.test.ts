// BOS-1933 (R53): every outside source Boss Man watches names who acts on an item and who closes it at the source,
// and the closer is never the owner. The test reads the watchers' code, so a new source can't ship without its row.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOTE_SOURCES } from "@boss-man/shared";
import { INBOUND_SOURCES, NOTE_SOURCE_CLASS, type InboundSource } from "../src/services/inbound-sources.js";

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}
const ALL = files(SRC).map((p) => ({ rel: p.slice(SRC.length + 1), text: readFileSync(p, "utf8") }));
const TOOLS = new Set(ALL.flatMap((f) => [...f.text.matchAll(/registerTool\(\s*"([a-z_]+)"/g)].map((m) => m[1]!)));

/** The problems with a list of rows; empty when every rule holds. Kept as a function so the rules can be shown failing on a broken copy. */
function problems(rows: readonly InboundSource[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const closer = String(r.closer ?? "");
    if (!closer) out.push(`${r.id}: no closer`);
    if (/owner/i.test(closer) || /owner/i.test(String(r.actor ?? ""))) out.push(`${r.id}: the owner acts or closes; name an agent role or Boss Man`);
    if (!r.closesAt?.trim()) out.push(`${r.id}: no closesAt (how it closes where it came from)`);
    if (r.closeTool === null ? !r.closedBy : !TOOLS.has(r.closeTool)) out.push(`${r.id}: closeTool ${r.closeTool} is not a registered MCP tool (or closedBy is missing)`);
    if (r.closedBy && !ALL.some((f) => f.rel === r.closedBy)) out.push(`${r.id}: closedBy ${r.closedBy} doesn't exist`);
    if (!ALL.some((f) => f.rel === r.watcher)) out.push(`${r.id}: watcher ${r.watcher} doesn't exist`);
  }
  const ids = rows.map((r) => r.id);
  if (new Set(ids).size !== ids.length) out.push("two rows share an id");
  return out;
}

describe("inbound sources (BOS-1933)", () => {
  it("every row names an actor and a closer, never the owner, and a closing tool that exists", () => {
    expect(problems(INBOUND_SOURCES)).toEqual([]);
  });

  it("fails when a closer is removed or set to the owner (the rule shown failing)", () => {
    const [first, ...rest] = INBOUND_SOURCES;
    expect(problems([{ ...first!, closer: "" as never }, ...rest])).toContain(`${first!.id}: no closer`);
    expect(problems([{ ...first!, closer: "owner" as never }, ...rest]).join("\n")).toContain("the owner acts or closes");
    expect(problems([{ ...first!, closeTool: "no_such_tool" }, ...rest]).join("\n")).toContain("not a registered MCP tool");
  });

  it("every item kind the GitHub watcher files has a row", () => {
    const watch = read("services/github-watch.ts");
    const kinds = new Set([...watch.matchAll(/github:\$\{repo\.toLowerCase\(\)\}:([a-z-]+):/g)].map((m) => m[1]!));
    expect([...kinds].sort()).toEqual(["discussion", "discussion-comment", "issue", "issue-comment"]);
    const alertKinds = new Set([...watch.matchAll(/const key = `([a-z]+):\$\{n\}`/g)].map((m) => m[1]!));
    expect([...alertKinds].sort()).toEqual(["dependabot", "secret"]);
    for (const k of kinds) expect(INBOUND_SOURCES.some((r) => "externalIdKind" in r.match && r.match.externalIdKind === k), `no row for GitHub ${k}`).toBe(true);
    for (const k of alertKinds) expect(INBOUND_SOURCES.some((r) => "alertKind" in r.match && r.match.alertKind === k), `no row for the ${k} alert`).toBe(true);
  });

  it("every file that files outside items is a row's watcher", () => {
    // Writers of outside notes (createExternalNote, or an untrusted portal note) and the watchers that open tickets from GitHub.
    const writers = ALL.filter((f) => /\.createExternalNote\(/.test(f.text)).map((f) => f.rel);
    const portal = ALL.filter((f) => /source: "portal"/.test(f.text)).map((f) => f.rel);
    const watchers = new Set(INBOUND_SOURCES.map((r) => r.watcher));
    for (const w of [...writers, ...portal]) expect(watchers.has(w), `${w} files outside items but no row names it as a watcher`).toBe(true);
    expect(writers).toContain("services/github-watch.ts");
    expect(portal).toContain("services/feedback.ts");
  });

  it("every note source is classed, and an outside one points at rows that exist", () => {
    expect(Object.keys(NOTE_SOURCE_CLASS).sort()).toEqual([...NOTE_SOURCES].sort());
    for (const [src, c] of Object.entries(NOTE_SOURCE_CLASS)) {
      if (c.from === "outside") for (const id of c.rows) expect(INBOUND_SOURCES.some((r) => r.id === id), `${src}: no row ${id}`).toBe(true);
    }
    // "email" is classed inside because no code writes it; a writer must move it to outside with a row.
    expect(ALL.some((f) => /source: "email"/.test(f.text))).toBe(false);
  });

  it("GitHub issues and discussions are closed by Support with github_reply", () => {
    for (const id of ["github-issue", "github-issue-comment", "github-discussion", "github-discussion-comment"]) {
      const r = INBOUND_SOURCES.find((x) => x.id === id)!;
      expect(r.closer).toBe("support");
      expect(r.closeTool).toBe("github_reply");
    }
  });
});
