// BOS-1894: an unreadable or missing master key file gives one plain line with the fix, not a raw EACCES stack.
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadMasterKey, MasterKeyFileError } from "../src/crypto.js";

const dir = mkdtempSync(path.join(tmpdir(), "master-key-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("loadMasterKey with a key file", () => {
  it("names the host file and the chown fix when the file is missing", () => {
    const file = path.join(dir, "absent.key");
    let err: unknown;
    try { loadMasterKey({ BOSSMAN_MASTER_KEY_FILE: file }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(MasterKeyFileError);
    const msg = (err as Error).message;
    expect(msg).toContain(file);
    expect(msg).toContain("secrets/master.key");
    expect(msg).toContain("chown 1000:1000");
    expect(msg).toContain("chmod 600");
  });

  it.skipIf(process.getuid?.() === 0)("gives the same fix when the file is not readable", () => {
    const file = path.join(dir, "locked.key");
    writeFileSync(file, Buffer.alloc(32, 1).toString("base64"));
    chmodSync(file, 0o000);
    expect(() => loadMasterKey({ BOSSMAN_MASTER_KEY_FILE: file })).toThrow(MasterKeyFileError);
  });

  it("still reads a good key file", () => {
    const file = path.join(dir, "good.key");
    writeFileSync(file, Buffer.alloc(32, 2).toString("base64") + "\n");
    expect(loadMasterKey({ BOSSMAN_MASTER_KEY_FILE: file }).key.length).toBe(32);
  });
});
