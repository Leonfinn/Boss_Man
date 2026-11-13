// BOS-979: the owner's private-details list for the merge-line scan: owner-only, write-only, encrypted at rest.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { settings } from "../src/db/schema.js";
import { parsePrivateDetails, privateDetailsService } from "../src/services/private-details.js";

let closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

async function setup() {
  const { db, close } = await openPglite();
  const master = { version: 1, key: randomBytes(32) };
  const built = await buildApp({ db, master, secureCookies: false, tickOnWake: false, workspaceRoot: "/ws" });
  closers.push(() => built.app.close(), close);
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  return { db, master, app: built.app, cookie };
}

// A documentation address stands in for the owner's real one.
const LIST = "192.0.2.77\nnas-box\n/mnt/tank1\nme@personal.test\nhost: other-host";

describe("private details setting", () => {
  it("needs the owner to read or write it", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/api/private-details" })).statusCode).toBe(401);
    expect((await app.inject({ method: "PUT", url: "/api/private-details", payload: { text: LIST } })).statusCode).toBe(401);
  });

  it("saves the list, gives back only counts, and keeps it encrypted at rest", async () => {
    const { app, cookie, db, master } = await setup();
    const put = await app.inject({ method: "PUT", url: "/api/private-details", headers: { cookie }, payload: { text: LIST } });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ total: 5, counts: { ip: 1, other: 1, path: 1, email: 1, host: 1 } });
    const get = await app.inject({ method: "GET", url: "/api/private-details", headers: { cookie } });
    expect(get.body).not.toContain("192.0.2.77");
    expect(get.body).not.toContain("tank1");
    const [row] = await db.select().from(settings).where(eq(settings.key, "private_details"));
    expect(JSON.stringify(row!.value)).not.toContain("192.0.2.77");
    // The runner hand-off decrypts it as kind<TAB>value lines.
    const sent = await privateDetailsService(db, master).forRunner();
    expect(sent!.split("\n")).toEqual(["ip\t192.0.2.77", "other\tnas-box", "path\t/mnt/tank1", "email\tme@personal.test", "host\tother-host"]);
  });

  it("an empty save clears the list, and an unsafe entry is refused", async () => {
    const { app, cookie, db, master } = await setup();
    await app.inject({ method: "PUT", url: "/api/private-details", headers: { cookie }, payload: { text: LIST } });
    expect((await app.inject({ method: "PUT", url: "/api/private-details", headers: { cookie }, payload: { text: "ab" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/private-details", headers: { cookie }, payload: { text: "" } })).json()).toEqual({ total: 0, counts: {} });
    expect(await privateDetailsService(db, master).forRunner()).toBeNull();
  });

  it("guesses a kind for a bare line and drops comments and repeats", () => {
    expect(parsePrivateDetails("# note\n192.168.7.\n192.168.7.\nUser@Mail.test\n/srv/data\nsomething")).toEqual([
      { kind: "ip", value: "192.168.7." },
      { kind: "email", value: "User@Mail.test" },
      { kind: "path", value: "/srv/data" },
      { kind: "other", value: "something" },
    ]);
  });
});
