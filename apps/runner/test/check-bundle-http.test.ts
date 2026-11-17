// BOS-1706: the runner's HTTP side of moving a check job's bundle (DR-060 part 2). No network: fetch is stubbed, and the
// only file I/O is a real temp file, so the tests pin the URL it builds, the headers it sends, and the words each
// failed download comes back with. Nothing here prints a token or a header.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadCheckBundle, uploadCheckBundle } from "../src/check-bundle-http.js";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-111111111111";
const TOKEN = "bmr_example_token";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), "bm-cbh-"));
  dirs.push(d);
  return d;
};
const bundleFile = (bytes: Buffer) => {
  const file = path.join(tmp(), "job.bundle");
  writeFileSync(file, bytes);
  return file;
};
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Stub fetch with one reply and hand back the calls it saw. */
function stubFetch(reply: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return reply(url, init);
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

/** The error an upload that is meant to be refused comes back with. */
async function uploadError(run: Promise<void>): Promise<Error> {
  try {
    await run;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the upload to be refused");
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("uploadCheckBundle", () => {
  it("PUTs the file to the job's URL with the runner's headers, trimming trailing slashes from the base", async () => {
    const bytes = Buffer.from("a small bundle");
    const file = bundleFile(bytes);
    const calls = stubFetch(async () => new Response(null, { status: 204 }));

    await uploadCheckBundle("http://127.0.0.1:8787///", TOKEN, JOB, file, { bytes: bytes.length, sha256: sha256(bytes) });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe(`http://127.0.0.1:8787/api/check-bundles/${JOB}`);
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual({
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/octet-stream",
      "content-length": String(bytes.length),
      "x-bundle-sha256": sha256(bytes),
    });
    const sent = Buffer.from(await new Response(init?.body as BodyInit).arrayBuffer());
    expect(sent).toEqual(bytes);
  });

  it("refuses a job id that isn't a UUID before it calls the server", async () => {
    const calls = stubFetch(async () => new Response(null, { status: 204 }));
    const bytes = Buffer.from("x");
    await expect(uploadCheckBundle("http://server", TOKEN, "not-a-uuid", bundleFile(bytes), { bytes: 1, sha256: sha256(bytes) })).rejects.toThrow("the job id isn't a UUID");
    expect(calls).toHaveLength(0);
  });

  it("names the job and the server's status and error, never the token", async () => {
    const bytes = Buffer.from("x");
    stubFetch(async () => Response.json({ error: "the server has no room for that bundle" }, { status: 507 }));

    const err = await uploadError(uploadCheckBundle("http://server", TOKEN, JOB, bundleFile(bytes), { bytes: 1, sha256: sha256(bytes) }));

    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(`the server refused the bundle upload for job ${JOB} (HTTP 507: the server has no room for that bundle)`);
    expect(err.message).not.toContain(TOKEN);
  });

  it("cuts a long server error to 100 characters and says only the status when the body isn't JSON", async () => {
    const bytes = Buffer.from("x");
    const long = "x".repeat(300);
    stubFetch(async () => Response.json({ error: long }, { status: 500 }));
    const cut = await uploadError(uploadCheckBundle("http://server", TOKEN, JOB, bundleFile(bytes), { bytes: 1, sha256: sha256(bytes) }));
    expect(cut.message).toBe(`the server refused the bundle upload for job ${JOB} (HTTP 500: ${"x".repeat(100)})`);

    stubFetch(async () => new Response("<html>nope</html>", { status: 502 }));
    const plain = await uploadError(uploadCheckBundle("http://server", TOKEN, JOB, bundleFile(bytes), { bytes: 1, sha256: sha256(bytes) }));
    expect(plain.message).toBe(`the server refused the bundle upload for job ${JOB} (HTTP 502)`);
  });
});

describe("downloadCheckBundle", () => {
  it("saves the bundle, returns null when size and sha256 match, and keeps the file private", async () => {
    const bytes = Buffer.from("the job's code");
    const file = path.join(tmp(), "downloaded.bundle");
    const calls = stubFetch(async () => new Response(bytes, { status: 200 }));

    const why = await downloadCheckBundle("http://server/", TOKEN, JOB, file, { bytes: bytes.length, sha256: sha256(bytes) });

    expect(why).toBeNull();
    expect(readFileSync(file)).toEqual(bytes);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(calls[0]!.url).toBe(`http://server/api/check-bundles/${JOB}`);
    expect(calls[0]!.init?.headers).toEqual({ authorization: `Bearer ${TOKEN}` });
  });

  it("calls a job id that isn't a UUID a download that couldn't be made, before it calls the server", async () => {
    // Unlike upload, download's own catch covers the bad-id throw, so it comes back as the job's reason, not a rejection.
    const calls = stubFetch(async () => new Response("x"));
    const file = path.join(tmp(), "x.bundle");
    const why = await downloadCheckBundle("http://server", TOKEN, "not-a-uuid", file, { bytes: 1, sha256: "a".repeat(64) });
    expect(why).toBe("couldn't reach the server for the code (Error)");
    expect(calls).toHaveLength(0);
  });

  it("says it couldn't reach the server, naming the error kind and not the token", async () => {
    stubFetch(async () => {
      throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
    });
    const why = await downloadCheckBundle("http://server", TOKEN, JOB, path.join(tmp(), "x.bundle"), { bytes: 1, sha256: "a".repeat(64) });
    expect(why).toBe("couldn't reach the server for the code (TimeoutError)");
    expect(why).not.toContain(TOKEN);
  });

  it("reports the status when the server gives no code", async () => {
    stubFetch(async () => new Response("gone", { status: 404 }));
    const why = await downloadCheckBundle("http://server", TOKEN, JOB, path.join(tmp(), "x.bundle"), { bytes: 1, sha256: "a".repeat(64) });
    expect(why).toBe("the server didn't give the code (HTTP 404)");
  });

  it("stops a bundle bigger than the runner reported", async () => {
    const bytes = Buffer.from("far too many bytes");
    stubFetch(async () => new Response(bytes, { status: 200 }));
    const why = await downloadCheckBundle("http://server", TOKEN, JOB, path.join(tmp(), "x.bundle"), { bytes: 4, sha256: sha256(bytes) });
    expect(why).toBe("the code download broke off: more bytes than the runner reported");
  });

  it("reports a short bundle with both sizes", async () => {
    const bytes = Buffer.from("abc");
    stubFetch(async () => new Response(bytes, { status: 200 }));
    const why = await downloadCheckBundle("http://server", TOKEN, JOB, path.join(tmp(), "x.bundle"), { bytes: 5, sha256: sha256(bytes) });
    expect(why).toBe("the code arrived short (3 of 5 bytes)");
  });

  it("reports a bundle whose bytes don't match the sha256 the runner sent", async () => {
    const bytes = Buffer.from("abc");
    stubFetch(async () => new Response(bytes, { status: 200 }));
    const why = await downloadCheckBundle("http://server", TOKEN, JOB, path.join(tmp(), "x.bundle"), { bytes: bytes.length, sha256: "a".repeat(64) });
    expect(why).toBe("the code that arrived doesn't match what the runner sent");
  });
});
