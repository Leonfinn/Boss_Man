// BOS-708: migration 0127 marks existing tool servers whose host was meant for a private address as trusted, so the
// stricter network guard keeps working for them after the deploy. The test reads each statement straight out of the
// committed migration file and runs it against real rows. It catches a cast that can throw on a host that merely
// looks dotted: if 0127 used `::int` on a split octet, a name such as evil.example.org or x.y.z.w would fail the
// migration, and a failed migration stops the server starting after the deploy.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq, sql } from "drizzle-orm";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { companies, mcpServers } from "../src/db/schema.js";

const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle/0128_allow_private.sql");

/** The UPDATE on mcp_servers from the migration file, on its own, ready to run. */
function mcpServersUpdate(): string {
  const body = readFileSync(migrationPath, "utf8");
  const start = body.indexOf('UPDATE "mcp_servers"');
  const end = body.indexOf("--> statement-breakpoint", start);
  if (start < 0 || end < 0) throw new Error("0127_allow_private.sql has no mcp_servers UPDATE statement");
  return body.slice(start, end).trim();
}

let db: Awaited<ReturnType<typeof openPglite>>["db"];
let close: () => Promise<void>;
let companyId: string;

beforeEach(async () => {
  ({ db, close } = await openPglite());
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false });
  await built.app.close();
  companyId = (await db.insert(companies).values({ name: "Co" }).returning())[0]!.id;
});
afterEach(async () => {
  await close();
});

/** Insert tool servers at these URLs, run 0127's UPDATE, and return the hosts that ended up trusted. */
async function trustedHosts(urls: string[]): Promise<Set<string>> {
  await db.insert(mcpServers).values(urls.map((url, i) => ({ companyId, name: `s${i}`, url, transport: "http" as const })));
  await db.execute(sql.raw(mcpServersUpdate()));
  const rows = await db.select({ url: mcpServers.url, allow: mcpServers.allowPrivate }).from(mcpServers).where(eq(mcpServers.companyId, companyId));
  return new Set(rows.filter((r) => r.allow).map((r) => r.url));
}

describe("migration 0127 trusts existing private-address tool servers (BOS-708)", () => {
  it("trusts private, loopback, link-local and CGNAT IPv4 literals and stack/LAN names", async () => {
    const trusted = await trustedHosts([
      "http://10.1.2.3:8080",
      "http://127.0.0.1:9090",
      "http://0.0.0.0:80",
      "http://169.254.1.1:80",
      "http://172.16.0.5:5432",
      "http://172.31.255.255:5432",
      "http://192.168.1.10:3000",
      "http://100.64.0.1:8080",
      "http://100.127.255.254:8080",
      "http://db:5432",
      "http://crawl4ai:11235",
      "http://host.local:80",
      "http://nas.internal:80",
    ]);
    expect([...trusted].sort()).toEqual(
      [
        "http://10.1.2.3:8080",
        "http://127.0.0.1:9090",
        "http://0.0.0.0:80",
        "http://169.254.1.1:80",
        "http://172.16.0.5:5432",
        "http://172.31.255.255:5432",
        "http://192.168.1.10:3000",
        "http://100.64.0.1:8080",
        "http://100.127.255.254:8080",
        "http://db:5432",
        "http://crawl4ai:11235",
        "http://host.local:80",
        "http://nas.internal:80",
      ].sort(),
    );
  });

  it("does not trust public names, boundary addresses, or dotted names that only look numeric, and never throws on them", async () => {
    const trusted = await trustedHosts([
      "https://evil.example.org:5432",
      "https://x.y.z.w:5432",
      "https://api.openai.com:443",
      "http://8.8.8.8:53",
      "http://11.0.0.1:80",
      "http://172.15.0.1:80",
      "http://172.32.0.1:80",
      "http://100.63.0.1:80",
      "http://100.128.0.1:80",
      "http://192.169.0.1:80",
      "https://evil.example.org:5432/sse?x=1",
    ]);
    expect([...trusted]).toEqual([]);
  });

  it("still matches a private literal behind userinfo (user@10.0.0.1:8080)", async () => {
    const trusted = await trustedHosts(["http://user@10.0.0.1:8080"]);
    expect(trusted.has("http://user@10.0.0.1:8080")).toBe(true);
  });
});
