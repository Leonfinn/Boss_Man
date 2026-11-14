// Throwaway seed for BOS-779 screenshots: a made-up website project (Soo's sample data, BOS-778), never real data.
// Run from apps/server: DEMO_PASSWORD=<throwaway> node_modules/.bin/tsx <this file> <new, empty PGlite folder>
const W = new URL("../../../../apps/server/src", import.meta.url).pathname;
const { openPglite } = await import(`${W}/db/client.ts`);
const schema = await import(`${W}/db/schema.ts`);
const { hashPassword } = await import(`${W}/auth.ts`);
const { workService } = await import(`${W}/services/work.ts`);

const pw = process.env.DEMO_PASSWORD;
if (!pw) throw new Error("set DEMO_PASSWORD to a throwaway value");
const { db, close } = await openPglite(process.argv[2]);
await db.insert(schema.owners).values({ username: "demo", passwordHash: await hashPassword(pw) });
const [co] = await db.insert(schema.companies).values({ name: "Fernleaf", mission: "Build and run the Fernleaf website: docs, blog and sign-up.", ticketPrefix: "FERN" }).returning();
const agent = async (name: string, role: "ceo" | "manager" | "worker", template: string, title: string) =>
  (await db.insert(schema.agents).values({ companyId: co.id, name, role, agentKind: "claude", model: "claude-sonnet-5-5", template, title }).returning())[0];
const ceo = await agent("Marta - CEO", "ceo", "ceo", "CEO");
const pm = await agent("Priya - Product Manager", "worker", "product-manager", "Product Manager");
const dev = await agent("Iris - Developer", "worker", "engineer", "Developer");
const sen = await agent("Owen - Senior Developer", "worker", "senior-dev", "Senior Developer");
const des = await agent("Juno - Designer", "worker", "designer", "Product Designer");
const qa = await agent("Felix - QA", "worker", "qa", "QA Engineer");
const wri = await agent("Hana - Writer", "worker", "writer", "Writer");

// The roadmap: one objective with two dated milestones, and the features under it.
const [obj] = await db.insert(schema.objectives).values({ companyId: co.id, title: "Twice as many sign-ups by spring", priority: 1 }).returning();
const [msDocs] = await db.insert(schema.milestones).values({ objectiveId: obj.id, title: "Docs relaunch", targetDate: "2026-12-04" }).returning();
const [msFast] = await db.insert(schema.milestones).values({ objectiveId: obj.id, title: "Fast on every phone", targetDate: "2027-01-29" }).returning();
const [drv] = await db.insert(schema.featureDrivers).values({ companyId: co.id, name: "Helps sign-ups", weight: 1 }).returning();
await db.insert(schema.feedbackSettings).values({ companyId: co.id, demandWeight: 3, portalEnabled: true, portalToken: "fernleafDemoPortalToken779abcdef", portalTitle: "Fernleaf: what's next", portalIntro: "Vote for what you want next, or suggest something new." });
const F: Record<string, any> = {};
const feat = async (key: string, title: string, description: string, status: string, effort: number, score: number, extra: any = {}) => {
  F[key] = (await db.insert(schema.features).values({ companyId: co.id, title, description, status: status as any, effort, driverScores: { [drv.id]: score }, ...extra }).returning())[0];
};
await feat("fast", "Faster home page", "The home page loads in under a second on a phone.", "in_progress", 2, 5, { milestoneId: msFast.id, horizon: "now" });
await feat("log", "Changelog page", "One page listing what changed on the site and when.", "in_progress", 1, 3, { milestoneId: msDocs.id, horizon: "now", portalVisible: true });
await feat("search", "Docs search", "Search every docs page from the top bar.", "planned", 3, 4, { milestoneId: msDocs.id, horizon: "next", portalVisible: true });
await feat("signup", "Sign-up that works on phones", "The sign-up form fits and submits on small screens.", "planned", 1, 5, { milestoneId: msFast.id, horizon: "next" });
await feat("dark", "Dark mode", "A dark theme for the docs and blog.", "considering", 1, 2, { horizon: "later", portalVisible: true });
await feat("rss", "Blog RSS feed", "Follow the blog in a feed reader.", "idea", 1, 1, { horizon: "later", portalVisible: true });
await feat("priv", "Privacy page", "What the site collects, in plain words.", "released", 1, 3, { objectiveId: obj.id, releasedAt: new Date(Date.now() - 9 * 86_400_000), portalVisible: true });

