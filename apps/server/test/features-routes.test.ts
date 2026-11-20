import { randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openPglite } from "../src/db/client.js";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { activity, companies } from "../src/db/schema.js";
import { featureRoutes } from "../src/routes/features.js";
import { FeedbackError, feedbackService } from "../src/services/feedback.js";
import { workService } from "../src/services/work.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => void (await close?.()));

const ID = "00000000-0000-4000-8000-000000000001";
// Every route in routes/features.ts (BOS-298 step 15): registered (not 404) and owner-session only (401 without it).
const ROUTES: Array<["GET" | "POST" | "PUT" | "PATCH" | "DELETE", string]> = [
  ["GET", `/api/companies/${ID}/feedback-settings`],
  ["PATCH", `/api/companies/${ID}/feedback-settings`],
  ["POST", `/api/companies/${ID}/feature-drivers`],
  ["PATCH", `/api/feature-drivers/${ID}`],
  ["DELETE", `/api/feature-drivers/${ID}`],
  ["POST", `/api/companies/${ID}/feature-areas`],
  ["PATCH", `/api/feature-areas/${ID}`],
  ["DELETE", `/api/feature-areas/${ID}`],
  ["PATCH", `/api/companies/${ID}/portal`],
  ["PUT", `/api/companies/${ID}/feedback/portal-logo`],
  ["DELETE", `/api/companies/${ID}/feedback/portal-logo`],
  ["GET", `/api/companies/${ID}/feedback/portal-logo`],
  ["POST", `/api/companies/${ID}/portal/rotate`],
  ["GET", `/api/companies/${ID}/features`],
  ["POST", `/api/companies/${ID}/features`],
  ["GET", `/api/features/${ID}`],
  ["PATCH", `/api/features/${ID}`],
  ["DELETE", `/api/features/${ID}`],
  ["POST", `/api/features/${ID}/tickets`],
  ["GET", `/api/companies/${ID}/feedback-customers`],
  ["GET", "/api/feedback/unprocessed"],
  ["GET", `/api/companies/${ID}/feedback`],
  ["POST", `/api/companies/${ID}/feedback`],
  ["GET", `/api/feedback/${ID}`],
  ["PATCH", `/api/feedback/${ID}`],
  ["DELETE", `/api/feedback/${ID}`],
  ["POST", `/api/feedback/${ID}/insights`],
  ["DELETE", `/api/insights/${ID}`],
];

it("every feature and feedback route is registered and answers 401 without the owner's session", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  const got = await Promise.all(ROUTES.map(async ([method, url]) => [method, url, (await built.app.inject({ method, url, payload: method === "GET" ? undefined : {} })).statusCode] as const));
  expect(got.filter(([, , status]) => status !== 401)).toEqual([]);
});

// BOS-2101: the portal's switches and a new share link leave a line in Activity.
async function portalApp() {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const app = Fastify();
  app.setErrorHandler((err, _req, reply) => (err instanceof FeedbackError ? reply.code(err.status).send({ message: err.message }) : reply.code(500).send({ message: String(err) })));
  const feedback = feedbackService(db);
  featureRoutes(app, db, { feedback, work: workService(db), portalUrl: "https://portal.example.com", mailer: { isConfigured: async () => true } });
  close = async () => {
    await app.close();
    await closeDb();
  };
  const [co] = await db.insert(companies).values({ name: "Co" }).returning();
  const lines = async () => (await db.select().from(activity).where(eq(activity.companyId, co!.id))).map((a) => a.summary);
  const patch = (payload: object, id = co!.id) => app.inject({ method: "PATCH", url: `/api/companies/${id}/portal`, payload });
  return { app, db, co: co!, lines, patch };
}

it("turning the portal on, email confirmation and the bare address each leave one line, and only when they change", async () => {
  const { patch, lines } = await portalApp();
  expect((await patch({ enabled: true, portalAtBareAddress: true, confirmByEmail: true, title: "Hi" })).statusCode).toBe(200);
  expect(await lines()).toEqual(["Owner turned the public portal on", "Owner made the portal the one the bare public address opens", "Owner turned on email confirmation of portal posts, comments and votes"]);
  // Same values again, and a words-only change: nothing new.
  await patch({ enabled: true, portalAtBareAddress: true, confirmByEmail: true });
  await patch({ title: "Other" });
  expect(await lines()).toHaveLength(3);
  await patch({ enabled: false, confirmByEmail: false, portalAtBareAddress: false });
  expect((await lines()).slice(3)).toEqual(["Owner turned the public portal off", "Owner stopped the portal opening at the bare public address", "Owner turned off email confirmation of portal posts, comments and votes"]);
});

it("a new share link leaves a line, never the token", async () => {
  const { app, co, lines, patch } = await portalApp();
  await patch({ enabled: true });
  const res = await app.inject({ method: "POST", url: `/api/companies/${co.id}/portal/rotate` });
  expect(res.statusCode).toBe(200);
  const token = res.json().portalToken as string;
  expect(token).toBeTruthy();
  const all = await lines();
  expect(all).toContain("Owner made a new portal link; old links stop working");
  expect(all.filter((s) => s.includes(token))).toEqual([]);
});

it("a refused or unknown-company portal request writes nothing", async () => {
  const { db, co, patch } = await portalApp();
  expect((await patch({ backUrl: "http://nope" })).statusCode).toBe(422);
  expect((await patch({ enabled: true, backUrl: "http://nope" })).statusCode).toBe(422);
  expect((await patch({ enabled: true }, "00000000-0000-4000-8000-0000000000aa")).statusCode).not.toBe(200);
  expect(await db.select().from(activity)).toEqual([]);
  expect(co.id).toBeTruthy();
});

it("the public portal answers without an owner session, so it is not owner-gated", async () => {
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  // The portal is off by default, so it answers 404 rather than asking for the owner's session (401).
  const res = await built.app.inject({ method: "GET", url: "/api/portal" });
  expect(res.statusCode).not.toBe(401);
  expect(res.statusCode).toBe(404);
});
