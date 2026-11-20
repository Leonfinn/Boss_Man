// BOS-1931: the security reviewer reads and closes a GitHub alert through the server, against a stubbed GitHub.
// Every name, repo and the token are made up. The "secret" is built from pieces so the repo's secret scan ignores it.
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activity, agents, decisions, githubAlertTickets, githubWatches, tickets as ticketsTable } from "../src/db/schema.js";
import { githubWatchService } from "../src/services/github-watch.js";
import { clearOwnerTodo } from "../src/services/decisions.js";
import { makeApp, signIn, type TestApp } from "./helpers.js";

const TOKEN = ["github", "pat", "11BBBBBBB0" + "abcdefghijklmnopqrstuvwxyz" + "0123456789"].join("_");
const LEAKED = ["ghp", "ZZ" + "yyxxwwvvuuttssrrqqppoonnmmllkkjjiihh"].join("_");
const REPO = "example-owner/example-repo";

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function setup() {
  t = await makeApp();
  const { cookie } = await signIn(t);
  const req = (method: "POST", url: string, payload: unknown) => t!.app.inject({ method, url, headers: { cookie }, payload: payload as object });
  const company = (await req("POST", "/api/companies", { name: "App Co" })).json().company;
  const project = (await req("POST", `/api/companies/${company.id}/projects`, { name: "Site" })).json();
  const ceo = (await t.db.select().from(agents).where(eq(agents.companyId, company.id)))[0]!;
  const mk = async (name: string, template: string | null) => (await t!.db.insert(agents).values({ companyId: company.id, name, role: "worker", agentKind: "claude", template } as never).returning())[0]!;
  const reviewer = await mk("Jane - Security Reviewer", "security-reviewer");
  const dev = await mk("Dev - Developer", "engineer");
  await t.db.insert(githubWatches).values({ projectId: project.id, companyId: company.id, repo: REPO, enabled: true });

  const gh = {
    mode: "ok" as "ok" | "403",
    calls: [] as Array<{ url: string; method: string; auth: string | null; body: unknown }>,
  };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetchStub = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    gh.calls.push({ url, method, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    const u = new URL(url);
    if (gh.mode === "403" && method === "PATCH") return json(403, { message: "Resource not accessible by personal access token" });
    if (method === "PATCH") return json(200, { state: "closed" });
    if (u.pathname === `/repos/${REPO}/secret-scanning/alerts/3`) {
      // The real API returns the secret's value in the alert: it must never come back out.
      return json(200, { number: 3, state: "open", secret_type_display_name: "Example API token", secret: LEAKED, validity: "active", created_at: "2026-11-18T10:00:00Z", publicly_leaked: true });
    }
    if (u.pathname === `/repos/${REPO}/secret-scanning/alerts/3/locations`) {
      return json(200, [
        { type: "commit", details: { path: "docs/example.md", start_line: 12, commit_sha: "abc1234def5678" } },
        { type: "commit", details: { path: "src/old.ts", start_line: 4, commit_sha: "0123456789abcdef" } },
      ]);
    }
    if (/^\/repos\/.+\/commits\/[0-9a-f]+$/.test(u.pathname)) return json(200, { commit: { committer: { date: "2026-11-17T09:30:00Z" } } });
    if (u.pathname === `/repos/${REPO}/dependabot/alerts/9`) {
      return json(200, {
        number: 9,
        state: "open",
        created_at: "2026-11-19T08:00:00Z",
        dependency: { package: { name: "left-pad-ish", ecosystem: "npm" }, manifest_path: "package.json" },
        security_advisory: { ghsa_id: "GHSA-aaaa-bbbb-cccc", cve_id: "CVE-2026-0001", severity: "high", summary: "Prototype pollution", classification: "general" },
        security_vulnerability: { vulnerable_version_range: "< 1.2.3", first_patched_version: { identifier: "1.2.3" } },
      });
    }
    return json(404, { message: "Not Found" });
  }) as unknown as typeof fetch;

  const woken: Array<{ agentId: string; reason: string }> = [];
  const svc = githubWatchService(t.db, {
    fetch: fetchStub,
    token: async () => TOKEN,
    feedback: t.feedback,
    notify: async (agentId, i) => void woken.push({ agentId, reason: i.reason }),
    alert: (i) => t!.alerts.raise(i),
    clearCard: (key, summary) => clearOwnerTodo(t!.db, key, summary),
    createTicket: (projectId, input) => t!.work.createTicket(projectId, input),
    closeTicket: (ticketId, note) => t!.work.updateTicket(ticketId, { state: "done", outcome: "completed", stateNote: note }),
  });
  const alertTicket = async (alertKey: string, assignee: string) => {
    const tk = await t!.work.createTicket(project.id, { title: `Alert ${alertKey}`, body: "x", assigneeAgentId: assignee, state: "ready", planFirst: false } as never);
    await t!.db.insert(githubAlertTickets).values({ projectId: project.id, alertKey, ticketId: tk.id });
    return tk.id as string;
  };
  return { company, project, ceo, reviewer, dev, svc, gh, woken, alertTicket };
}

