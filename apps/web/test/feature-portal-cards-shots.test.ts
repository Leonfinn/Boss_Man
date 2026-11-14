// Proof shots for BOS-1358: the Roadmap showing a newly created feature (nobody placed it), and the
// owner's card for a feature held off the feedback portal, with its Keep off / Publish choice.
// Skipped, not failed, where no browser or Vite is installed (the runner and CI have both).
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, it } from "vitest";
import { API, launch, startVite, stubApi } from "./real-page";

const now = new Date().toISOString();

const feature = (id: string, title: string, column: string) => ({
  id,
  title,
  status: column === "now" ? "in_progress" : column === "next" ? "planned" : "idea",
  rank: null,
  horizon: null,
  column,
  priority: 2.4,
  releasedAt: null,
  objective: null,
  publicSummary: null,
  showPublicly: false,
  tickets: { total: 0, done: 0 },
  milestones: [],
});
const roadmapFeatures = [{ id: "c1", name: "Boss Man Co", features: [feature("f1", "Dark mode", "later"), feature("f2", "Export a report", "next")] }];

const heldCard = {
  id: "d1",
  companyId: "c1",
  kind: "question",
  question: 'The feature "Rotate API keys" is held off the feedback portal: it reads as security work.\n\nKeep it off, or publish it to the portal?\n\nPublishing needs a public summary first: visitors see that, never the internal title. The CEO or a product manager can write one; until then a feature set to publish stays hidden.',
  options: ["Keep off the portal", "Publish"],
  recommendedOption: "Keep off the portal",
  tier: "owner",
  createdAt: now,
  companyName: "Boss Man Co",
  agentName: null,
  blocks: [],
  score: 0,
  parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  context: { type: "feature_portal_hold" },
};

const api: Record<string, unknown> = {
  ...API,
  "/api/roadmap/features": roadmapFeatures,
  "/api/roadmap": [{ id: "c1", name: "Boss Man Co", objectives: [] }],
  "/api/decisions": [heldCard],
  "/api/decisions/tally": { owner: 1, ceo: 0, waiting: 0, total: 1 },
};

const browser = await launch();
const vite = browser ? await startVite() : null;
const can = !!(browser && vite);
afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

const out = process.env.BOSSMAN_SCRATCH;
const saveShot = async (name: string, page: any) => {
  if (!out) return;
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: path.join(out, name), fullPage: true });
};

async function open(hash: string, wait: string) {
  const page = (await browser!.newPage({ viewport: { width: 1550, height: 1000 }, hasTouch: false })) as any;
  await stubApi(page, api);
  await page.goto(`${vite!.resolvedUrls.local[0]}${hash}`, { waitUntil: "networkidle" });
  await page.waitForSelector(wait, { timeout: 15_000 });
  await page.waitForTimeout(400);
  return page;
}

describe.skipIf(!can)("held-off-portal proof shots (BOS-1358)", () => {
  it.skipIf(!out)("the Roadmap shows a new feature without anyone placing it", async () => {
    const page = await open("#/roadmap/features", "text=Dark mode");
    await saveShot("bos1358-roadmap-new-feature.png", page);
    await page.close();
  }, 60_000);

  it.skipIf(!out)("the held-off feature card with Keep off / Publish", async () => {
    const page = await open("#/decisions", "text=Rotate API keys");
    await saveShot("bos1358-held-off-card.png", page);
    await page.close();
  }, 60_000);
});
