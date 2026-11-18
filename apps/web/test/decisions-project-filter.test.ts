import { describe, expect, it } from "vitest";
import { COMPANY_WIDE, cardProjects, inProjectFilter } from "../src/pages/Decisions";

// BOS-1744: each card names its project(s); the page filters by project id or "company-wide".
const dev = { id: "p-dev", name: "Development" };
const site = { id: "p-site", name: "Website" };

describe("project filter", () => {
  it("shows every card under All projects", () => {
    for (const projects of [[], [dev], [dev, site], undefined]) expect(inProjectFilter({ projects }, null)).toBe(true);
  });

  it("shows a card under its project, and a multi-project card under each", () => {
    expect(inProjectFilter({ projects: [dev] }, "p-dev")).toBe(true);
    expect(inProjectFilter({ projects: [dev] }, "p-site")).toBe(false);
    expect(inProjectFilter({ projects: [dev, site] }, "p-dev")).toBe(true);
    expect(inProjectFilter({ projects: [dev, site] }, "p-site")).toBe(true);
  });

  it("treats a card with no project as company-wide, also from an older server", () => {
    expect(inProjectFilter({ projects: [] }, COMPANY_WIDE)).toBe(true);
    expect(inProjectFilter({}, COMPANY_WIDE)).toBe(true);
    expect(inProjectFilter({ projects: [dev] }, COMPANY_WIDE)).toBe(false);
    expect(cardProjects({})).toEqual([]);
  });
});
