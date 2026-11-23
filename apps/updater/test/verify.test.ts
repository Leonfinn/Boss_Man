// Design test 2: the signature check, on the REAL signed release.json of v0.1.0-beta.1 (the fixture) and on a fake verifier for
// the trusted-root cases. The real-crypto cases run offline: the library's embedded root, no network.
import { verify as sigstoreVerify } from "sigstore";
import { describe, expect, test } from "vitest";
import { UpdaterError } from "../src/config.js";
import { OIDC_ISSUER, releaseIdentity, ROOT_MESSAGE, toSigstoreBundle, verifyRelease, type VerifyFn, type VerifyOptions } from "../src/verify.js";
import { FIXTURE_REPO, fixture, tmpDir } from "./helpers.js";

const data = fixture("release.json");
const bundle = JSON.parse(fixture("release.json.sigstore.json").toString("utf8"));

/** The real library, but never the network: the embedded trusted root only. */
const offlineReal: VerifyFn = (b, d, o) => sigstoreVerify(b as never, d, { ...o, tufForceCache: true } as never);

const reject = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as UpdaterError;
  }
  throw new Error("expected the check to refuse");
};

describe("the real v0.1.0-beta.1 release", () => {
  test("verifies with the pinned identity (the old cosign bundle layout is converted)", async () => {
    await verifyRelease({ repo: FIXTURE_REPO, data, bundle, tufCachePath: tmpDir() }, offlineReal);
  });

  test("an edited release.json is refused", async () => {
    const edited = Buffer.from(data.toString("utf8").replace("0.1.0-beta.1", "0.1.0-beta.2"));
    const e = await reject(verifyRelease({ repo: FIXTURE_REPO, data: edited, bundle, tufCachePath: tmpDir() }, offlineReal));
    expect(e.code).toBe("not_signed");
    expect(e.message).toMatch(/may have been changed|does not match/);
    expect(e.message).not.toBe(ROOT_MESSAGE);
  });

  test("a release signed by another repository's workflow is refused (wrong repo, wrong subject)", async () => {
    const e = await reject(verifyRelease({ repo: "Someone/Else", data, bundle, tufCachePath: tmpDir() }, offlineReal));
    expect(e.code).toBe("not_signed");
    expect(e.message).toMatch(/not signed by this project/);
  });

  test("no signature at all, or a file that is not a bundle, is refused", async () => {
    for (const junk of [null, {}, [], "text", { cert: "x" }, { cert: "x", base64Signature: "y", rekorBundle: {} }]) {
      const e = await reject(verifyRelease({ repo: FIXTURE_REPO, data, bundle: junk, tufCachePath: tmpDir() }, offlineReal));
      expect(e.code).toBe("not_signed");
    }
  });

  test("a bundle in the newer layout passes through the converter unchanged", () => {
    const modern = { mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.3", verificationMaterial: {}, messageSignature: {} };
    expect(toSigstoreBundle(modern, data)).toBe(modern);
  });
});

describe("the trusted root (fake verifier sees every call)", () => {
  const code = (c: string) => Object.assign(new Error(c), { code: c });
  const run = (fn: VerifyFn) => verifyRelease({ repo: FIXTURE_REPO, data, bundle, tufCachePath: tmpDir() }, fn);

  test("every call carries the pinned issuer and subject, whatever the root does", async () => {
    const seen: VerifyOptions[] = [];
    const fn: VerifyFn = async (_b, _d, o) => {
      seen.push(o);
      if (!o.tufForceCache) throw code("TUF_FETCH_ERROR");
    };
    await run(fn);
    expect(seen).toHaveLength(2);
    for (const o of seen) {
      expect(o.certificateIssuer).toBe(OIDC_ISSUER);
      expect(o.certificateIdentityURI).toBe(releaseIdentity(FIXTURE_REPO));
    }
    expect(seen[0]!.tufForceCache).toBeUndefined();
    expect(seen[1]!.tufForceCache).toBe(true);
  });

  test("a stale root with the TUF mirror reachable passes (the refresh fixes it)", async () => {
    let calls = 0;
    await run(async () => {
      calls++;
    });
    expect(calls).toBe(1);
  });

  test("a stale root with no TUF mirror gives the root message, not a generic failure", async () => {
    const fn: VerifyFn = async (_b, _d, o) => {
      throw code(o.tufForceCache ? "CERTIFICATE_ERROR" : "TUF_FETCH_ERROR");
    };
    const e = await reject(run(fn));
    expect(e.code).toBe("root_stale");
    expect(e.message).toBe(ROOT_MESSAGE);
    expect(e.message).toMatch(/recreate only the updater/);
  });

  test("a bad certificate with a freshly refreshed root is a plain refusal, not the root message", async () => {
    const e = await reject(run(async () => Promise.reject(code("CERTIFICATE_ERROR"))));
    expect(e.code).toBe("not_signed");
    expect(e.message).not.toBe(ROOT_MESSAGE);
  });

  test("a wrong identity is refused even when the root is the problem elsewhere", async () => {
    const e = await reject(run(async () => Promise.reject(code("UNTRUSTED_SIGNER_ERROR"))));
    expect(e.code).toBe("not_signed");
  });
});
