// BOS-1582: one Penpot form in Settings, and the network guard opening Penpot's address by itself.
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { penpotAddress } from "../src/services/launcher.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

const KEY = "launcher-key-".padEnd(43, "x");

/** A stand-in launcher that records each allow list it is sent, and reports one hand .env entry for Penpot. */
function fakeLauncher() {
  const calls: Array<{ method: string; path: string; body: unknown }> = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, body });
    const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (method === "GET" && url.pathname === "/netguard") return json(200, { mode: "auto", allow: ["penpot.example.lan:9001"] });
    if (method === "GET" && url.pathname === "/wanted") return json(200, []);
    if (method === "GET" && url.pathname === "/runners") return json(200, []);
    if (method === "PUT") return json(200, { slug: url.pathname.split("/")[2], id: "abc" });
    return json(404, { error: "unknown" });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function setup() {
  const fake = fakeLauncher();
  const keyFile = path.join(mkdtempSync(path.join(tmpdir(), "bm-key-")), "key");
  writeFileSync(keyFile, `${KEY}\n`);
  const { db, close } = await openPglite();
  // Every name resolves public unless listed; a test never depends on the real network.
  const lookup = async (host: string) => ({ "penpot.example.lan": ["192.168.1.5"] })[host] ?? ["93.184.216.34"];
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, fetch: fake.fetch, launcher: { url: "http://launcher:3105", keyFile }, lookup });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const company = async (name: string) => {
    const { company } = (await req("POST", "/api/companies", { name })).json() as { company: { id: string } };
    return company;
  };
  const co = await company("App Co");
  await vi.waitFor(() => expect(fake.calls.some((x) => x.method === "PUT" && x.path === "/runners/app-co")).toBe(true));
  const designer = (await req("POST", `/api/companies/${co.id}/agents`, { name: "Designer" })).json() as { id: string };
  const lastAllow = (slug = "app-co") => fake.calls.filter((x) => x.path === `/runners/${slug}/allow`).at(-1)?.body;
  return { ...built, db, close, req, fake, co, designer, company, lastAllow, noCookie: (method: "GET" | "PUT", url: string) => built.app.inject({ method, url }) };
}

type View = {
  configured: boolean;
  url: string | null;
  guardAddress: string | null;
  guardTrustsPrivate: boolean;
  token: { set: boolean; hint: string | null; secretName: string | null };
  email: { set: boolean };
  password: { set: boolean; hint: string | null };
  agentIds: string[];
  exportAgentIds: string[];
};

const TOKEN = "fake-penpot-token-abcdefghijklmnop";
const PASSWORD = "fake-agent-password-qrstuvwxyz";

