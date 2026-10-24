// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageGuard } from "../src/App";

afterEach(cleanup);

describe("page guard", () => {
  it("shows the error instead of a blank app, and can try again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    const Page = () => {
      if (broken) throw new TypeError("x is undefined");
      return <p>Chat works</p>;
    };
    render(
      <PageGuard>
        <Page />
      </PageGuard>,
    );
    expect(screen.getByRole("alert").textContent).toContain("TypeError: x is undefined");
    // The component stack names where it broke, so a screenshot is enough to find it.
    expect(screen.getByRole("alert").textContent).toMatch(/In:\s*at Page/);
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Chat works")).toBeTruthy();
  });
});
