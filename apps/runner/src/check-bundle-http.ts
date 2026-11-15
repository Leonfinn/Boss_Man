// Moving a check job's git bundle through the server (DR-060 part 2, BOS-1436): the company runner uploads it with its
// runner token, the check worker downloads it with its worker token. Both stream: a first bundle is a few hundred MB.
// Errors and logs name the job and a status code only, never the token or a header.
import { createReadStream, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bundleUrl = (httpBase: string, jobId: string) => {
  if (!UUID.test(jobId)) throw new Error("the job id isn't a UUID");
  return `${httpBase.replace(/\/+$/, "")}/api/check-bundles/${jobId}`;
};

/** Streams a bundle file to the server for this job. Throws with the status the server gave when it refuses. */
export async function uploadCheckBundle(httpBase: string, token: string, jobId: string, file: string, meta: { bytes: number; sha256: string }, timeoutMs = 10 * 60_000): Promise<void> {
  const res = await fetch(bundleUrl(httpBase, jobId), {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": String(meta.bytes), "x-bundle-sha256": meta.sha256 },
    body: Readable.toWeb(createReadStream(file)) as unknown as BodyInit,
    duplex: "half",
    signal: AbortSignal.timeout(timeoutMs),
  } as RequestInit & { duplex: "half" });
  if (!res.ok) {
    const why = await res.json().then((b: { error?: unknown }) => (typeof b?.error === "string" ? b.error.slice(0, 100) : ""), () => "");
    throw new Error(`the server refused the bundle upload for job ${jobId} (HTTP ${res.status}${why ? `: ${why}` : ""})`);
  }
}

/**
 * Downloads this job's bundle into `file`, stopping past `bytes` and checking size and sha256 against what the runner
 * reported. Returns null when it arrived whole, else why not (a short reason for the job's log).
 */
export async function downloadCheckBundle(httpBase: string, token: string, jobId: string, file: string, want: { bytes: number; sha256: string }, timeoutMs = 10 * 60_000): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(bundleUrl(httpBase, jobId), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return `couldn't reach the server for the code (${(err as Error).name})`;
  }
  if (!res.ok || !res.body) return `the server didn't give the code (HTTP ${res.status})`;
  const hash = createHash("sha256");
  let bytes = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > want.bytes) return cb(new Error("more bytes than the runner reported"));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), count, createWriteStream(file, { mode: 0o600 }));
  } catch (err) {
    return `the code download broke off: ${(err as Error).message.slice(0, 200)}`;
  }
  if (bytes !== want.bytes) return `the code arrived short (${bytes} of ${want.bytes} bytes)`;
  if (hash.digest("hex") !== want.sha256) return "the code that arrived doesn't match what the runner sent";
  return null;
}
