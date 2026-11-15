import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";

// BOS-1497: with a card to answer, the "Finish setting up" banner comes after the cards and is asked
// for in its folded form; with no cards it comes first, unfolded, as before.

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };

const card: Decision = {
  id: "d1",
  companyId: "c1",
  kind: "question",
  question: "Which colour should the button be?",
  options: ["Blue", "Green"],
  recommendedOption: "Blue",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "Boss Man Co",
  agentName: null,
  blocks: [],
  score: 10,
  parts: { blocking: 0, urgency: 0, age: 10, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  context: null,
} as Decision;

const render = (decisions: Decision[]) =>
  renderToStaticMarkup(
    <Decisions
      decisions={decisions}
      companies={[company]}
      loaded
      agentsWorking={0}
      onAnswered={() => {}}
      banner={(folded: boolean) => <div data-banner={folded ? "folded" : "open"}>BANNER</div>}
    />,
  );

describe("Decisions: setup banner position (BOS-1497)", () => {
  it("with one card to answer, the card comes first and the banner is folded after it", () => {
    const html = render([card]);
    expect(html).toContain('data-banner="folded"');
    expect(html).not.toContain('data-banner="open"');
    expect(html.indexOf("Which colour should the button be?")).toBeLessThan(html.indexOf('data-banner="folded"'));
  });

  it("with no cards, the banner shows unfolded at the top as before", () => {
    const html = render([]);
    expect(html).toContain('data-banner="open"');
    expect(html).not.toContain('data-banner="folded"');
  });
});
