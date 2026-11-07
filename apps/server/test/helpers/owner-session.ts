// A signed-in owner for a test app without POST /api/setup (BOS-661). That route hashes the password with
// scrypt (N=2^15, about 80 ms of CPU), which a test that only needs "an owner is logged in" pays on every
// test. This writes the same two rows the route writes (an owner and a session) and returns the cookie.
// The stored hash is never checked here: a test that logs in with a password, or tests /api/setup itself,
// should still go through the real route.
import { hashToken, newSessionToken, SESSION_COOKIE, SESSION_DAYS } from "../../src/auth.js";
import type { Db } from "../../src/db/client.js";
import { owners, sessions } from "../../src/db/schema.js";

// Same shape hashPassword makes ("scrypt$N$r$p$salt$hash"), for a password nobody knows.
const UNUSABLE_HASH = `scrypt$32768$8$1$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(32).toString("base64")}`;

export async function signedInOwner(db: Db, username = "leon"): Promise<string> {
  const [owner] = await db.insert(owners).values({ username, passwordHash: UNUSABLE_HASH }).returning();
  const token = newSessionToken();
  await db.insert(sessions).values({ tokenHash: hashToken(token), ownerId: owner!.id, expiresAt: new Date(Date.now() + SESSION_DAYS * 86_400_000) });
  return `${SESSION_COOKIE}=${token}`;
}
