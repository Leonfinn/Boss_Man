import { afterEach, describe, expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { companies } from "../src/db/schema.js";
import { wikiService } from "../src/services/wiki.js";

// BOS-1552: a new page may not take a DR number another page already has.
const by = { agentId: null, runId: null };
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function setup() {
  const o = await openPglite();
  close = o.close;
  const [a] = await o.db.insert(companies).values({ name: "A Co" }).returning();
  const [b] = await o.db.insert(companies).values({ name: "B Co" }).returning();
  return { wiki: wikiService(o.db), a: a!.id, b: b!.id };
}

describe("decision-record numbers", () => {
  it("refuses a new page on a taken number, names the page and the next free number", async () => {
    const { wiki, a } = await setup();
    await wiki.write(a, { title: "DR-058: gate", folder: "Decisions", body: "x", ...by });
    await wiki.write(a, { title: "DR-059: wake classes", folder: "Decisions", body: "x", ...by });
    await expect(wiki.write(a, { title: "DR-059: something else", folder: "Decisions", body: "y", ...by })).rejects.toThrow(
      /DR-059 is already taken by "DR-059: wake classes" \(decisions\/dr-059-wake-classes\)\. The next free number is DR-060\./,
    );
    // By slug alone, with an unrelated title.
    await expect(wiki.write(a, { slug: "decisions/dr-058-other", title: "Other", body: "y", ...by })).rejects.toThrow(/DR-058 is already taken.*DR-060/);
  });

  it("allows an update to the same page, a free number, and the same number in another company", async () => {
    const { wiki, a, b } = await setup();
    const p = await wiki.write(a, { title: "DR-001: first", folder: "Decisions", body: "x", ...by });
    await wiki.write(a, { slug: p.page.slug, title: "DR-001: first", body: "x more", ...by });
    await wiki.write(a, { title: "DR-002: second", folder: "Decisions", body: "x", ...by });
    await wiki.write(b, { title: "DR-001: other company", folder: "Decisions", body: "x", ...by });
    // A longer number is a different number, and a page that merely mentions a DR is not a DR page.
    await wiki.write(a, { title: "DR-0010: tenth", body: "x", ...by });
    await wiki.write(a, { title: "Notes on DR-001", body: "x", ...by });
  });
});
