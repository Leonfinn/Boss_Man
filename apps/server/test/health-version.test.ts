import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";

// BOS-2799: the health page reports the release the updater started this server from (BOSSMAN_VERSION), not package.json's
// 0.0.0, which nothing stamps at release. The version is read once when app.ts loads, so each case imports it fresh.

const pkgVersion = (JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  await close?.();
  close = undefined;
});

async function healthVersion() {
  vi.resetModules();
  const { buildApp } = await import("../src/app.js");
  const { openPglite } = await import("../src/db/client.js");
  const { db, close: closeDb } = await openPglite(undefined, { fresh: true });
  const built = await buildApp({ db, master: { version: 1, key: randomBytes(32) }, secureCookies: false, tickOnWake: false });
  close = async () => {
    await built.app.close();
    await closeDb();
  };
  return (await built.app.inject({ method: "GET", url: "/api/health" })).json().version as string;
}

it("health reports the release version the updater sets on an image install", async () => {
  vi.stubEnv("BOSSMAN_VERSION", "0.1.0-beta.3");
  expect(await healthVersion()).toBe("0.1.0-beta.3");
});

it("health falls back to package.json when no release version is set", async () => {
  vi.stubEnv("BOSSMAN_VERSION", "");
  expect(await healthVersion()).toBe(pkgVersion);
});