const patchOf = (gh: Awaited<ReturnType<typeof setup>>["gh"]) => gh.calls.filter((c) => c.method === "PATCH");

describe("security_alert read", () => {
  it("shows a secret alert's type, validity, every location with its date, and never the secret's value", async () => {
    const c = await setup();
    const id = await c.alertTicket("secret:3", c.reviewer.id);
    const r = await c.svc.alertRead(c.company.id, c.reviewer.id, id);
    expect(r.ok).toBe(true);
    expect(r.text).toContain("Example API token");
    expect(r.text).toContain("active");
    expect(r.text).toContain("docs/example.md");
    expect(r.text).toContain("abc1234def5678");
    expect(r.text).toContain("2026-11-17T09:30:00Z");
    expect(r.text).toContain("src/old.ts");
    expect(r.text).toContain("<untrusted");
    expect(r.text).not.toContain(LEAKED);
    expect(r.text).not.toContain("ZZyyxx");
    // The token only ever rides in the Authorization header.
    expect(c.gh.calls.every((x) => x.auth === `Bearer ${TOKEN}` && !x.url.includes(TOKEN))).toBe(true);
  });

  it("shows a Dependabot alert's package, severity, advisory, manifest and fixed version", async () => {
    const c = await setup();
    const id = await c.alertTicket("dependabot:9", c.ceo.id);
    const r = await c.svc.alertRead(c.company.id, c.ceo.id, id);
    expect(r.ok).toBe(true);
    for (const s of ["left-pad-ish", "high", "GHSA-aaaa-bbbb-cccc", "package.json", "1.2.3"]) expect(r.text).toContain(s);
    expect(r.text).toContain('"malware": false');
  });

  it("refuses an agent that is not the security reviewer or the CEO, and a ticket that is not an alert ticket", async () => {
    const c = await setup();
    const id = await c.alertTicket("secret:3", c.reviewer.id);
    expect((await c.svc.alertRead(c.company.id, c.dev.id, id)).ok).toBe(false);
    expect((await c.svc.alertRead(c.company.id, null, id)).ok).toBe(false);
    const [plain] = await t!.db.select({ id: ticketsTable.id }).from(ticketsTable).where(eq(ticketsTable.companyId, c.company.id)).limit(1);
    const other = await t!.work.createTicket(c.project.id, { title: "Plain", body: "x", assigneeAgentId: null } as never);
    expect((await c.svc.alertRead(c.company.id, c.reviewer.id, other.id)).ok).toBe(false);
    expect(plain).toBeDefined();
    expect(c.gh.calls).toHaveLength(0);
  });
});

