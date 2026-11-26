// BOS-1797 (R48, cock-ups 18 Nov 09:28): an owner card that asks a question Boss Man's own record already answers is
// refused with the recorded value; a record that can't vouch for it any more lets the card through with a warning and
// the record line at its head, to the CEO first; no record says nothing. The two cards are the real ones that reached
// the owner (BOS-1603's 82647439 and BOS-1584's 5c87e6d4), with made-up addresses.
import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { agents, decisions, settings, tickets, wakes } from "../src/db/schema.js";
import { issueRunToken } from "../src/mcp.js";
import { DEFAULT_NOTIFY_SETTINGS, PHONE_TEST_KEY, type PhoneTestRecord } from "../src/services/notifications.js";
import { HOST_FACTS_KEY, type HostFactsRecord } from "../src/services/host-facts.js";
import { answerFromRecord, PHONE_PROOF_FRESH_MS, type AskRecord } from "../src/services/owner-record.js";
import { askedQuestion, similarQuestion } from "../src/services/stale-requests.js";
import { signedInOwner } from "./helpers/owner-session.js";

const PUBLIC = "https://bossman.example.com";
const CARD1 = {
  question: 'On your Notifications page, the box "Boss Man\'s address on your phone" holds your Tailscale name, saved before this fix. It is the right value for a phone that has Tailscale on. Keep it and close BOS-1603?',
  options: ["Keep it, close the fix", "I don't use Tailscale on my phone"],
};
const CARD2 = {
  question: "BOS-1584: please look at the This host panel once more. Does it still show repo.probe as failed, or the standby colour as a failing check?",
  options: ["No failing check", "repo.probe still failed", "Standby colour still listed as failing"],
};
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const confirmed = (url: string | undefined, atMs = 2 * 24 * 3_600_000): PhoneTestRecord => ({ sentAt: ago(atMs + 9_000), tokenHash: "x", expiresAt: ago(atMs - 600_000), confirmedAt: ago(atMs), ...(url === undefined ? {} : { url }) });
const hostRecord = (atMs: number, facts: Record<string, string>): HostFactsRecord => ({ hostName: "box", reportedAt: ago(atMs), facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, { value: v, source: "host" as const, at: ago(atMs) }])) });
const rec = (over: Partial<AskRecord> = {}): AskRecord => ({ now: new Date(), publicUrl: PUBLIC, phoneTest: null, ...over });
const texts = (c: { question: string; options: string[] }) => [c.question, ...c.options];