// Feedback: notes from made-up people, with passages linked to features.
const people = ["Sam Okafor", "Lena Fischer", "Tom Reyes", "Ada Byrne", "Kofi Mensah", "Ruth Adler", "Jo Park", "Nia Evans"];
const cust: Record<string, any> = {};
for (const n of people) cust[n] = (await db.insert(schema.feedbackCustomers).values({ companyId: co.id, name: n }).returning())[0];
const note = async (who: string, text: string, links: [string, string, string][], source = "owner", untrusted = false) => {
  const [n] = await db.insert(schema.feedbackNotes).values({ companyId: co.id, text, source: source as any, customerId: cust[who].id, state: "processed", untrusted }).returning();
  for (const [f, importance, highlight] of links) await db.insert(schema.insights).values({ noteId: n.id, featureId: F[f].id, importance: importance as any, highlight, createdBy: source === "portal" ? "portal" : "the owner" });
};
await note("Sam Okafor", "I couldn't find the API page at all. A search box would have saved me ten minutes.", [["search", "critical", "A search box would have saved me ten minutes"]]);
await note("Lena Fischer", "The docs are lovely but I read them at night. Any chance of a dark theme?", [["dark", "important", "Any chance of a dark theme?"]], "portal", true);
await note("Tom Reyes", "Home page took ages on the train. The sign-up button jumped about too.", [["fast", "critical", "Home page took ages on the train"], ["signup", "important", "The sign-up button jumped about"]]);
await note("Ada Byrne", "Tried signing up on my phone and the submit button was off the screen.", [["signup", "critical", "the submit button was off the screen"]]);
await note("Kofi Mensah", "How do I know what changed since last month? A changelog would help.", [["log", "important", "A changelog would help"]]);
await note("Ruth Adler", "Dark mode please!", [["dark", "nice_to_have", "Dark mode please!"]], "portal", true);
await note("Jo Park", "Searching the docs with my browser's find only works on one page at a time.", [["search", "important", "only works on one page at a time"]]);
await note("Nia Evans", "Would love dark mode, and an RSS feed for the blog.", [["dark", "important", "Would love dark mode"], ["rss", "nice_to_have", "an RSS feed for the blog"]], "portal", true);

const work = workService(db);
const p = await work.createProject(co.id, "Website");
const T: Record<string, any> = {};
const t = async (key: string, title: string, state: string, a: any, risk: string, extra: any = {}) => {
  T[key] = await work.createTicket(p.id, { title, state: state as any, assigneeAgentId: a?.id ?? null, risk: risk as any, ...extra });
};
await t("search", "Search across the docs", "backlog", null, "medium", { featureId: F.search.id });
await t("dark", "Dark mode for the docs", "backlog", null, "low", { featureId: F.dark.id });
await t("form", "Fix the sign-up form on phones", "in_progress", dev, "low", { featureId: F.signup.id });
await t("log", "Add a changelog page", "ready", null, "low", { featureId: F.log.id });
await t("host", "Move the site to the new host", "in_progress", sen, "high", { acceptanceCriteria: ["Every page loads after the move", "Old links redirect"] });
await t("img", "Compress the home page images", "in_progress", dev, "low", { featureId: F.fast.id });
await t("guide", "Write the getting-started guide", "in_progress", wri, "low", { featureId: F.log.id });
await t("rate", "Rate limit on the contact form", "blocked", dev, "low", { stateNote: "Waiting for the owner to choose the limit." });
const homeCriteria = ["The hero and the three feature cards fit a 380px phone without side-scrolling", "The sign-up button is visible without scrolling on desktop and phone", "The page scores 90 or more on the speed check"];
await t("home", "New home page layout", "review", des, "medium", { featureId: F.fast.id, acceptanceCriteria: homeCriteria, stateNote: "Ready for review. 1 pass; 2 pass; 3 pass. Checked at desktop and phone widths; the speed check scored 94." });
await t("focus", "Keyboard focus on the menu", "review", qa, "low", { acceptanceCriteria: ["Tab moves through every menu item in order", "The focused item has a visible outline"], stateNote: "1 pass; 2 pass. Tested with the keyboard only." });
await t("pricing", "Add a pricing page", "blocked", pm, "medium", { stateNote: "Waiting for the plan to be approved, then it splits into design, build and test." });
await t("priv", "Privacy page", "done", wri, "trivial", { featureId: F.priv.id });
await t("icon", "Favicon and app icon", "done", des, "trivial");
await t("map", "Sitemap for search engines", "done", dev, "trivial");

