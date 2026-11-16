// "Create phone login" (BOS-1004): the host deployer makes the phone's read-only ntfy user and sends the password back
// sealed. The server makes a throwaway RSA key pair for each request and keeps the private half in memory only, so the
// password is never in the clear in the inbox, the outbox, a log or the database. The browser gets it once.
import { constants, createPrivateKey, generateKeyPair, privateDecrypt, randomUUID, type KeyObject } from "node:crypto";
import { chmod, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const genKeyPair = promisify(generateKeyPair);

/** The read-only account the phone uses. Fixed here: the page offers no free text, so nothing odd reaches the host. */
export const PHONE_USER = "phone-read";
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
/** How long a request's key is kept, and so how long the owner has to pick the answer up. */
export const PHONE_LOGIN_TTL_MS = 10 * 60_000;

/** BOS-1581: the account Boss Man itself publishes with. Fixed here, like the phone's; the host checks it again. */
export const PUBLISH_USER = "bossman-publish";
const TOKEN = /^tk_[a-z0-9]{29}$/;

export type PhoneLoginAction = "create" | "reset" | "setup";

/** What the page needs to decide whether to show the button and what to say when it can't. */
export type PhoneLoginAvailability = { ok: true; container: string } | { ok: false; why: string };

const Answer = z.object({
  id: z.string(),
  result: z.string(),
  message: z.string().default(""),
  sealed: z.string().default(""),
});

export type PhoneLoginPoll =
  | { status: "pending" }
  | { status: "gone" }
  | { status: "timeout"; message: string }
  | { status: "done"; result: "created" | "reset"; password: string; user: string }
  // setup: the token was saved by the server; the answer never carries it.
  | { status: "done"; result: "setup"; message: string }
  | { status: "done"; result: "exists" | "missing" | "failed" | "rejected" | "unavailable"; message: string };

type Entry = { key: KeyObject; expires: number; taken: boolean; user: string; action: PhoneLoginAction; topic: string };

export function phoneLoginService(deps: {
  /** The deployer folder; absent when the server has none (then nothing can be asked of a host). */
  dir?: string;
  /** A host fact by dotted key, e.g. "addon.ntfy". */
  fact: (key: string) => Promise<string | null>;
  now?: () => number;
  /** BOS-1581: keeps the publish token (encrypted secret) and the topic in the notification settings. The token goes nowhere else. */
  saveSetup?: (r: { token: string; topic: string }) => Promise<void>;
}) {
  const now = deps.now ?? Date.now;
  // shortcut: one-time private keys, 10-minute expiry; lost on restart, harmless because the owner just clicks again and gets a new password.
  const entries = new Map<string, Entry>();
  const inbox = deps.dir ? path.join(deps.dir, "inbox", "phone-login.json") : null;
  const outbox = deps.dir ? path.join(deps.dir, "outbox", "phone-login.json") : null;

  const sweep = () => {
    for (const [id, e] of entries) if (e.expires <= now()) entries.delete(id);
  };

  async function availability(): Promise<PhoneLoginAvailability> {
    if (!deps.dir) return { ok: false, why: "This server has no host deployer, so it cannot make the login for you." };
    const addon = await deps.fact("addon.ntfy").catch(() => null);
    if (addon === null) return { ok: false, why: "The host has not reported yet. Try again in a minute." };
    if (addon === "not_set_up") return { ok: false, why: "The ntfy add-on is not set up on this host." };
    if (addon !== "running") return { ok: false, why: "The ntfy add-on is not running on this host." };
    const container = await deps.fact("ntfy.container").catch(() => null);
    if (!container) return { ok: false, why: "The host cannot see the ntfy container." };
    if ((await deps.fact("phoneLogin.openssl").catch(() => null)) === "false")
      return { ok: false, why: "The host needs openssl installed to hand the password back safely. Install it, or use the commands below." };
    return { ok: true, container };
  }

  /** Ask the host to make (or reset) the phone's user. Returns the request id to poll, or why not. */
  async function begin(action: PhoneLoginAction, topic: string): Promise<{ ok: true; id: string } | { ok: false; code: string; message: string }> {
    if (!inbox) return { ok: false, code: "no_deployer", message: "This server has no host deployer." };
    if (!TOPIC.test(topic)) return { ok: false, code: "bad_topic", message: "Save a topic first (letters, digits, - and _ only)." };
    const a = await availability();
    if (!a.ok) return { ok: false, code: "unavailable", message: a.why };
    sweep();
    // One at a time: a request the host has not picked up yet blocks a new one. Keys of earlier, abandoned requests are dropped.
    if (await stat(inbox).then(() => true, () => false))
      return { ok: false, code: "busy", message: "A phone login is already being made. Wait a minute and try again." };
    entries.clear();
    const { publicKey, privateKey } = await genKeyPair("rsa", { modulusLength: 3072, publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "der" } });
    const id = randomUUID();
    const user = action === "setup" ? PUBLISH_USER : PHONE_USER;
    const body = JSON.stringify({ id, action, user, topic, pubkey: publicKey.toString("base64") }) + "\n";
    const tmp = `${inbox}.tmp`;
    await writeFile(tmp, body, { mode: 0o640 });
    await chmod(tmp, 0o640);
    entries.set(id, { key: createPrivateKey({ key: privateKey, format: "der", type: "pkcs8" }), expires: now() + PHONE_LOGIN_TTL_MS, taken: false, user, action, topic });
    await rename(tmp, inbox);
    return { ok: true, id };
  }

  /** The answer for a request id. The password comes out once: a second call (or a wrong id) gets "gone". */
  async function poll(id: string): Promise<PhoneLoginPoll> {
    sweep();
    const e = entries.get(id);
    if (!e || e.taken || !outbox || !inbox) return { status: "gone" };
    let answer: z.infer<typeof Answer> | null = null;
    try {
      answer = Answer.parse(JSON.parse(await readFile(outbox, "utf8")));
    } catch {
      answer = null;
    }
    if (!answer || answer.id !== id) {
      // Not yet. The ask waits at most as long as the key does; then the unread request is withdrawn.
      if (e.expires - now() > PHONE_LOGIN_TTL_MS - 5 * 60_000) return { status: "pending" };
      entries.delete(id);
      await unlink(inbox).catch(() => undefined);
      return { status: "timeout", message: "The host did not answer in time. Check the host deployer is running, then try again." };
    }
    if (e.taken) return { status: "gone" };
    e.taken = true; // set before any await below, so two polls can't both take the password
    entries.delete(id);
    await unlink(outbox).catch(() => undefined);
    const message = answer.message.slice(0, 300);
    if (answer.result === "setup" && e.action === "setup") {
      const bad = { status: "done", result: "failed", message: "The host sent an answer this server could not read. Press the button again." } as const;
      if (!deps.saveSetup) return bad;
      try {
        const token = privateDecrypt(
          { key: e.key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
          Buffer.from(answer.sealed, "base64"),
        ).toString("utf8");
        if (!TOKEN.test(token)) return bad;
        await deps.saveSetup({ token, topic: e.topic });
        return { status: "done", result: "setup", message };
      } catch {
        return bad;
      }
    }
    if (e.action !== "setup" && (answer.result === "created" || answer.result === "reset")) {
      try {
        const password = privateDecrypt(
          { key: e.key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
          Buffer.from(answer.sealed, "base64"),
        ).toString("utf8");
        if (!/^[A-Za-z0-9]{24}$/.test(password)) return { status: "done", result: "failed", message: "The host sent an answer this server could not read. Reset the password to try again." };
        return { status: "done", result: answer.result, password, user: e.user };
      } catch {
        return { status: "done", result: "failed", message: "The host sent an answer this server could not read. Reset the password to try again." };
      }
    }
    const known = ["exists", "missing", "failed", "rejected", "unavailable"] as const;
    const result = known.find((k) => k === answer!.result) ?? "failed";
    return { status: "done", result, message };
  }

  return { availability, begin, poll };
}
