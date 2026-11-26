// BOS-2709: a Boss Man word on an owner screen must come with its meaning from the shared owner terms list.
// "points" stood on the Roadmap with no explanation (26 Nov). This renders the real Roadmap milestone rows and
// fails, naming the word and the screen, when a listed word is on screen and its meaning is not.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OWNER_TERMS, ownerTermsIn, type OwnerTerm } from "@boss-man/shared";
import type { RoadmapMilestone } from "../src/api";
import { MilestoneRows } from "../src/pages/RoadmapRows";

const plain = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

/** The listed words a screen shows whose meaning is not on it, as "Screen: word" lines. */
export function unexplained(screen: string, html: string, terms: readonly OwnerTerm[] = OWNER_TERMS): string[] {
  const text = plain(html);
  return terms.filter((t) => ownerTermsIn(text).includes(t) && !text.includes(t.meaning)).map((t) => `${screen}: "${t.term}" is on screen with no meaning from the owner terms list`);
}

const ms: RoadmapMilestone = {
  id: "m1", title: "Beta", targetDate: "2026-12-04", total: 4, done: 2, blocked: 0, active: 1, status: "on_track", horizon: "now", pinned: null,
  forecast: { pointsDone: 21, pointsLeft: 13, unsized: 2, pace: 3, expectedFinish: "2026-12-02", daysLate: 0 },
} as RoadmapMilestone;

const roadmap = renderToStaticMarkup(
  <MilestoneRows ms={[ms]} range={{ start: Date.parse("2026-11-01"), end: Date.parse("2026-12-31") }} now="2026-11-24" selected="m1" onSelect={() => {}} detail={() => null} />,
);

describe("Roadmap milestone rows", () => {
  it("shows points, no size and pace, each with its meaning from the list", () => {
    const text = plain(roadmap);
    expect(text).toContain("13 points left");
    expect(text).toContain("2 tickets have no size");
    for (const id of ["points", "no-size", "pace"]) expect(text).toContain(OWNER_TERMS.find((t) => t.id === id)!.meaning);
    expect(unexplained("Roadmap", roadmap)).toEqual([]);
  });

  it("names the word and the screen when a listed word has no meaning on screen", () => {
    const without = roadmap.split(OWNER_TERMS.find((t) => t.id === "points")!.meaning).join("");
    expect(unexplained("Roadmap", without)).toEqual(['Roadmap: "Points" is on screen with no meaning from the owner terms list']);
  });
});