const q = (question: string, options: string[], rec: string, by: any, ctx: any) =>
  db.insert(schema.decisions).values({ companyId: co.id, kind: "question", question, options, recommendedOption: rec, raisedByAgentId: by.id, tier: "owner", context: ctx });
await q("How many contact form messages can one visitor send an hour?", ["5", "20", "No limit"], "5", dev, { type: "question", ticketId: T.rate.id, triedFirst: "Real visitors sent 1 or 2 last month. The spam burst sent 300 in an hour." });
await q("Approve the new home page design?", ["Approve", "Send back with notes"], "Approve", des, { type: "question", ticketId: T.home.id, triedFirst: "Felix checked it at phone and desktop widths. Both pass." });
await q("Moving the site to the new host is high risk. Sign it off before it merges?", ["Sign off", "Send back"], "Sign off", sen, { type: "question", ticketId: T.host.id, triedFirst: "Every page loads on the new host, and old links redirect." });
await q("Dark mode has the most votes on the feedback portal. Move it to Next on the roadmap?", ["Move to Next", "Keep in Later"], "Move to Next", ceo, { type: "question", triedFirst: "Sized it as small. Its priority is the highest in Later." });

// ---------- Promo video extras (BOS-1439): runs, reviews, merge line, a plan card. All made up. ----------
const { eq } = await import(new URL("../../../../apps/server/node_modules/drizzle-orm/index.js", import.meta.url).href);
const MIN = 60_000;
const ago = (min: number) => new Date(Date.now() - min * MIN);
const sha = (n: number) => `${n.toString(16).padStart(2, "0")}c4a9e1d07b3f5a62c81e90d4b7f3a1e5c2d86${n}`.slice(0, 40);

// A runner row holds the transcript events. The token is a random hash of nothing real, so nothing can connect with it.
const [runner] = await db.insert(schema.runners).values({ companyId: co.id, tokenHash: "demo-not-a-real-token", imageVersion: "demo", lastSeenAt: new Date() }).returning();
let seq = 0;
type Step = ["think" | "say", string] | ["cmd", string, string, string];
// One run: the row plus its transcript (started, workspace, steps, ended). A run with no `endMinAgo` is still going.
const run = async (o: { who: any; ticket?: any; startMinAgo: number; endMinAgo?: number; branch: string; steps: Step[]; outcome?: string; tokens: number }) => {
  const [r] = await db.insert(schema.runs).values({
    companyId: co.id, agentId: o.who.id, ticketId: o.ticket?.id ?? null, model: "claude-sonnet-5-5", purpose: "work",
    startedAt: ago(o.startMinAgo), endedAt: o.endMinAgo == null ? null : ago(o.endMinAgo), lastEventAt: ago(o.endMinAgo ?? 0.2),
    outcome: o.endMinAgo == null ? null : (o.outcome ?? "end_turn"), inputTokens: o.tokens, outputTokens: Math.round(o.tokens / 14), cachedReadTokens: o.tokens * 5, cachedWriteTokens: Math.round(o.tokens / 3),
    contextUsed: Math.round(o.tokens / 2), contextSize: 200_000,
  }).returning();
  const end = o.endMinAgo ?? 0.2;
  const span = o.startMinAgo - end;
  const total = o.steps.length + 2;
  const ev = (i: number, type: string, payload: Record<string, unknown>) =>
    db.insert(schema.runnerEvents).values({ runnerId: runner.id, seq: ++seq, type, payload: { type, runId: r.id, ...payload }, occurredAt: ago(o.startMinAgo - (span * i) / (total + 1)) });
  await ev(0, "run.started", { agentId: o.who.id, acpSessionId: `demo-session-${seq}`, model: "claude-sonnet-5-5" });
  await ev(1, "run.workspace", { created: true, branch: o.branch, baseCommit: sha(seq + 7), restoredPatch: false });
  let i = 2;
  for (const s of o.steps) {
    if (s[0] === "think") await ev(i++, "run.update", { update: { kind: "reasoning", text: s[1] } });
    else if (s[0] === "say") await ev(i++, "run.update", { update: { kind: "agent_message", text: s[1] } });
    else await ev(i++, "run.update", { update: { kind: "tool_call", title: s[1], toolKind: "execute", status: "completed", inputSummary: s[2], resultSummary: s[3] } });
  }
  if (o.endMinAgo != null) await ev(total, "run.ended", { stopReason: "end_turn", error: null });
  return r;
};