describe("which questions the record answers (pure)", () => {
  it("card 1 with a fresh tap through the current address is settled, naming the address and the time", () => {
    const p = confirmed(PUBLIC);
    const a = answerFromRecord(texts(CARD1), rec({ phoneTest: p }));
    expect(a?.kind).toBe("settled");
    expect(a!.line).toContain(PUBLIC);
    expect(a!.line).toContain(`${p.confirmedAt!.slice(0, 16).replace("T", " ")} UTC`);
    expect(a!.message).toMatch(/^Not raised\. Boss Man already knows/);
    expect(a!.message).toMatch(/stillNeeded/);
    // BOS-2700: the refusal names the row that matched, so a wrong match can be traced without the refused text.
    expect(a!.message).toContain("(matched rule: ntfy.phoneReachesAddress)");
    const stale = answerFromRecord(texts(CARD1), rec({ phoneTest: confirmed("https://old.example.net") }));
    expect(stale!.message).toContain("(matched rule: ntfy.phoneReachesAddress)");
  });

  it("card 1 is stale (a warning) when the tap went to an old address, is too old, or kept no address; silent with no tap", () => {
    const moved = answerFromRecord(texts(CARD1), rec({ phoneTest: confirmed("https://old.example.net") }));
    expect(moved?.kind).toBe("stale");
    expect(moved!.line).toMatch(/changed since, to https:\/\/bossman\.example\.com/);
    expect(answerFromRecord(texts(CARD1), rec({ phoneTest: confirmed(PUBLIC, PHONE_PROOF_FRESH_MS + 3_600_000) }))?.kind).toBe("stale");
    expect(answerFromRecord(texts(CARD1), rec({ phoneTest: confirmed(undefined) }))?.line).toMatch(/doesn't say which address it tested/);
    expect(answerFromRecord(texts(CARD1), rec({ phoneTest: confirmed(PUBLIC), publicUrl: null }))?.kind).toBe("stale");
    expect(answerFromRecord(texts(CARD1), rec())).toBeNull();
    expect(answerFromRecord(texts(CARD1), rec({ phoneTest: { ...confirmed(PUBLIC), confirmedAt: null } }))).toBeNull();
  });

  it("card 2 with a fresh host report is settled with repo.probe and the failing checks; stale past 30 minutes; silent with no report", () => {
    const ok = answerFromRecord(texts(CARD2), rec({ host: hostRecord(60_000, { "repo.probe": "ok", "check.standby.health": "ok", "check.disk.unhealthy": "0" }) }));
    expect(ok?.kind).toBe("settled");
    expect(ok!.line).toMatch(/repo\.probe = ok; no failing check \(host report at .* UTC\)/);
    const bad = answerFromRecord(texts(CARD2), rec({ host: hostRecord(60_000, { "repo.probe": "ok", "check.standby.health": "failing" }) }));
    expect(bad?.kind).toBe("settled"); // the record answers the question either way
    expect(bad!.line).toContain("failing: check.standby.health = failing");
    expect(answerFromRecord(texts(CARD2), rec({ host: hostRecord(45 * 60_000, { "repo.probe": "ok" }) }))?.kind).toBe("stale");
    expect(answerFromRecord(texts(CARD2), rec({ host: { facts: {}, hostName: null, reportedAt: null } }))).toBeNull();
    expect(answerFromRecord(texts(CARD2), rec())).toBeNull();
  });

  it("add-on and public-address questions are answered; an unknown add-on and the owner's own device are not", () => {
    const addons = { ntfy: { state: "running", since: ago(60_000), source: "ntfy accepted the last push, which doesn't show the phone got it" }, tailscale: { state: "unknown", since: null, source: "can't see it" }, penpot: { state: "stopped", since: ago(60_000), source: "host report" } } as AskRecord["addons"];
    expect(answerFromRecord(["Is Penpot still running?"], rec({ addons }))?.line).toMatch(/Penpot is stopped/);
    expect(answerFromRecord(["Is Tailscale running?"], rec({ addons }))).toBeNull();
    expect(answerFromRecord(["Is Tailscale set up on your phone?"], rec({ addons }))).toBeNull();
    expect(answerFromRecord(["Set up Penpot?", "Done", "It failed"], rec({ addons }))).toBeNull(); // asks the owner to do it (setsUp card)
    expect(answerFromRecord(["Have you saved a public address yet?"], rec())?.line).toContain(PUBLIC);
  });

  it("text that mentions a recorded fact but asks something else is not caught", () => {
    const fresh = rec({ phoneTest: confirmed(PUBLIC), host: hostRecord(60_000, { "repo.probe": "ok" }) });
    expect(answerFromRecord(["Your phone confirmed the test; do you also want pushes on a tablet?", "Yes", "No"], fresh)).toBeNull();
    expect(answerFromRecord(["Close BOS-12 now that the export works?", "Close it", "Keep it open"], fresh)).toBeNull();
    expect(answerFromRecord(["The phone reached the public address on the 16th."], fresh)).toBeNull(); // a statement, not a question
    // BOS-2685: a shortcuts plan question that mentions a phone, an address bar, "open" and "can" got the ntfy record line.
    const plan = "Plan for custom keyboard shortcuts: can you open the shortcut settings page, and does it work on a phone with a touch keyboard? Keep the current defaults?";
    expect(answerFromRecord([plan, "Approve the plan", "Change it"], fresh)).toBeNull();
    expect(answerFromRecord(["Can the phone open the url bar shortcut? Does it still work?"], fresh)).toBeNull();
  });
});

let ctx: Awaited<ReturnType<typeof setup>>;
const clients: Client[] = [];
async function setup() {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws" });
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const base = `127.0.0.1:${(built.app.server.address() as { port: number }).port}`;
  const cookie = await signedInOwner(db);
  const req = (method: "POST", url: string, payload: unknown) => built.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const companyId = ((await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } }).company.id;
  const dev = (await req("POST", `/api/companies/${companyId}/agents`, { name: "Developer" })).json() as { id: string };
  const [ceo] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "ceo")));
  const project = (await req("POST", `/api/companies/${companyId}/projects`, { name: "Site" })).json() as { id: string };
  const [ticket] = await db.insert(tickets).values({ companyId, projectId: project.id, title: "Phone address fix", systemState: "in_progress", assigneeAgentId: dev.id }).returning();
  const mcp = async (agentId: string) => {
    const token = await issueRunToken(db, { companyId, agentId, runId: randomUUID() });
    const c = new Client({ name: "t", version: "0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`http://${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    clients.push(c);
    return c;
  };
  const put = (key: string, value: unknown) => db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  await put("notifications", { ...DEFAULT_NOTIFY_SETTINGS, publicUrl: `${PUBLIC}/` });
  await db.delete(wakes);
  return { ...built, db, close, companyId, dev, ceo: ceo!, ticket: ticket!, mcp, put };
}
beforeEach(async () => {
  ctx = await setup();
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
  await ctx.app.close();
  await ctx.close();
});

const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]?.text ?? "";
const idOf = (t: string) => /Decision ([0-9a-f-]{36})/.exec(t)?.[1]!;
const TRIED = "Read the ticket, its branch and server_status; the owner's phone is the only way to check this.";
async function raise(card: { question: string; options: string[] }, extra: Record<string, unknown> = {}) {
  const c = await ctx.mcp(ctx.dev.id);
  return c.callTool({ name: "raise_decision", arguments: { ...card, recommended: card.options[0], triedFirst: TRIED, blocksTicketId: ctx.ticket.id, ...extra } });
}
const openCards = () => ctx.db.select().from(decisions).where(and(eq(decisions.companyId, ctx.companyId), eq(decisions.status, "open")));

