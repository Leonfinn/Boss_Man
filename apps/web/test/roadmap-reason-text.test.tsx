import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReasonText } from "../src/pages/RoadmapRows";

describe("ReasonText (BOS-2579)", () => {
  it("links each named reference, and BOS-12 never links inside BOS-123", () => {
    const html = renderToStaticMarkup(
      <ReasonText text="At risk: BOS-123, BOS-12 and BOS-1234 look stuck." tickets={[{ ref: "BOS-12", id: "id-12" }, { ref: "BOS-123", id: "id-123" }]} />,
    );
    expect(html).toContain('<a href="#/tickets/id-123">BOS-123</a>');
    expect(html).toContain('<a href="#/tickets/id-12">BOS-12</a>');
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html).toContain("BOS-1234");
  });

  it("is plain text when no ticket is named", () => {
    expect(renderToStaticMarkup(<ReasonText text="All built and live." tickets={[]} />)).toBe("All built and live.");
  });
});