describe("security_alert close", () => {
  it("closes a secret as revoked with the rotation recorded, and logs who and why on the ticket", async () => {
    const c = await setup();
    const id = await c.alertTicket("secret:3", c.reviewer.id);
    const r = await c.svc.alertClose(c.company.id, c.reviewer.id, id, { reason: "revoked", rotation: "Rotated the example token with its issuer on 20 Nov" });
    expect(r.ok).toBe(true);
    const [p] = patchOf(c.gh);
    expect(p!.url).toBe(`https://api.github.com/repos/${REPO}/secret-scanning/alerts/3`);
    expect(p!.body).toMatchObject({ state: "resolved", resolution: "revoked" });
    expect(String((p!.body as { resolution_comment: string }).resolution_comment)).toContain("Rotated the example token");
    const rows = await t!.db.select().from(activity).where(eq(activity.ticketId, id));
    const logged = rows.find((x) => x.kind === "security_alert");
    expect(logged?.agentId).toBe(c.reviewer.id);
    expect(JSON.stringify(logged?.detail)).toContain("Rotated the example token");
    expect((await t!.db.select().from(githubAlertTickets).where(eq(githubAlertTickets.ticketId, id)))[0]!.closedAt).not.toBeNull();
    expect((await t!.db.select().from(ticketsTable).where(eq(ticketsTable.id, id)))[0]!.systemState).toBe("done");
    // Closing again does nothing more on GitHub.
    expect((await c.svc.alertClose(c.company.id, c.reviewer.id, id, { reason: "revoked", rotation: "Rotated the example token again" })).ok).toBe(true);
    expect(patchOf(c.gh)).toHaveLength(1);
  });

  it("needs the location checked for any secret reason but revoked, and the rotation for revoked", async () => {
    const c = await setup();
    const id = await c.alertTicket("secret:3", c.reviewer.id);
    expect((await c.svc.alertClose(c.company.id, c.reviewer.id, id, { reason: "false_positive" })).ok).toBe(false);
    expect((await c.svc.alertClose(c.company.id, c.reviewer.id, id, { reason: "used_in_tests", rotation: "something long enough" })).ok).toBe(false);
    expect((await c.svc.alertClose(c.company.id, c.reviewer.id, id, { reason: "revoked", locationChecked: "docs/example.md at abc1234" })).ok).toBe(false);
    expect((await c.svc.alertClose(c.company.id, c.reviewer.id, id, { reason: "bogus", rotation: "something long enough" })).ok).toBe(false);
    expect(patchOf(c.gh)).toHaveLength(0);
    const ok = await c.svc.alertClose(c.company.id, c.reviewer.id, id, { reason: "false_positive", locationChecked: "docs/example.md at abc1234: a documented placeholder" });
    expect(ok.ok).toBe(true);
    expect(patchOf(c.gh)[0]!.body).toMatchObject({ state: "resolved", resolution: "false_positive" });
  });

  it("dismisses a Dependabot alert only with a GitHub reason and a note", async () => {
    const c = await setup();
    const id = await c.alertTicket("dependabot:9", c.ceo.id);
    expect((await c.svc.alertClose(c.company.id, c.ceo.id, id, { reason: "false_positive" })).ok).toBe(false);
    expect((await c.svc.alertClose(c.company.id, c.ceo.id, id, { reason: "not_used" })).ok).toBe(false);
    const ok = await c.svc.alertClose(c.company.id, c.ceo.id, id, { reason: "not_used", note: "Only a dev tool that never ships" });
    expect(ok.ok).toBe(true);
    expect(patchOf(c.gh)[0]!.body).toMatchObject({ state: "dismissed", dismissed_reason: "not_used" });
  });

  it("refuses anyone but the security reviewer and the CEO", async () => {
    const c = await setup();
    const id = await c.alertTicket("secret:3", c.reviewer.id);
    const r = await c.svc.alertClose(c.company.id, c.dev.id, id, { reason: "revoked", rotation: "Rotated the example token" });
    expect(r.ok).toBe(false);
    expect(patchOf(c.gh)).toHaveLength(0);
  });

  it("holds the close for the CEO when the reviewer wrote the fix on that ticket, and lets the CEO close it", async () => {
    const c = await setup();
    const id = await c.alertTicket("secret:3", c.reviewer.id);
    await t!.db.update(ticketsTable).set({ branch: "bossman/fix" }).where(eq(ticketsTable.id, id));
    const held = await c.svc.alertClose(c.company.id, c.reviewer.id, id, { reason: "revoked", rotation: "Rotated the example token" });
    expect(held.ok).toBe(false);
    expect(held.text).toContain("CEO");
    expect(patchOf(c.gh)).toHaveLength(0);
    expect(c.woken.some((w) => w.agentId === c.ceo.id && w.reason === "alert close needs the CEO")).toBe(true);
    expect((await c.svc.alertClose(c.company.id, c.ceo.id, id, { reason: "revoked", rotation: "Rotated the example token" })).ok).toBe(true);
  });

  it("raises one owner card naming the permission when GitHub refuses the write, and withdraws it when a close works", async () => {
    const c = await setup();
    const id = await c.alertTicket("secret:3", c.reviewer.id);
    c.gh.mode = "403";
    const input = { reason: "revoked", rotation: "Rotated the example token" };
    expect((await c.svc.alertClose(c.company.id, c.reviewer.id, id, input)).ok).toBe(false);
    expect((await c.svc.alertClose(c.company.id, c.reviewer.id, id, input)).ok).toBe(false);
    const cards = await t!.db.select().from(decisions).where(eq(decisions.companyId, c.company.id));
    expect(cards).toHaveLength(1);
    expect(cards[0]!.question).toContain("Secret scanning alerts (write)");
    expect(cards[0]!.question).toContain("Read and write");
    expect(cards[0]!.question).toContain("change alert state on GitHub");
    expect(cards[0]!.question).toContain("Secrets page");
    expect((await t!.db.select().from(githubAlertTickets).where(eq(githubAlertTickets.ticketId, id)))[0]!.closedAt).toBeNull();
    c.gh.mode = "ok";
    expect((await c.svc.alertClose(c.company.id, c.reviewer.id, id, input)).ok).toBe(true);
    expect((await t!.db.select().from(decisions).where(eq(decisions.companyId, c.company.id)))[0]!.status).not.toBe("open");
    expect((await c.svc.get(c.project.id))!.alertsError).toBeNull();
  });

  it("never records or sends a secret-looking value typed into the proof fields", async () => {
    const c = await setup();
    const id = await c.alertTicket("secret:3", c.reviewer.id);
    await c.svc.alertClose(c.company.id, c.reviewer.id, id, { reason: "revoked", rotation: `Rotated ${LEAKED} with the issuer` });
    expect(JSON.stringify(patchOf(c.gh))).not.toContain(LEAKED);
    const rows = await t!.db.select().from(activity).where(eq(activity.ticketId, id));
    expect(JSON.stringify(rows)).not.toContain(LEAKED);
  });
});
