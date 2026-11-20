// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NoCompany } from "../src/components/NoCompany";

afterEach(cleanup);

describe("NoCompany (BOS-1972)", () => {
  it("links 'Create your first company' to the Board page", () => {
    const { container } = render(<NoCompany />);
    const a = container.querySelector("a");
    expect(a?.getAttribute("href")).toBe("#/board");
    expect(a?.textContent).toBe("Create your first company");
    expect(container.textContent).toBe("You don't have a company yet. Create your first company.");
    expect(container.textContent).not.toMatch(/Kanban/);
  });
  it("keeps an alternative after the link (Settings)", () => {
    const { container } = render(
      <NoCompany>
        , or <button type="button">run the setup wizard</button>.
      </NoCompany>,
    );
    expect(container.querySelector("a")?.getAttribute("href")).toBe("#/board");
    expect(container.querySelector("button")?.textContent).toBe("run the setup wizard");
  });
});