// 1. One agent working now, and six finished runs.
await run({ who: dev, ticket: T.form, startMinAgo: 7, branch: "bossman/fix-signup-form", tokens: 90_000, steps: [
  ["think", "The submit button sits inside a fixed-width row, so on a 380px screen it is pushed past the edge. The row needs to wrap, and the button should take the full width on phones."],
  ["cmd", "Run grep -rn \"signup-row\" src/", "grep -rn \"signup-row\" src/", "src/styles/signup.css:14 and src/components/SignupForm.tsx:31"],
  ["say", "Found it: the form row uses a fixed 420px width. Changing it to wrap below 480px."],
  ["cmd", "Run pnpm test signup", "pnpm test signup", "3 tests passed"],
] });
await run({ who: dev, ticket: T.form, startMinAgo: 190, endMinAgo: 168, branch: "bossman/fix-signup-form", tokens: 140_000, steps: [
  ["think", "Ada's note says the submit button was off the screen on her phone. I'll reproduce it at 380px first, before changing anything."],
  ["cmd", "Run pnpm dev --port 4000", "pnpm dev --port 4000", "ready on http://localhost:4000"],
  ["cmd", "Run node scripts/shot.mjs /signup 380", "node scripts/shot.mjs /signup 380", "saved signup-380.png: the button starts 40px past the right edge"],
  ["say", "Reproduced. The button is clipped on small screens. I'll write a failing test for it before the fix."],
  ["cmd", "Run pnpm test signup", "pnpm test signup", "1 failed: submit button wider than viewport"],
  ["say", "Test fails as expected. Moving on to the fix in the next run, after a look at the form's styles."],
] });
await run({ who: dev, ticket: T.img, startMinAgo: 300, endMinAgo: 262, branch: "bossman/compress-home-images", tokens: 210_000, steps: [
  ["think", "The home page ships four photos at full size. Converting them to WebP and adding width hints should cut most of the weight."],
  ["cmd", "Run du -sh public/images", "du -sh public/images", "6.8M public/images"],
  ["cmd", "Run node scripts/compress-images.mjs", "node scripts/compress-images.mjs", "4 images written as WebP, 6.8M down to 740K"],
  ["cmd", "Run pnpm build", "pnpm build", "built 38 pages in 9s"],
  ["say", "Images are down from 6.8 MB to 740 KB and the build passes. Moving the ticket to review with before and after sizes in the note."],
] });
await run({ who: des, ticket: T.home, startMinAgo: 420, endMinAgo: 355, branch: "bossman/new-home-layout", tokens: 260_000, steps: [
  ["think", "The old hero shows three calls to action. The brief wants one: sign up. The three feature cards can sit below it in a row, and stack on phones."],
  ["cmd", "Run pnpm test home", "pnpm test home", "5 tests passed"],
  ["say", "New hero and card row are in. At 380px the cards stack and nothing scrolls sideways."],
  ["cmd", "Run node scripts/speed-check.mjs /", "node scripts/speed-check.mjs /", "speed score 94 on a simulated phone"],
  ["say", "Speed score is 94. Sending it to review with desktop and phone screenshots attached."],
] });
await run({ who: qa, ticket: T.focus, startMinAgo: 240, endMinAgo: 214, branch: "bossman/menu-focus", tokens: 120_000, steps: [
  ["think", "I'll check the menu with the keyboard only: Tab order, the outline, and whether Escape closes the menu."],
  ["cmd", "Run pnpm test menu", "pnpm test menu", "7 tests passed"],
  ["say", "Tab visits every item in order and the outline is clear. Escape closes the menu and puts focus back on the button."],
  ["say", "Both criteria pass. Approving."],
] });
await run({ who: sen, ticket: T.host, startMinAgo: 600, endMinAgo: 540, branch: "bossman/new-host", tokens: 330_000, steps: [
  ["think", "Moving hosts changes every address, so the old links must redirect. I'll list the old paths and test each one against the new host."],
  ["cmd", "Run node scripts/list-old-paths.mjs", "node scripts/list-old-paths.mjs", "212 old paths found"],
  ["cmd", "Run node scripts/check-redirects.mjs https://staging.example.com", "node scripts/check-redirects.mjs https://staging.example.com", "212 of 212 redirect to the right page"],
  ["say", "All 212 old links redirect and every page loads on the new host. This is high risk, so I'm asking the owner to sign it off before it merges."],
] });
const pricingRun = await run({ who: pm, ticket: T.pricing, startMinAgo: 90, endMinAgo: 78, branch: "bossman/pricing-plan", tokens: 80_000, steps: [
  ["think", "A pricing page needs a design, a build and a test pass. They can overlap once the design has the layout agreed."],
  ["say", "I have a plan that splits the pricing page into three tickets: design, build and test. It's on the plan card for approval."],
] });

