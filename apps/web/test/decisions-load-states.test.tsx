import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Company } from "../src/api";
import { Decisions } from "../src/pages/Decisions";

// BOS-1976: before the first load the Decisions page shows a loader, after a failed load a plain
// error, and neither looks like the "Nothing needs you" empty state.

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };

function render(loaded: boolean, loadError: boolean): string {
  return renderToStaticMarkup(
    <Decisions decisions={[]} companies={[company]} loaded={loaded} loadError={loadError} agentsWorking={0} onAnswered={() => {}} />,
  );
}

describe("Decisions load states", () => {
  it("shows the loader before the first load", () => {
    const html = render(false, false);
    // The Loader prints its words only after its first second, so check for the loader itself.
    expect(html).toContain('class="loader"');
    expect(html).not.toContain("Nothing needs you");
    expect(html).not.toContain("Couldn&#x27;t load your decisions");
  });

  it("shows an alert when the load failed", () => {
    const html = render(false, true);
    expect(html).toContain('role="alert"');
    expect(html).toMatch(/Couldn(&#x27;|')t load your decisions\. It will try again shortly\./);
    expect(html).not.toContain('class="loader"');
    expect(html).not.toContain("Nothing needs you");
  });

  it("shows the empty state once loaded", () => {
    const html = render(true, false);
    expect(html).toContain("Nothing needs you");
    expect(html).not.toContain('class="loader"');
  });
});