describe("raise_decision against the record (BOS-1797)", () => {
  it("refuses card 1 when the phone tapped Got it through the current public address, naming the address and when", async () => {
    const p = confirmed(PUBLIC);
    await ctx.put(PHONE_TEST_KEY, p);
    const r = await raise(CARD1);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Boss Man already knows/);
    expect(textOf(r)).toContain(PUBLIC);
    expect(textOf(r)).toContain(`${p.confirmedAt!.slice(0, 16).replace("T", " ")} UTC`);
    expect(await openCards()).toHaveLength(0);
  });

  it("refuses card 2 when the host report shows repo.probe ok and no failing check", async () => {
    await ctx.put(HOST_FACTS_KEY, hostRecord(60_000, { "repo.probe": "ok", "check.standby.health": "ok" }));
    const r = await raise(CARD2);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/repo\.probe = ok; no failing check/);
    expect(await openCards()).toHaveLength(0);
  });

  it("lets card 1 through silently with no tap on record", async () => {
    const r = await raise(CARD1);
    expect(r.isError).not.toBe(true);
    expect(textOf(r)).not.toMatch(/record/i);
    const [d] = await openCards();
    expect(d!.question).toBe(CARD1.question);
  });

  it("a tap through an old address doesn't settle it: the card posts with a warning and the record line at its head", async () => {
    await ctx.put(PHONE_TEST_KEY, confirmed("https://old.example.net"));
    const r = await raise(CARD1);
    expect(r.isError).not.toBe(true);
    expect(textOf(r)).toMatch(/can't vouch for it now/);
    const [d] = await openCards();
    expect(d!.question.startsWith("Boss Man's record says: the phone reached Boss Man at https://old.example.net")).toBe(true);
    expect(d!.question).toMatch(/may be out of date/);
    expect(d!.question.endsWith(CARD1.question)).toBe(true);
  });

  it("a stale host report lets card 2 through with the warning", async () => {
    await ctx.put(HOST_FACTS_KEY, hostRecord(2 * 3_600_000, { "repo.probe": "ok" }));
    const r = await raise(CARD2);
    expect(r.isError).not.toBe(true);
    expect(textOf(r)).toMatch(/more than 30 minutes old/);
  });

  it("stillNeeded sends a settled question to the CEO first, even with steps, with the record line and the reason at its head", async () => {
    await ctx.put(PHONE_TEST_KEY, confirmed(PUBLIC));
    const why = "The owner said on BOS-1603 they removed Tailscale from the phone yesterday.";
    const steps = ["Open Settings → Server and runner → This host and look at the box \"Boss Man's address on your phone\"."];
    const r = await raise(CARD1, { stillNeeded: why, ownerMustDo: true, steps, why: "Without it Boss Man pushes to an address the phone can't reach.", minutes: 1 });
    expect(textOf(r)).toMatch(/went to the CEO first/);
    const [d] = await openCards();
    expect(d!.tier).toBe("ceo");
    expect(d!.question.startsWith(`Boss Man's record says: the phone reached Boss Man at ${PUBLIC}`)).toBe(true);
    expect(d!.question).toContain(`Asked because: ${why}`);
    expect((d!.context as { ladder?: { hops: Array<{ why: string }> } }).ladder?.hops[0]?.why).toMatch(/record already has a value/);
    // Without the record line the same owner-steps card would have stayed with the owner.
    expect((await ctx.db.select().from(wakes).where(eq(wakes.agentId, ctx.ceo.id))).some((w) => (w.note ?? "").includes(d!.id))).toBe(true);
  });

  // BOS-2739 (cock-ups round 7, G3): two raises of one question at once left two cards on 26 Nov 12:04. The second card
  // carried the record line at its head, so the repeat check (which compared the whole stored text) missed it; the check
  // and the insert were also apart, so two raises at once could both find no older card. Two raises now leave one open
  // card, whichever is stored first, and the card still says how it reads on the screen.
  for (const recordFirst of [true, false]) {
    it(`two raises at once of one question leave one open card (record line raised ${recordFirst ? "first" : "second"})`, async () => {
      await ctx.put(PHONE_TEST_KEY, confirmed("https://old.example.net"));
      const c = await ctx.mcp(ctx.dev.id);
      const options = ["Keep it", "Change it"];
      const plain = { name: "raise_decision", arguments: { question: CARD1.question, options, recommended: "Keep it", triedFirst: TRIED, blocksTicketId: ctx.ticket.id } };
      const withRecord = { name: "raise_decision", arguments: { question: CARD1.question, options, recommended: "Keep it", triedFirst: TRIED, blocksTicketId: ctx.ticket.id, stillNeeded: "The owner removed Tailscale from the phone yesterday." } };
      const [first, second] = await Promise.all(recordFirst ? [c.callTool(plain), c.callTool(withRecord)] : [c.callTool(withRecord), c.callTool(plain)]);
      expect([textOf(first), textOf(second)].some((t) => /already in the owner's queue|went to the CEO first|Decision [0-9a-f-]{36}/.test(t))).toBe(true);
      const open = await openCards();
      expect(open).toHaveLength(1);
      expect(askedQuestion(open[0]!.question)).toBe(CARD1.question);
      if (recordFirst) expect(open[0]!.question.startsWith("Boss Man's record says:")).toBe(true);
    });
  }

  it("a raised card that borrows the record line is still the same ask for the repeat check", () => {
    const plain = CARD1.question;
    const withRecord = `Boss Man's record says: the phone reached Boss Man at ${PUBLIC}. Asked because: a new phone was bought.\n\n${CARD1.question}`;
    expect(similarQuestion(withRecord, plain)).toBe(true);
    expect(similarQuestion(plain, withRecord)).toBe(true);
    expect(askedQuestion(withRecord)).toBe(CARD1.question);
  });

  it("notify_owner asking the owner what the record answers is refused too", async () => {
    await ctx.put(HOST_FACTS_KEY, hostRecord(60_000, { "repo.probe": "ok" }));
    const c = await ctx.mcp(ctx.dev.id);
    const r = await c.callTool({ name: "notify_owner", arguments: { level: "note", title: "Quick check", body: CARD2.question, ticketId: ctx.ticket.id } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Not sent\. Boss Man already knows/);
  });
});
