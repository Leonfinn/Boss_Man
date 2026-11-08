// Throwaway seed for BOS-779 screenshots: a made-up company, never real data.
// Run from apps/server: DEMO_PASSWORD=<any> node_modules/.bin/tsx <this file> /tmp/<you>-site/pg   (a new, empty PGlite folder)
const W = new URL("../../../../apps/server/src", import.meta.url).pathname;
const password = process.env.DEMO_PASSWORD;
if (!password) throw new Error("Set DEMO_PASSWORD (any throwaway value) for the demo owner account.");
const { openPglite } = await import(`${W}/db/client.ts`);
const schema = await import(`${W}/db/schema.ts`);
const { hashPassword } = await import(`${W}/auth.ts`);
const { workService } = await import(`${W}/services/work.ts`);

const { db, close } = await openPglite(process.argv[2]);
await db.insert(schema.owners).values({ username: "demo", passwordHash: await hashPassword(password) });
const [co] = await db.insert(schema.companies).values({ name: "Fernleaf Plants", mission: "Sell house plants online, with care guides that actually help.", ticketPrefix: "FERN" }).returning();
const agent = async (name: string, role: "ceo" | "manager" | "worker", template: string, title: string) =>
  (await db.insert(schema.agents).values({ companyId: co.id, name, role, agentKind: "claude", model: "claude-sonnet-5-5", template, title }).returning())[0];
const ceo = await agent("Marta - CEO", "ceo", "ceo", "CEO");
const dev = await agent("Iris - Developer", "worker", "engineer", "Developer");
const sen = await agent("Owen - Senior Developer", "worker", "senior-dev", "Senior Developer");
const des = await agent("Juno - Designer", "worker", "designer", "Product Designer");
const qa = await agent("Felix - QA", "worker", "qa", "QA Engineer");
const wri = await agent("Hana - Writer", "worker", "writer", "Writer");

const work = workService(db);
const p = await work.createProject(co.id, "Shop");
const T: Record<string, any> = {};
const t = async (key: string, title: string, state: string, a: any, risk: string, extra: any = {}) => {
  T[key] = await work.createTicket(p.id, { title, state: state as any, assigneeAgentId: a?.id ?? null, risk: risk as any, ...extra });
};
await t("care", "Care guide pages for the 20 best-selling plants", "backlog", null, "low");
await t("gift", "Gift wrapping option at checkout", "backlog", null, "medium");
await t("ship", "Show delivery dates before payment", "ready", dev, "low");
await t("search", "Search that understands plant nicknames", "ready", null, "medium");
await t("pay", "Switch card payments to the new provider", "in_progress", sen, "high", { acceptanceCriteria: ["Test card payment goes through", "Refunds still work"] });
await t("photo", "Product photos: zoom on tap", "in_progress", dev, "low");
await t("water", "Watering reminder emails", "in_progress", wri, "low");
await t("stock", "Low-stock banner on product pages", "blocked", dev, "low", { stateNote: "Waiting for the owner to choose the stock threshold." });
await t("home", "New home page layout", "review", des, "medium");
await t("pot", "Pot size filter", "review", qa, "low");
await t("returns", "Returns page", "done", wri, "trivial");
await t("logo", "Favicon and app icon", "done", des, "trivial");
await t("sitemap", "Sitemap for search engines", "done", dev, "trivial");

const q = (question: string, options: string[], rec: string, by: any, ctx: any, kind = "question") =>
  db.insert(schema.decisions).values({ companyId: co.id, kind: kind as any, question, options, recommendedOption: rec, raisedByAgentId: by.id, tier: "owner", context: ctx });
await q("At what stock level should the low-stock banner show?", ["5 or fewer", "10 or fewer", "Never show it"], "5 or fewer", dev, { type: "question", ticketId: T.stock.id, triedFirst: "Checked last month's sales: most plants sell 1 to 3 a day, so 5 gives about two days' warning." });
await q("Approve the new home page design?", ["Approve", "Send back with notes"], "Approve", des, { type: "question", ticketId: T.home.id, triedFirst: "Felix checked it at phone and desktop widths. Both pass." });
await q("The card payment switch is high risk. Sign it off before it merges?", ["Sign off", "Send back"], "Sign off", sen, { type: "question", ticketId: T.pay.id, triedFirst: "Test payments and refunds pass on the test account." });
await q("Spend up to £40 this month on a stock photo licence for plant photos?", ["Yes, up to £40", "No"], "Yes, up to £40", ceo, { type: "question", triedFirst: "Our own photos cover 12 of the 20 best sellers." });
await close();
console.log("seeded", co.id);
