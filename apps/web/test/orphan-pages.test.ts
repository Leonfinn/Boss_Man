// Orphan-page guard (BOS-1054). BOS-1019 dropped the #/funding route: pages/Funding.tsx stayed in the code but nothing
// rendered it, so the owner lost the Funding status cards, and no test noticed. This test fails when a page file, or a
// component a page file exports, is not rendered by anything the app mounts (main.tsx → App.tsx's routes → the
// Settings panel map → the components those use). It names the file. See screen-scan.ts for how "rendered" is read.
import { describe, expect, it } from "vitest";
import { SRC, closure, findChunk, parse, rel, renderedFromApp, walk, type Chunk } from "./screen-scan";
import { join } from "node:path";

// Files and exports that are on purpose not rendered by the app. Each entry says why. Keep this list short: a page that
// nothing shows is the bug this test exists to catch, so "we'll wire it up later" is not a reason.
const ALLOWED: Record<string, string> = {
  // "pages/Example.tsx": "why it is not rendered",
  // "pages/Example.tsx#Name": "why this export is not rendered",
};

// A component is an exported name that starts with a capital and has a lowercase letter (not an ALL_CAPS constant).
const isComponent = (c: Chunk) => c.exported && /^[A-Z]/.test(c.name) && /[a-z]/.test(c.name);

export function orphans(): string[] {
  const rendered = renderedFromApp();
  const problems: string[] = [];
  for (const file of walk(join(SRC, "pages")).filter((f) => /\.tsx?$/.test(f))) {
    const key = `pages/${rel(file).replace(/^pages\//, "")}`;
    if (ALLOWED[key]) continue;
    const chunks = [...parse(file).chunks.values()];
    if (!chunks.some((c) => rendered.has(`${c.file}#${c.name}`))) {
      problems.push(`${key}: nothing the app renders uses this file`);
      continue;
    }
    for (const c of chunks.filter(isComponent)) {
      if (!rendered.has(`${c.file}#${c.name}`) && !ALLOWED[`${key}#${c.name}`]) problems.push(`${key}: ${c.name} is exported but nothing the app renders uses it`);
    }
  }
  return problems;
}

describe("orphan pages", () => {
  it("renders every page file, and every component a page file exports, from App.tsx", () => {
    expect(orphans(), "These page files are not reachable from App.tsx's routes or the Settings panel map. Render them, delete them, or list them in ALLOWED with the reason.").toEqual([]);
  });

  it("has an allow-list with a reason on every entry and no entry for a file that is gone", () => {
    for (const [k, why] of Object.entries(ALLOWED)) {
      expect(why.trim(), k).not.toBe("");
      const [file, name] = k.split("#");
      const abs = join(SRC, file!);
      expect(parse(abs).chunks.size, `${k} no longer exists`).toBeGreaterThan(0);
      if (name) expect(findChunk(abs, name), `${k} no longer exists`).not.toBeNull();
    }
  });

  it("sees the mount: the app's tree reaches App, Settings and the Funding panels", () => {
    const rendered = renderedFromApp();
    for (const k of ["App.tsx#App", "pages/Settings.tsx#Settings", "pages/Funding.tsx#FundingCards", "pages/Funding.tsx#BudgetLimits"]) {
      expect(rendered.has(join(SRC, k.split("#")[0]!) + "#" + k.split("#")[1]), k).toBe(true);
    }
  });

  it("catches a page nothing renders (the BOS-1019 mistake)", () => {
    // Pretend App.tsx and Settings.tsx stopped using Funding.tsx: the closure without those uses must not reach it.
    const funding = join(SRC, "pages", "Funding.tsx");
    const settings = findChunk(join(SRC, "pages", "Settings.tsx"), "Settings")!;
    const without: Chunk = { ...settings, body: settings.body.replace(/<FundingCards\s*\/>/, "").replace(/<BudgetLimits[^>]*\/>/, "") };
    const reached = new Set(closure([without]).map((c) => `${c.file}#${c.name}`));
    expect(reached.has(`${funding}#FundingCards`)).toBe(false);
    expect(reached.has(`${funding}#BudgetLimits`)).toBe(false);
  });
});