// 2. A ticket in review: three passed criteria, two reviewers with approvals, a plain state note.
const approve = async (ticket: any, kind: string, who: any, notes: string, round = 1) => {
  await db.insert(schema.reviewRequests).values({ ticketId: ticket.id, kind, reviewerAgentId: who.id, round, status: "approved", notes, createdAt: ago(300), decidedAt: ago(kind === "code" ? 45 : 30), head: sha(round + 1) });
  await db.insert(schema.ticketReviews).values({ ticketId: ticket.id, reviewer: who.name, verdict: "approve", comments: [] });
};
await approve(T.home, "code", sen, "Layout matches the brief. Reads well at 380px and on desktop. The speed score is 94. Approved.");
await approve(T.home, "adversarial", qa, "Tried a very long headline, no JavaScript, and a slow connection. The page holds up. Approved.");
await approve(T.focus, "code", sen, "Keyboard order and outline both work. Approved.");

// 3. The merge line: a check running now, one waiting, and two recently merged.
await db.insert(schema.settings).values([{ key: "check_queue_mode", value: "server" }, { key: "check_slots", value: 1 }]).onConflictDoNothing();
const job = (ticket: any, state: string, extra: any) => db.insert(schema.checkJobs).values({ companyId: co.id, projectId: p.id, ticketId: ticket.id, kind: "merge", scope: "full", commit: sha(11), tree: sha(ticket === T.home ? 12 : 13), state, command: "scripts/check-all.sh", queuedAt: ago(14), ...extra });
await job(T.home, "running", { startedAt: ago(6), lastOutputAt: ago(0.5), runnerId: runner.id, logTail: "typecheck passed\nrunning tests: 412 of 1,180 done" });
await job(T.focus, "queued", { queuedAt: ago(4) });
for (const [tk, sh, mins] of [[T.priv, sha(21), 50], [T.icon, sha(22), 130]] as const) {
  await db.update(schema.tickets).set({ mergeCommit: sh, mergedAt: ago(mins) }).where(eq(schema.tickets.id, tk.id));
}
await db.insert(schema.checkResults).values([
  { companyId: co.id, ticketId: T.home.id, sha: sha(11), kind: "verify", passed: true, at: ago(40), detail: "quick check passed" },
  { companyId: co.id, ticketId: T.focus.id, sha: sha(13), kind: "verify", passed: true, at: ago(30), detail: "quick check passed" },
]);

// 4. A plan card: the Product Manager's plan for "Add a pricing page", split for a designer, a developer and QA.
const planText = [
  "Add a pricing page, in three tickets that run in this order.",
  "",
  "1. Design the pricing page (Juno, Designer): three plan cards, a comparison table and one sign-up button. Desktop and 380px phone mock-ups.",
  "2. Build the pricing page (Iris, Developer): build the approved design, with the plan prices read from one file so they can change without a rebuild. Starts when the design is approved.",
  "3. Test the pricing page (Felix, QA): check it at phone and desktop widths, with the keyboard only, and with the prices changed. Starts when the build is in review.",
  "",
  "Risk: low. No existing page changes except one new link in the top menu.",
].join("\n");
await db.insert(schema.decisions).values({
  companyId: co.id, kind: "approval", question: `Approve Priya - Product Manager's plan for "Add a pricing page"?`, options: ["Approve plan", "Keep planning"], recommendedOption: "Approve plan",
  raisedByAgentId: pm.id, tier: "owner", createdAt: ago(76),
  context: { type: "permission", runnerId: runner.id, runId: pricingRun.id, requestId: "demo-plan-request", plan: true, ticketId: T.pricing.id, planText },
});

await close();
console.log("seeded company", co.id, "project", p.id, "pm", pm.id);
