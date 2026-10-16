// Envelope encryption for the secrets store (R13). Each secret gets its own random
// data key; the data key is wrapped by the master key, which never touches the database.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const ALG = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type MasterKey = { version: number; key: Buffer };

function seal(key: Buffer, plaintext: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}

function open(key: Buffer, sealed: string): Buffer {
  const raw = Buffer.from(sealed, "base64");
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error("Sealed value is too short");
  const decipher = createDecipheriv(ALG, key, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

export function encryptSecret(master: MasterKey, plaintext: string): { ciphertext: string; wrappedKey: string; masterKeyVersion: number } {
  const dataKey = randomBytes(32);
  try {
    return {
      ciphertext: seal(dataKey, Buffer.from(plaintext, "utf8")),
      wrappedKey: seal(master.key, dataKey),
      masterKeyVersion: master.version,
    };
  } finally {
    dataKey.fill(0);
  }
}

export function decryptSecret(master: MasterKey, sealed: { ciphertext: string; wrappedKey: string }): string {
  const dataKey = open(master.key, sealed.wrappedKey);
  try {
    return open(dataKey, sealed.ciphertext).toString("utf8");
  } finally {
    dataKey.fill(0);
  }
}

/** BOSSMAN_MASTER_KEY (base64, 32 bytes) or BOSSMAN_MASTER_KEY_FILE (a file holding that). */
export function loadMasterKey(env: NodeJS.ProcessEnv): MasterKey {
  const raw = env.BOSSMAN_MASTER_KEY ?? (env.BOSSMAN_MASTER_KEY_FILE ? readFileSync(env.BOSSMAN_MASTER_KEY_FILE, "utf8") : undefined);
  if (!raw) throw new Error("Set BOSSMAN_MASTER_KEY or BOSSMAN_MASTER_KEY_FILE (32 random bytes, base64). Generate one with: openssl rand -base64 32");
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) throw new Error(`The master key must decode to 32 bytes; got ${key.length}.`);
  return { version: 1, key };
}
