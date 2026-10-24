// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Avatar, portraitOf } from "../src/components/Avatar";

afterEach(cleanup);

describe("agent avatars", () => {
  const a = { id: "a1", name: "Ada Lovelace", role: "worker" };
  it("prefers an upload, then Boss Man for the CEO, then the template's or duty's portrait", () => {
    expect(portraitOf({ ...a, template: "qa", avatarAt: "2026-10-23T17:00:00Z" })).toBe(`/api/agents/a1/avatar?v=${Date.parse("2026-10-23T17:00:00Z")}`);
    expect(portraitOf({ ...a, role: "ceo" })).toMatch(/boss-mark-64/);
    expect(portraitOf({ ...a, template: "senior-infra" })).toMatch(/senior-infra/);
    expect(portraitOf({ ...a, duty: "wiki" })).toMatch(/wiki/);
    expect(portraitOf({ ...a, template: "made-up" })).toBeNull();
  });
  it("falls back to initials", () => {
    const { container } = render(<Avatar agent={a} />);
    expect(container.textContent).toBe("AL");
    expect(container.querySelector("img")).toBeNull();
  });
});
