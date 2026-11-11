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
await t("form", "Fix the sign-up form on phones", "ready", dev, "low", { featureId: F.signup.id });
await t("log", "Add a changelog page", "ready", null, "low", { featureId: F.log.id });
await t("host", "Move the site to the new host", "in_progress", sen, "high", { acceptanceCriteria: ["Every page loads after the move", "Old links redirect"] });
await t("img", "Compress the home page images", "in_progress", dev, "low", { featureId: F.fast.id });
await t("guide", "Write the getting-started guide", "in_progress", wri, "low", { featureId: F.log.id });
await t("rate", "Rate limit on the contact form", "blocked", dev, "low", { stateNote: "Waiting for the owner to choose the limit." });
await t("home", "New home page layout", "review", des, "medium", { featureId: F.fast.id });
await t("focus", "Keyboard focus on the menu", "review", qa, "low");
await t("priv", "Privacy page", "done", wri, "trivial", { featureId: F.priv.id });
await t("icon", "Favicon and app icon", "done", des, "trivial");
await t("map", "Sitemap for search engines", "done", dev, "trivial");

const q = (question: string, options: string[], rec: string, by: any, ctx: any) =>
  db.insert(schema.decisions).values({ companyId: co.id, kind: "question", question, options, recommendedOption: rec, raisedByAgentId: by.id, tier: "owner", context: ctx });
await q("How many contact form messages can one visitor send an hour?", ["5", "20", "No limit"], "5", dev, { type: "question", ticketId: T.rate.id, triedFirst: "Real visitors sent 1 or 2 last month. The spam burst sent 300 in an hour." });
await q("Approve the new home page design?", ["Approve", "Send back with notes"], "Approve", des, { type: "question", ticketId: T.home.id, triedFirst: "Felix checked it at phone and desktop widths. Both pass." });
await q("Moving the site to the new host is high risk. Sign it off before it merges?", ["Sign off", "Send back"], "Sign off", sen, { type: "question", ticketId: T.host.id, triedFirst: "Every page loads on the new host, and old links redirect." });
await q("Dark mode has the most votes on the feedback portal. Move it to Next on the roadmap?", ["Move to Next", "Keep in Later"], "Move to Next", ceo, { type: "question", triedFirst: "Sized it as small. Its priority is the highest in Later." });
await close();
console.log("seeded company", co.id, "project", p.id, "pm", pm.id);
