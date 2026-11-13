import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PHONE_LOGIN_TTL_MS, PHONE_USER, phoneLoginService } from "../src/services/phone-login.js";

// "Create phone login" (BOS-1004): the password comes back sealed to a key only this process holds, once.

const PASSWORD = ["sample", "fake", "pw"].join("-").padEnd(24, "x"); // 24 characters, like the host makes
let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

const FACTS: Record<string, string> = { "addon.ntfy": "running", "ntfy.container": "ntfy-1", "phoneLogin.openssl": "true" };

async function setup(facts: Record<string, string> = FACTS) {
  const dir = await mkdtemp(path.join(tmpdir(), "bm-phonelogin-"));
  dirs.push(dir);
  await mkdir(path.join(dir, "inbox"));
  await mkdir(path.join(dir, "outbox"));
  const clock = { t: 1_000_000 };
  const svc = phoneLoginService({ dir, fact: async (k) => facts[k] ?? null, now: () => clock.t });
  return { dir, clock, svc };
}

/** Plays the host: reads the request and answers the way scripts/host-deployer.sh does (RSA-OAEP, SHA-256). */
async function hostAnswers(dir: string, result: string, opts: { message?: string; password?: string; id?: string } = {}) {
  const req = JSON.parse(await readFile(path.join(dir, "inbox", "phone-login.json"), "utf8")) as { id: string; pubkey: string };
  const key = createPublicKey({ key: Buffer.from(req.pubkey, "base64"), format: "der", type: "spki" });
  const sealed = opts.password === undefined && !["created", "reset"].includes(result) ? "" : publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(opts.password ?? PASSWORD)).toString("base64");
  await writeFile(path.join(dir, "outbox", "phone-login.json"), JSON.stringify({ id: opts.id ?? req.id, result, message: opts.message ?? "", sealed, at: "x" }));
  return req;
}

async function allFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) out.push(path.join(e.parentPath, e.name));
  return out;
}

