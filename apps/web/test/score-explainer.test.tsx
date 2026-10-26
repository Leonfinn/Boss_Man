// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ScoreExplainer } from "../src/pages/Features";

afterEach(cleanup);

describe("how the score is worked out", () => {
  it("works the sum through with the company's own weights", () => {
    render(<ScoreExplainer demandWeight={2} drivers={[{ name: "SEO", weight: 5 }, { name: "Usability", weight: 3 }, { name: "Accuracy", weight: 4 }]} />);
    fireEvent.click(screen.getByText("How the score is worked out"));
    // 0×2 + 4×5 + 2×3 + 5×4 = 46 over 2+5+3+4 = 14.
    expect(screen.getByText(/Value = 46 ÷ 14 =/).textContent).toContain("Value = 46 ÷ 14 = 3.29. Sized as effort 2: priority = 3.29 × 3 ÷ 2 = 4.93");
  });
});
