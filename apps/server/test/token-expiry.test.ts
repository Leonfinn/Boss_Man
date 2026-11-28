// BOS-2825: a git or Claude token with an end date gets one owner card a week before it ends, naming the token and how
// to replace it; a new value closes it. A token saved before this change has no date and gets no reminder.
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import { clearWhenOf } from "../src/services/alert-clearing.js";
import { decisions, secrets } from "../src/db/schema.js";
import { dueTokens, EXPIRY_WARN_MS, expiryQuestion, tokenExpiryKey } from "../src/services/token-expiry.js";

// Made-up key shapes, joined at run time so this file holds no key-shaped line for the secret scans (BOS-1932).
const CLAUDE_TOKEN = ["sk-ant-oat01", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("-");
const GIT_TOKEN = ["ghp", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"].join("_");

const DAY = 86_400_000;
const day = (from: Date, offsetDays: number) => new Date(from.getTime() + offsetDays * DAY).toISOString().slice(0, 10);

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.app.close();
  await ctx?.close();
  ctx = undefined;
});

async function setup(now = { at: new Date() }) {
  const { db, close } = await openPglite();
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false, limits: { quickBatchMs: 0 }, workspaceRoot: "/ws", now: () => now.at });
  const s = await built.app.inject({ method: "POST", url: "/api/setup", payload: { username: "leon", password: "correct horse battery" } });
  const cookie = `bm_session=${s.cookies.find((c) => c.name === "bm_session")!.value}`;
  const req = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) => built.app.inject({ method, url, headers: { cookie }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const { company } = (await req("POST", "/api/companies", { name: "App Co" })).json() as { company: { id: string } };
  const save = async (body: Record<string, unknown>) => {
    const r = await req("POST", "/api/secrets", body);
    return r;
  };
  return { ...built, db, close, req, company, save, now };
}

/** Runs the reminder pass and the closer, as the leader's timers would. */
async function pass(c: NonNullable<typeof ctx>) {
  const { raised } = await c.tokenExpiry.check();
  await c.alerts.sweep();
  return raised;
}

const isExpiryCard = (d: typeof decisions.$inferSelect) => !!d.dedupeKey?.startsWith("alert:token-expiry:") || (d.context as { ladder?: { kind?: string } }).ladder?.kind === "token_expiry";
const openCards = async (c: NonNullable<typeof ctx>) => (await c.db.select().from(decisions).where(eq(decisions.status, "open"))).filter(isExpiryCard);
const allCards = async (c: NonNullable<typeof ctx>) => (await c.db.select().from(decisions)).filter(isExpiryCard);

describe("token end dates (BOS-2825)", () => {
  it("stores the end date given when a token is saved and returns it, and leaves a kind that doesn't expire with none", async () => {
    const c = (ctx = await setup());
    const ends = day(c.now.at, 60);
    const saved = await c.save({ name: "App Co git token", kind: "generic", value: GIT_TOKEN, endsOn: ends });
    expect(saved.statusCode).toBe(201);
    const body = saved.json() as { secret: { id: string; expiresAt: string | null } };
    expect(body.secret.expiresAt).toBe(ends);
    const listed = (await c.req("GET", "/api/secrets")).json() as Array<{ id: string; expiresAt: string | null }>;
    expect(listed.find((s) => s.id === body.secret.id)?.expiresAt).toBe(ends);
    // An API key has no end date: a date given for one is dropped rather than stored.
    const key = (await c.save({ name: "Anthropic key", kind: "anthropic_api_key", value: ["sk-ant-api03", "AbCdEfGhIjKlMnOpQrStUvWxYz"].join("-"), endsOn: ends })).json() as { secret: { expiresAt: string | null } };
    expect(key.secret.expiresAt).toBeNull();
    // A date that isn't a real day is refused before anything is stored.
    expect((await c.save({ name: "Bad", kind: "generic", value: GIT_TOKEN, endsOn: "2027-02-30" })).statusCode).toBe(400);
  });

  it("raises exactly one card naming the token and where to replace it seven days before, and a new value closes it", async () => {
    const at = new Date("2026-11-27T09:00:00Z");
    const now = { at };
    const c = (ctx = await setup(now));
    const ends = day(at, 7);
    const saved = (await c.save({ name: "App Co Claude token", kind: "claude_oauth_token", value: CLAUDE_TOKEN, endsOn: ends })).json() as { secret: { id: string } };
    const secretId = saved.secret.id;
    // 8 days out: nothing yet.
    now.at = new Date(Date.parse(`${ends}T00:00:00Z`) - 8 * DAY);
    expect(await pass(c)).toEqual([]);
    expect(await allCards(c)).toHaveLength(0);
    // Inside the week: exactly one card, on the owner's queue, naming the token and both steps.
    now.at = new Date(Date.parse(`${ends}T00:00:00Z`) - 6 * DAY);
    expect(await pass(c)).toEqual([secretId]);
    const cards = await openCards(c);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "question", tier: "owner", dedupeKey: tokenExpiryKey(secretId) });
    expect((cards[0]!.context as { ladder?: { kind?: string } }).ladder?.kind).toBe("token_expiry");
    expect(cards[0]!.question).toContain("App Co Claude token");
    expect(cards[0]!.question).toContain("Claude setup-token");
    expect(cards[0]!.question).toContain("Settings → Secrets, find App Co Claude token and paste the new value in its Rotate box");
    expect(cards[0]!.question).toContain("claude setup-token");
    expect(clearWhenOf(cards[0]!.context)).toEqual([{ kind: "secretReplaced", secretId, version: 1 }]);
    // A second pass the same day, and the next day, raises nothing more while it is open.
    expect(await pass(c)).toEqual([]);
    now.at = new Date(Date.parse(`${ends}T00:00:00Z`) - 5 * DAY);
    expect(await pass(c)).toEqual([]);
    expect(await openCards(c)).toHaveLength(1);
    // A new value closes it by itself, saying why.
    await c.req("PUT", `/api/secrets/${secretId}/value`, { value: CLAUDE_TOKEN.replace(/9$/, "8"), endsOn: day(now.at, 365) });
    await c.alerts.sweep();
    const [closed] = await allCards(c);
    expect(closed!.status).toBe("withdrawn");
    expect(closed!.question).toBe(cards[0]!.question);
    expect((closed!.context as { withdrawn?: { note?: string } }).withdrawn?.note).toMatch(/a new value was saved for App Co Claude token/);
  });

  it("does not warn again when the owner replaces the token with no new date, and an Add leaves the old secret's card alone", async () => {
    const at = new Date("2026-11-27T09:00:00Z");
    const now = { at };
    const c = (ctx = await setup(now));
    const ends = day(at, 6);
    const saved = (await c.save({ name: "App Co git token", kind: "generic", value: GIT_TOKEN, endsOn: ends })).json() as { secret: { id: string } };
    const secretId = saved.secret.id;
    expect(await pass(c)).toEqual([secretId]);
    // Rotated the way the Secrets page sends it with the date left empty: the old date goes, so the next pass is quiet.
    const rotated = (await c.req("PUT", `/api/secrets/${secretId}/value`, { value: GIT_TOKEN.replace(/9$/, "8"), endsOn: null })).json() as { secret: { expiresAt: string | null; version: number } };
    expect(rotated.secret.version).toBe(2);
    expect(rotated.secret.expiresAt).toBeNull();
    expect(await pass(c)).toEqual([]);
    expect(await openCards(c)).toHaveLength(0);
    // A put that leaves the date out altogether clears it too: the date belonged to the old value.
    const again = (await c.req("PUT", `/api/secrets/${secretId}/value`, { value: GIT_TOKEN.replace(/8$/, "7") })).json() as { secret: { expiresAt: string | null } };
    expect(again.secret.expiresAt).toBeNull();
    // Adding a new secret is a different secret: it has its own date and card, and the old one is untouched.
    now.at = new Date(Date.parse(`${ends}T00:00:00Z`) - 5 * DAY);
    const added = (await c.save({ name: "App Co git token 2", kind: "generic", value: GIT_TOKEN, endsOn: day(now.at, 4) })).json() as { secret: { id: string } };
    expect(await pass(c)).toEqual([added.secret.id]);
    expect(await openCards(c)).toHaveLength(1);
  });

  it("raises no reminder for a token saved before this change, which has no date", async () => {
    const c = (ctx = await setup());
    // An old row as the migration left it: no date at all.
    const [row] = await c.db
      .insert(secrets)
      .values({ name: "Old git token", kind: "generic", hint: "••••1234", ciphertext: "x", wrappedKey: "x", expiresAt: null })
      .returning({ id: secrets.id });
    expect(await dueTokens(c.db, c.now.at)).toEqual([]);
    expect(await pass(c)).toEqual([]);
    expect((await allCards(c)).filter((d) => (d.context as { tokenExpiry?: { secretId: string } }).tokenExpiry?.secretId === row!.id)).toHaveLength(0);
    // As is a token saved now with the date cleared.
    const saved = (await c.save({ name: "Another token", kind: "generic", value: GIT_TOKEN })).json() as { secret: { expiresAt: string | null } };
    expect(saved.secret.expiresAt).toBeNull();
    expect(await pass(c)).toEqual([]);
  });

  it("still raises the card once the date has passed, so a lapsed token is never silent", async () => {
    const at = new Date("2026-11-27T09:00:00Z");
    const now = { at };
    const c = (ctx = await setup(now));
    const ends = day(at, 3);
    await c.save({ name: "Lapsed", kind: "generic", value: GIT_TOKEN, endsOn: ends });
    now.at = new Date(Date.parse(`${ends}T00:00:00Z`) + 2 * DAY);
    expect(await pass(c)).toHaveLength(1);
    const [card] = await openCards(c);
    expect(card!.question).toContain("this date has passed");
  });
});

describe("the expiry card's words", () => {
  it("say the day, the days left, and the two steps for a git token", () => {
    const now = new Date("2026-11-27T09:00:00Z");
    const text = expiryQuestion({ id: "s", name: "App Co git token", kind: "generic", version: 1, expiresAt: "2026-12-01" }, now);
    expect(text).toContain("token **App Co git token** ends 1 Dec 2026 (in 4 days)");
    expect(text).toContain("on GitHub, make a fine-grained token");
    expect(text).toContain("Settings → Secrets, find App Co git token and paste the new value in its Rotate box");
    expect(text).toContain("closes by itself");
  });

  it("name Gitea's own step when the token is Gitea's", () => {
    const text = expiryQuestion({ id: "s", name: "App Co Gitea token", kind: "generic", version: 1, expiresAt: "2026-12-01" }, new Date("2026-11-27T09:00:00Z"));
    expect(text).toContain("in Gitea, create a token with the write:repository scope");
  });

  it("have a week's window, no more", () => {
    expect(EXPIRY_WARN_MS).toBe(7 * DAY);
  });
});