describe("phoneLoginService", () => {
  it("asks the host with a public key, then hands the password out once", async () => {
    const { dir, svc } = await setup();
    const r = await svc.begin("create", "alerts");
    expect(r.ok).toBe(true);
    const id = (r as { id: string }).id;
    // The request carries the fixed user, the topic and a public key: no secret.
    const reqFile = path.join(dir, "inbox", "phone-login.json");
    expect((await stat(reqFile)).mode & 0o777).toBe(0o640);
    const asked = JSON.parse(await readFile(reqFile, "utf8"));
    expect(asked).toMatchObject({ id, action: "create", user: PHONE_USER, topic: "alerts" });
    expect(Object.keys(asked).sort()).toEqual(["action", "id", "pubkey", "topic", "user"]);
    expect(await svc.poll(id)).toEqual({ status: "pending" });
    await hostAnswers(dir, "created");
    expect(await svc.poll(id)).toEqual({ status: "done", result: "created", password: PASSWORD, user: PHONE_USER });
    // A second pickup gets nothing, and the host's answer file is gone.
    expect(await svc.poll(id)).toEqual({ status: "gone" });
    for (const f of await allFiles(dir)) expect(await readFile(f, "utf8")).not.toContain(PASSWORD);
    expect(await allFiles(path.join(dir, "outbox"))).toEqual([]);
  });

  it("gives nothing to a wrong request id, and a stranger's answer id is not taken", async () => {
    const { dir, svc } = await setup();
    const r = (await svc.begin("create", "alerts")) as { id: string };
    expect(await svc.poll("00000000-0000-4000-8000-000000000001")).toEqual({ status: "gone" });
    await hostAnswers(dir, "created", { id: "00000000-0000-4000-8000-000000000002" });
    expect(await svc.poll(r.id)).toEqual({ status: "pending" });
  });

  it("drops the key after ten minutes", async () => {
    const { dir, clock, svc } = await setup();
    const r = (await svc.begin("reset", "alerts")) as { id: string };
    await hostAnswers(dir, "reset");
    clock.t += PHONE_LOGIN_TTL_MS + 1;
    expect(await svc.poll(r.id)).toEqual({ status: "gone" });
  });

  it("gives up after five minutes without an answer and withdraws the unread request", async () => {
    const { dir, clock, svc } = await setup();
    const r = (await svc.begin("create", "alerts")) as { id: string };
    clock.t += 5 * 60_000 + 1;
    expect(await svc.poll(r.id)).toMatchObject({ status: "timeout" });
    await expect(stat(path.join(dir, "inbox", "phone-login.json"))).rejects.toThrow();
    expect(await svc.poll(r.id)).toEqual({ status: "gone" });
  });

  it("passes the host's no-password answers on without a password", async () => {
    for (const result of ["exists", "missing", "failed", "rejected", "unavailable"] as const) {
      const { dir, svc } = await setup();
      const r = (await svc.begin("create", "alerts")) as { id: string };
      await hostAnswers(dir, result, { message: `m-${result}` });
      expect(await svc.poll(r.id)).toEqual({ status: "done", result, message: `m-${result}` });
    }
  });

  it("does not trust a password that decrypts to the wrong shape or an answer sealed to another key", async () => {
    const a = await setup();
    const ra = (await a.svc.begin("create", "alerts")) as { id: string };
    await hostAnswers(a.dir, "created", { password: "short" });
    expect(await a.svc.poll(ra.id)).toMatchObject({ status: "done", result: "failed" });
    // Sealed to key B, polled with key A's id: it cannot be read.
    const b = await setup();
    await b.svc.begin("create", "alerts");
    const reqB = JSON.parse(await readFile(path.join(b.dir, "inbox", "phone-login.json"), "utf8")) as { pubkey: string };
    const a2 = await setup();
    const r2 = (await a2.svc.begin("create", "alerts")) as { id: string };
    const sealed = publicEncrypt({ key: createPublicKey({ key: Buffer.from(reqB.pubkey, "base64"), format: "der", type: "spki" }), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(PASSWORD)).toString("base64");
    await writeFile(path.join(a2.dir, "outbox", "phone-login.json"), JSON.stringify({ id: r2.id, result: "created", message: "", sealed }));
    const got = await a2.svc.poll(r2.id);
    expect(got).toMatchObject({ status: "done", result: "failed" });
    expect(JSON.stringify(got)).not.toContain(PASSWORD);
  });

  it("explains why it can't start: no report, no add-on, not running, no container, no openssl, bad topic, busy", async () => {
    const why = async (facts: Record<string, string>, topic = "alerts") => {
      const { svc } = await setup(facts);
      const r = await svc.begin("create", topic);
      return r.ok ? "ok" : r.code;
    };
    expect(await why({})).toBe("unavailable");
    expect(await why({ ...FACTS, "addon.ntfy": "not_set_up" })).toBe("unavailable");
    expect(await why({ ...FACTS, "addon.ntfy": "stopped" })).toBe("unavailable");
    expect(await why({ "addon.ntfy": "running" })).toBe("unavailable");
    expect(await why({ ...FACTS, "phoneLogin.openssl": "false" })).toBe("unavailable");
    expect(await why(FACTS, "bad topic!")).toBe("bad_topic");
    const { svc } = await setup();
    expect((await svc.begin("create", "alerts")).ok).toBe(true);
    expect(await svc.begin("create", "alerts")).toMatchObject({ ok: false, code: "busy" });
    // An older deployer that reports no openssl fact is not blocked by it.
    expect(await why({ "addon.ntfy": "running", "ntfy.container": "n" })).toBe("ok");
  });

  it("has nothing to do without a deployer folder", async () => {
    const svc = phoneLoginService({ fact: async () => "running" });
    expect(await svc.begin("create", "alerts")).toMatchObject({ ok: false, code: "no_deployer" });
    expect(await svc.availability()).toMatchObject({ ok: false });
    expect(await svc.poll("00000000-0000-4000-8000-000000000001")).toEqual({ status: "gone" });
  });
});
