// Every "Settings → …" the owner reads in server or shared code names a page that really exists (BOS-1019, from
// BOS-1018 §4). The path walker the owner-card lint uses already knows the 9 Settings pages (OWNER_TABS.Settings);
// this runs it over each such string, so rotating a page's name can't leave a card, notice or tool description
// sending the owner to a place that is gone. It also checks the first part is one of the pages itself, since a
// string such as "Settings → Reviews and CEO" would otherwise pass as an unknown heading.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OWNER_TABS } from "@boss-man/shared";
import { norm, screenFindings } from "../src/services/owner-screens.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DIRS = [join(ROOT, "apps/server/src"), join(ROOT, "packages/shared/src")];
const ARROW = /Settings\s*(?:→|->|›|>)\s*([A-Z][^,.:;"`()\n]{0,80})/g;
/** The pages under Settings, as the store knows them. */
const PAGES = new Set(OWNER_TABS.Settings.map(norm));
/** The old Settings tabs (BOS-442): a string that names one of these is stale, wherever it appears (BOS-1019). */
const RETIRED = ["server and runner", "access and funding", "reviews and ceo", "rules"];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

/** Each "Settings → …" in a file, as the words after it up to the end of the path ("Server and runner → Checks"). */
function pathsIn(src: string): string[] {
  return [...src.matchAll(ARROW)].map((m) => m[0]!.split(/Settings\s*(?:→|->|›|>)\s*/)[1]!.trim());
}

describe("every Settings path in server and shared code exists (BOS-1019)", () => {
  const files = DIRS.flatMap(sources);
  it("finds Settings paths to check (the scan works)", () => {
    const found = files.flatMap((f) => pathsIn(readFileSync(f, "utf8")));
    expect(found.length).toBeGreaterThan(50);
  });

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const paths = pathsIn(src);
    if (!paths.length) continue;
    const name = relative(ROOT, file);
    it(`${name} names real Settings pages`, () => {
      for (const p of paths) {
        const first = norm(p.split(/\s*(?:→|->|›|>)\s*/)[0]!).replace(/\s+(?:leads|names|panel|line|should|again|instead|is|are|must|has|does)\b.*$/, "");
        // A retired tab ("Access and funding", "Reviews and CEO") is stale text: name the new page instead.
        if (RETIRED.includes(first) && !PAGES.has(first)) {
          expect.fail(`"Settings → ${p}" names the retired tab "${first}". The pages now are: ${[...OWNER_TABS.Settings].join(", ")}`);
        }
        // The page part (the first part after Settings) through the walker: a known screen in the wrong place is
        // refused, so "Settings → Projects" can't slip through. Sections inside a page (Updates, Agent fence, …)
        // are the page's own headings, which the walker doesn't know, so only the page is checked here.
        const pagePart = p.split(/\s*(?:→|->|›|>)\s*/)[0]!.replace(/\s+(?:leads|names|panel|line|should|again|instead|and|is|are|must|has|does)\b.*$/, "");
        const { r8 } = screenFindings(`Open Settings → ${pagePart}.`, []);
        expect(r8, `"Settings → ${p}" in ${name}: ${r8.join("; ")}`).toEqual([]);
      }
    });
  }
});
