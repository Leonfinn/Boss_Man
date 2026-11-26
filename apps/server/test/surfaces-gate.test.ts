// BOS-2733: the pure rule behind the "Surfaces:" line at the move to review.
import { describe, expect, it } from "vitest";
import { OWNER_CARD_FILES, ownerFacingFiles, SURFACES_MAX, surfacesProblem, surfacesRefusal } from "../src/services/surfaces-gate.js";

const files = (...paths: string[]) => ({ files: paths.map((path) => ({ path, added: 1, removed: 0 })) });

describe("ownerFacingFiles", () => {
  it("counts non-test files under apps/web/src and the named server card files", () => {
    expect(ownerFacingFiles(files("apps/web/src/pages/Board.tsx", "apps/web/src/styles.css", "apps/web/src/api.ts", OWNER_CARD_FILES[0]!))).toEqual(["apps/web/src/pages/Board.tsx", "apps/web/src/styles.css", "apps/web/src/api.ts", OWNER_CARD_FILES[0]]);
  });
  it("leaves tests and other code alone", () => {
    expect(ownerFacingFiles(files("apps/web/test/board.test.tsx", "apps/web/src/pages/Board.test.tsx", "apps/server/src/services/scheduler.ts", "apps/server/test/owner-todo.test.ts", "docs/01-intro.md"))).toEqual([]);
  });
});

describe("surfacesProblem and surfacesRefusal", () => {
  it("wants a real, one-line list", () => {
    expect(surfacesProblem("ok")).toMatch(/at least 10/);
    expect(surfacesProblem("Board card\nTicket page")).toMatch(/one line/);
    expect(surfacesProblem("Board card, Ticket page")).toBeNull();
    expect(SURFACES_MAX).toBe(300);
  });
  it("names the files and the field to add", () => {
    const out = surfacesRefusal(["a", "b", "c", "d", "e", "f", "g"]);
    expect(out).toContain("a, b, c, d, e and 2 more");
    expect(out).toContain("surfaces:");
  });
});