describe("Penpot in Settings (BOS-1582)", () => {
  it("one save sets the four values and the guard opens Penpot's address for that company only", async () => {
    const c = (ctx = await setup());
    const other = await c.company("Other Co");
    const url = `/api/companies/${c.co.id}/penpot`;
    expect((await c.req("GET", url)).json()).toMatchObject({ configured: false, url: null });

    const saved = await c.req("PUT", url, { url: "http://192.168.1.50:9001", token: TOKEN, email: "agent@example.com", password: PASSWORD, agentIds: [c.designer.id], exportAgentIds: [c.designer.id] });
    expect(saved.statusCode).toBe(200);
    const v = saved.json() as View;
    expect(v).toMatchObject({ configured: true, url: "http://192.168.1.50:9001", guardAddress: "192.168.1.50:9001", guardTrustsPrivate: true, token: { set: true }, email: { set: true }, password: { set: true }, agentIds: [c.designer.id], exportAgentIds: [c.designer.id] });
    // Nothing secret comes back: only hints.
    expect(saved.body).not.toContain(TOKEN);
    expect(saved.body).not.toContain(PASSWORD);
    expect(saved.body).not.toContain("agent@example.com");

    // The same env names agents have always read, each limited to the ticked agent.
    const grants = (await c.req("GET", `/api/companies/${c.co.id}/grants`)).json() as Array<{ envName: string; agentIds: string[] }>;
    expect(grants.map((g) => g.envName).sort()).toEqual(["PENPOT_EMAIL", "PENPOT_PASSWORD", "PENPOT_TOKEN", "PENPOT_URL"]);
    expect(grants.every((g) => g.agentIds.join() === c.designer.id)).toBe(true);

    // The guard is told at once: this host:port only, trusted for its private address (a LAN IP literal).
    await vi.waitFor(() => expect(c.lastAllow()).toEqual({ allow: ["192.168.1.50:9001"], private: ["192.168.1.50:9001"] }));
    // And at every start: the server-start sync sends it again, so a restart or an update needs no step from the owner.
    c.fake.calls.length = 0;
    await c.launcher.syncAll(1);
    expect(c.lastAllow()).toEqual({ allow: ["192.168.1.50:9001"], private: ["192.168.1.50:9001"] });
    // Another company's runner never gets it.
    await c.launcher.syncAllow(other.id);
    expect(c.lastAllow("other-co")).toEqual({ allow: [], private: [] });

    // An agent's run gets the four values (the runner side is unchanged).
    const env = await c.secrets.resolveCompanyEnv(c.co.id, "check");
    expect(env).toMatchObject({ PENPOT_URL: "http://192.168.1.50:9001", PENPOT_TOKEN: TOKEN, PENPOT_EMAIL: "agent@example.com", PENPOT_PASSWORD: PASSWORD });
  });

  it("shows an install set up by hand on the Secrets page as already set, with nothing to re-enter, and its .env line as one that can go", async () => {
    const c = (ctx = await setup());
    // The old way (docs/16 before BOS-1582): four secrets, each granted by hand, every agent.
    for (const [name, value] of [["PENPOT_URL", "http://penpot.example.lan:9001"], ["PENPOT_TOKEN", TOKEN]] as const) {
      const s = (await c.req("POST", "/api/secrets", { name, kind: "generic", value })).json() as { secret: { id: string } };
      expect((await c.req("POST", `/api/secrets/${s.secret.id}/grants`, { companyId: c.co.id, envName: name })).statusCode).toBe(201);
    }
    const v = (await c.req("GET", `/api/companies/${c.co.id}/penpot`)).json() as View;
    expect(v).toMatchObject({ configured: true, url: "http://penpot.example.lan:9001", guardAddress: "penpot.example.lan:9001", guardTrustsPrivate: true, token: { set: true, secretName: "PENPOT_TOKEN" }, password: { set: false }, agentIds: [] });
    // The hand grant alone made the guard open it (a LAN-style name: trusted, so its private address is kept).
    await vi.waitFor(() => expect(c.lastAllow()).toEqual({ allow: ["penpot.example.lan:9001"], private: ["penpot.example.lan:9001"] }));
    // The Network guard page lists it, and the owner's old .env entry for it can go.
    const report = (await c.req("GET", "/api/netguard-allow")).json() as { report: { automatic: Array<{ address: string; kind: string; company: string | null; notAllowed: string | null }>; entries: Array<{ entry: string; coveredBy: string[]; note: string | null }>; lineCanGo: boolean } };
    expect(report.report.automatic).toContainEqual(expect.objectContaining({ address: "penpot.example.lan:9001", kind: "Penpot", company: "App Co", notAllowed: null }));
    expect(report.report.entries).toEqual([expect.objectContaining({ entry: "penpot.example.lan:9001", coveredBy: ["Penpot"], note: expect.stringMatching(/^Already allowed by Boss Man/) })]);
    expect(report.report.lineCanGo).toBe(true);
    expect(JSON.stringify(report)).not.toContain("http://");

    // Saving the form with blanks keeps the stored values and changes only who gets them.
    const saved = await c.req("PUT", `/api/companies/${c.co.id}/penpot`, { url: "", token: "", agentIds: [c.designer.id], exportAgentIds: [] });
    expect(saved.json()).toMatchObject({ configured: true, url: "http://penpot.example.lan:9001", token: { secretName: "PENPOT_TOKEN", hint: v.token.hint }, agentIds: [c.designer.id] });
    expect((await c.secrets.resolveCompanyEnv(c.co.id, "check")).PENPOT_TOKEN).toBe(TOKEN);
  });

  it("reads each pair's agent list from the secret's grant, so a hand-made narrower token or password stays narrow after a save (BOS-1592)", async () => {
    const c = (ctx = await setup());
    // By hand on the Secrets page: address and email for every agent, token and password for the Designer only.
    for (const [name, value, only] of [
      ["PENPOT_URL", "http://192.168.1.50:9001", false],
      ["PENPOT_TOKEN", TOKEN, true],
      ["PENPOT_EMAIL", "agent@example.com", false],
      ["PENPOT_PASSWORD", PASSWORD, true],
    ] as const) {
      const s = (await c.req("POST", "/api/secrets", { name, kind: "generic", value })).json() as { secret: { id: string } };
      const g = (await c.req("POST", `/api/secrets/${s.secret.id}/grants`, { companyId: c.co.id, envName: name })).json() as { id: string };
      if (only) expect((await c.req("PUT", `/api/grants/${g.id}/agents`, { agentIds: [c.designer.id] })).statusCode).toBe(204);
    }
    const url = `/api/companies/${c.co.id}/penpot`;
    const v = (await c.req("GET", url)).json() as View;
    expect(v).toMatchObject({ agentIds: [c.designer.id], exportAgentIds: [c.designer.id] });

    // The form sends back the lists it showed; a save that changes only the address keeps both secrets limited.
    expect((await c.req("PUT", url, { url: "http://192.168.1.60:9001", agentIds: v.agentIds, exportAgentIds: v.exportAgentIds })).statusCode).toBe(200);
    const grants = (await c.req("GET", `/api/companies/${c.co.id}/grants`)).json() as Array<{ envName: string; agentIds: string[] }>;
    const who = Object.fromEntries(grants.map((g) => [g.envName, g.agentIds]));
    expect(who).toEqual({ PENPOT_URL: [c.designer.id], PENPOT_TOKEN: [c.designer.id], PENPOT_EMAIL: [c.designer.id], PENPOT_PASSWORD: [c.designer.id] });
    expect((await c.secrets.resolveCompanyEnv(c.co.id, "check")).PENPOT_URL).toBe("http://192.168.1.60:9001");
  });

  it("follows the address when it changes on either page, and closes it when Penpot is removed", async () => {
    const c = (ctx = await setup());
    const url = `/api/companies/${c.co.id}/penpot`;
    await c.req("PUT", url, { url: "http://192.168.1.50:9001", token: TOKEN, agentIds: [], exportAgentIds: [] });
    await vi.waitFor(() => expect(c.lastAllow()).toEqual({ allow: ["192.168.1.50:9001"], private: ["192.168.1.50:9001"] }));
    // A public name: opened, but never trusted for a private address, so re-pointing it at the stack can't open the stack (BOS-708).
    await c.req("PUT", url, { url: "https://penpot.example.com", agentIds: [], exportAgentIds: [] });
    await vi.waitFor(() => expect(c.lastAllow()).toEqual({ allow: ["penpot.example.com:443"], private: [] }));
    // Changed on the Secrets page instead.
    const grants = (await c.req("GET", `/api/companies/${c.co.id}/grants`)).json() as Array<{ envName: string; secretId: string; id: string }>;
    const urlGrant = grants.find((g) => g.envName === "PENPOT_URL")!;
    expect((await c.req("PUT", `/api/secrets/${urlGrant.secretId}/value`, { value: "http://192.168.1.60:9001" })).statusCode).toBe(200);
    await vi.waitFor(() => expect(c.lastAllow()).toEqual({ allow: ["192.168.1.60:9001"], private: ["192.168.1.60:9001"] }));
    // Revoked on the Secrets page.
    expect((await c.req("DELETE", `/api/grants/${urlGrant.id}`)).statusCode).toBe(204);
    await vi.waitFor(() => expect(c.lastAllow()).toEqual({ allow: [], private: [] }));
    // Set again with the form, then removed with it: the grants go, the guard closes, and a later save reuses the unused secret.
    await c.req("PUT", url, { url: "http://192.168.1.70:9001", agentIds: [], exportAgentIds: [] });
    await vi.waitFor(() => expect(c.lastAllow()).toEqual({ allow: ["192.168.1.70:9001"], private: ["192.168.1.70:9001"] }));
    expect(((await c.req("GET", "/api/secrets")).json() as Array<{ name: string }>).filter((s) => s.name.startsWith("PENPOT_URL"))).toHaveLength(1);
    expect((await c.req("DELETE", url)).json()).toMatchObject({ configured: false });
    await vi.waitFor(() => expect(c.lastAllow()).toEqual({ allow: [], private: [] }));
    // Deleting a secret granted as PENPOT_URL closes the address too.
    await c.req("PUT", url, { url: "http://192.168.1.80:9001", token: TOKEN, agentIds: [], exportAgentIds: [] });
    await vi.waitFor(() => expect(c.lastAllow()).toEqual({ allow: ["192.168.1.80:9001"], private: ["192.168.1.80:9001"] }));
    const again = ((await c.req("GET", `/api/companies/${c.co.id}/grants`)).json() as Array<{ envName: string; secretId: string }>).find((g) => g.envName === "PENPOT_URL")!;
    expect((await c.req("DELETE", `/api/secrets/${again.secretId}`)).statusCode).toBe(204);
    await vi.waitFor(() => expect(c.lastAllow()).toEqual({ allow: [], private: [] }));
  });

  it("changes a value for this company only when another company shares the secret", async () => {
    const c = (ctx = await setup());
    const other = await c.company("Other Co");
    const s = (await c.req("POST", "/api/secrets", { name: "PENPOT_URL", kind: "generic", value: "http://192.168.1.50:9001" })).json() as { secret: { id: string } };
    for (const id of [c.co.id, other.id]) await c.req("POST", `/api/secrets/${s.secret.id}/grants`, { companyId: id, envName: "PENPOT_URL" });
    await c.req("PUT", `/api/companies/${c.co.id}/penpot`, { url: "http://192.168.1.99:9001", token: TOKEN, agentIds: [], exportAgentIds: [] });
    expect((await c.secrets.resolveCompanyEnv(c.co.id, "check")).PENPOT_URL).toBe("http://192.168.1.99:9001");
    expect((await c.secrets.resolveCompanyEnv(other.id, "check")).PENPOT_URL).toBe("http://192.168.1.50:9001");
    const names = ((await c.req("GET", "/api/secrets")).json() as Array<{ name: string }>).map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["PENPOT_URL", "PENPOT_URL (App Co)"]));
  });

  it("refuses a save that would leave Penpot half set up, and writes nothing", async () => {
    const c = (ctx = await setup());
    const other = await c.company("Other Co");
    const outsider = (await c.req("POST", `/api/companies/${other.id}/agents`, { name: "Outsider" })).json() as { id: string };
    const url = `/api/companies/${c.co.id}/penpot`;
    const base = { url: "http://192.168.1.50:9001", token: TOKEN, agentIds: [], exportAgentIds: [] };
    for (const [bad, why] of [
      [{ ...base, token: "" }, "address and an access token"],
      [{ ...base, url: "" }, "address and an access token"],
      [{ ...base, email: "agent@example.com" }, "both the export email and password"],
      [{ ...base, password: PASSWORD }, "both the export email and password"],
      [{ ...base, url: "ftp://192.168.1.50/" }, "http:// or https://"],
      [{ ...base, url: "http://agent:secret@192.168.1.50:9001" }, "Leave the login out"],
      [{ ...base, url: "http://db:5432" }, "can't open that address"],
      [{ ...base, url: "http://[fd00::1]:9001" }, "can't open that address"],
      [{ ...base, agentIds: [outsider.id] }, "belong to this company"],
    ] as const) {
      const r = await c.req("PUT", url, bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(400);
      expect(r.body, JSON.stringify(bad)).toContain(why);
    }
    expect((await c.req("GET", `/api/companies/${c.co.id}/grants`)).json()).toEqual([]);
    expect((await c.req("GET", "/api/secrets")).json()).toEqual([]);
    // Owner only.
    expect((await c.noCookie("GET", url)).statusCode).toBe(401);
    expect((await c.noCookie("PUT", url)).statusCode).toBe(401);
  });

  it("answers 404 when Penpot is removed from a company that does not exist, and revokes nothing (BOS-2100)", async () => {
    const c = (ctx = await setup());
    await c.req("PUT", `/api/companies/${c.co.id}/penpot`, { url: "http://192.168.1.50:9001", token: TOKEN, agentIds: [], exportAgentIds: [] });
    const r = await c.req("DELETE", "/api/companies/00000000-0000-4000-8000-000000000000/penpot");
    expect(r.statusCode).toBe(404);
    expect(r.json()).toMatchObject({ error: "not_found" });
    expect(((await c.req("GET", `/api/companies/${c.co.id}/penpot`)).json() as View).configured).toBe(true);
  });

  it("removes only the export login when asked, keeping the rest", async () => {
    const c = (ctx = await setup());
    const url = `/api/companies/${c.co.id}/penpot`;
    await c.req("PUT", url, { url: "http://192.168.1.50:9001", token: TOKEN, email: "agent@example.com", password: PASSWORD, agentIds: [], exportAgentIds: [c.designer.id] });
    const v = (await c.req("PUT", url, { email: null, password: null, agentIds: [], exportAgentIds: [] })).json() as View;
    expect(v).toMatchObject({ configured: true, email: { set: false }, password: { set: false } });
    const env = await c.secrets.resolveCompanyEnv(c.co.id, "check");
    expect(env.PENPOT_TOKEN).toBe(TOKEN);
    expect(env.PENPOT_PASSWORD).toBeUndefined();
  });

  it("penpotAddress opens only a plain http(s) host:port that isn't one of Boss Man's own services", () => {
    expect(penpotAddress("http://192.168.1.50:9001")).toBe("192.168.1.50:9001");
    expect(penpotAddress("https://penpot.example.com/")).toBe("penpot.example.com:443");
    expect(penpotAddress("http://penpot.lan")).toBe("penpot.lan:80");
    expect(penpotAddress("ftp://192.168.1.50")).toBeNull();
    expect(penpotAddress("http://server:3100")).toBeNull();
    expect(penpotAddress("http://db:5432")).toBeNull();
    expect(penpotAddress("http://[fd00::1]:9001")).toBeNull();
    expect(penpotAddress("not a url")).toBeNull();
  });
});
