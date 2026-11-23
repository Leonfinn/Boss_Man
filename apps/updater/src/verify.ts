// Checks release.json's signature inside the updater, against one pinned identity (design section 3).
// Library: the `sigstore` Node package (spike on the real v0.1.0-beta.1 bundle, BOS-1225). Its trusted root comes from the
// official TUF mirror and is cached in the state volume; the library's embedded copy is the starting point and the fallback.
import { createHash, X509Certificate } from "node:crypto";
import { verify as sigstoreVerify } from "sigstore";
import { UpdaterError } from "./config.js";

export const OIDC_ISSUER = "https://token.actions.githubusercontent.com";

/** The one workflow that may sign a release: this repository's release.yml on main. Never taken from a request. */
export const releaseIdentity = (repo: string) => `https://github.com/${repo}/.github/workflows/release.yml@refs/heads/main`;

export type VerifyOptions = {
  certificateIssuer: string;
  certificateIdentityURI: string;
  tufCachePath: string;
  tufMirrorURL?: string;
  tufForceCache?: boolean;
  timeout?: number;
  retry?: number;
};
/** The shape of sigstore's verify(): a test passes a fake that sees every call's options. */
export type VerifyFn = (bundle: never, data: Buffer, options: VerifyOptions) => Promise<unknown>;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * release.yml signs with cosign 2.4.1, whose `--bundle` file is the older layout (base64Signature, cert, rekorBundle). The
 * sigstore package reads only the newer one, so an older file is turned into a v0.1 bundle (certificate chain, one transparency
 * log entry with its signed timestamp). Nothing is trusted from the conversion: the library still checks the certificate chain,
 * the log's signed timestamp, the identity and the signature over the exact bytes of release.json.
 * A file already in the newer layout passes through unchanged.
 */
export function toSigstoreBundle(raw: unknown, data: Buffer): object {
  if (!isObject(raw)) throw new UpdaterError("not_signed", "The signature file is not a Sigstore bundle.");
  if (typeof raw["mediaType"] === "string" && isObject(raw["verificationMaterial"])) return raw;
  const rekor = raw["rekorBundle"];
  const payload = isObject(rekor) ? rekor["Payload"] : undefined;
  if (typeof raw["cert"] !== "string" || typeof raw["base64Signature"] !== "string" || !isObject(rekor) || !isObject(payload)) {
    throw new UpdaterError("not_signed", "The signature file is not a Sigstore bundle.");
  }
  try {
    const der = new X509Certificate(Buffer.from(raw["cert"], "base64").toString("utf8")).raw;
    return {
      mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.1",
      verificationMaterial: {
        x509CertificateChain: { certificates: [{ rawBytes: der.toString("base64") }] },
        tlogEntries: [
          {
            logIndex: String(payload["logIndex"]),
            logId: { keyId: Buffer.from(String(payload["logID"]), "hex").toString("base64") },
            kindVersion: { kind: "hashedrekord", version: "0.0.1" },
            integratedTime: String(payload["integratedTime"]),
            inclusionPromise: { signedEntryTimestamp: rekor["SignedEntryTimestamp"] },
            canonicalizedBody: payload["body"],
          },
        ],
      },
      messageSignature: { messageDigest: { algorithm: "SHA2_256", digest: createHash("sha256").update(data).digest("base64") }, signature: raw["base64Signature"] },
    };
  } catch {
    throw new UpdaterError("not_signed", "The signature file is not a Sigstore bundle.");
  }
}

const codeOf = (e: unknown): string => (e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "");

/** Errors that mean "the root of trust I hold cannot vouch for this", as opposed to "this file is not signed by us". */
const ROOT_CODES = new Set(["CERTIFICATE_ERROR", "TLOG_INCLUSION_PROMISE_ERROR", "TLOG_INCLUSION_PROOF_ERROR", "TLOG_BODY_ERROR", "TIMESTAMP_ERROR"]);

export const ROOT_MESSAGE =
  "The updater could not check this release because its Sigstore trusted root looks out of date and it could not refresh it (no connection to the Sigstore mirror). Nothing was changed. Once the mirror is reachable, try again; if that does not help, install the newer updater from the release notes and recreate only the updater container.";

/**
 * Verifies release.json's signature against the pinned identity. Order: refresh the trusted root through TUF and verify. If TUF
 * cannot be reached, verify again from the cached or embedded root only (so an offline start still works for a current release);
 * if that fails in the way a stale root fails, say so with the root-specific message, not a generic one. Both calls carry the
 * same pinned issuer and subject: a refreshed root can add keys but never changes who may sign.
 */
export async function verifyRelease(
  args: { repo: string; data: Buffer; bundle: unknown; tufCachePath: string; tufMirrorURL?: string },
  verifyFn: VerifyFn = sigstoreVerify as unknown as VerifyFn,
): Promise<void> {
  const bundle = toSigstoreBundle(args.bundle, args.data);
  const base: VerifyOptions = {
    certificateIssuer: OIDC_ISSUER,
    certificateIdentityURI: releaseIdentity(args.repo),
    tufCachePath: args.tufCachePath,
    ...(args.tufMirrorURL ? { tufMirrorURL: args.tufMirrorURL } : {}),
    timeout: 15_000,
    retry: 1,
  };
  let usedCacheOnly = false;
  try {
    await verifyFn(bundle as never, args.data, base);
    return;
  } catch (first) {
    if (!codeOf(first).startsWith("TUF_")) throw classify(first, false);
  }
  usedCacheOnly = true;
  try {
    await verifyFn(bundle as never, args.data, { ...base, tufForceCache: true });
  } catch (second) {
    throw classify(second, usedCacheOnly);
  }
}

function classify(e: unknown, cacheOnly: boolean): UpdaterError {
  const code = codeOf(e);
  if (cacheOnly && (code.startsWith("TUF_") || ROOT_CODES.has(code))) return new UpdaterError("root_stale", ROOT_MESSAGE);
  if (code === "UNTRUSTED_SIGNER_ERROR") return new UpdaterError("not_signed", "This release was not signed by this project's release workflow, so it was refused.");
  if (code === "SIGNATURE_ERROR") return new UpdaterError("not_signed", "The signature does not match release.json (the file was changed), so the release was refused.");
  return new UpdaterError("not_signed", "The release signature could not be verified, so the release was refused.");
}
