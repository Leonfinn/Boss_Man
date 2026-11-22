// BOS-2147 (background lane): which ticket files touch a GitHub-only red's scope (R40). Pure, no database
// and no clock: the file list and the scope are passed in.
import { describe, expect, it } from "vitest";
import { touchesScope } from "../src/services/review-holds.js";

describe("touchesScope", () => {
  it("touches a red when a file sits inside a folder scope", () => {
    expect(touchesScope(["apps/server/src/services/a.ts"], ["apps/server/src/services/"])).toBe(true);
  });

  it("touches a red when a file is exactly a named path", () => {
    expect(touchesScope(["packages/shared/src/risk.ts"], ["packages/shared/src/risk.ts"])).toBe(true);
  });

  it("does not touch a red when every file is outside the scope", () => {
    expect(touchesScope(["apps/web/src/page.tsx", "apps/server/test/x.test.ts"], ["packages/shared/src/"])).toBe(false);
  });

  it("touches a red when only one of several files is inside the scope", () => {
    expect(touchesScope(["apps/web/src/page.tsx", "packages/shared/src/risk.ts"], ["packages/shared/src/"])).toBe(true);
  });

  it("does not touch anything with no files", () => {
    expect(touchesScope([], ["packages/shared/src/"])).toBe(false);
  });

  it("counts an unknown file list as touching every red", () => {
    expect(touchesScope(null, ["packages/shared/src/"])).toBe(true);
  });

  it("touches every red when a change is CI config", () => {
    expect(touchesScope([".github/workflows/check.yml"], ["packages/shared/src/"])).toBe(true);
  });

  it("touches every red when a change is a file at the repo root", () => {
    expect(touchesScope(["pnpm-lock.yaml"], ["packages/shared/src/"])).toBe(true);
    expect(touchesScope(["package.json"], [])).toBe(true);
  });

  it("does not treat a same-named sibling as inside a folder scope", () => {
    expect(touchesScope(["apps/server/src/services/other.ts"], ["apps/server/src/services/a.ts"])).toBe(false);
  });
});
