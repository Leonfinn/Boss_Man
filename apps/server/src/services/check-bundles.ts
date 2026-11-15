// Check job bundles on the server (DR-060 part 2, BOS-1436): the company runner uploads a git bundle of a job's code, the
// check worker that job was given downloads it. A bundle only has to last from upload to download (seconds to minutes),
// so it lives in a plain folder, not the database: BOSSMAN_CHECK_BUNDLE_DIR, else a folder under the OS temp dir. The
// server has no data volume of its own; a restart that loses the folder costs a re-send (the worker asks again).
//
// Bounds: one bundle at most BOSSMAN_CHECK_BUNDLE_MAX_MB (default 1024), the folder at most BOSSMAN_CHECK_BUNDLE_TOTAL_MB
// (default 4096). Files are named only by job id, which must be a UUID, so no path is ever built from other input. A
// bundle goes when its job ends; the folder is cleared at start-up and swept of files whose job isn't running.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MB = 1024 * 1024;
const OWN_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.bundle(\.part)?$/i;

export type PutResult = { ok: true; bytes: number; sha256: string } | { ok: false; status: 400 | 413 | 507; error: string };

const mbFromEnv = (raw: string | undefined, fallback: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function checkBundleStore(opts: { dir?: string; maxBytes?: number; totalBytes?: number } = {}) {
  const dir = path.resolve(opts.dir ?? (process.env.BOSSMAN_CHECK_BUNDLE_DIR?.trim() || path.join(tmpdir(), "bossman-check-bundles")));
  const maxBytes = opts.maxBytes ?? mbFromEnv(process.env.BOSSMAN_CHECK_BUNDLE_MAX_MB, 1024) * MB;
  const totalBytes = opts.totalBytes ?? mbFromEnv(process.env.BOSSMAN_CHECK_BUNDLE_TOTAL_MB, 4096) * MB;

  const file = (jobId: string) => {
    if (!UUID.test(jobId)) throw new Error("not a job id");
    return path.join(dir, `${jobId.toLowerCase()}.bundle`);
  };
  const ensure = () => mkdirSync(dir, { recursive: true, mode: 0o700 });
  /** What the folder holds now, finished and part-written files alike. */
  const used = () => {
    try {
      return readdirSync(dir).filter((n) => OWN_FILE.test(n)).reduce((n, name) => n + (statSync(path.join(dir, name), { throwIfNoEntry: false })?.size ?? 0), 0);
    } catch {
      return 0;
    }
  };

  return {
    dir,
    maxBytes,
    totalBytes,

    /**
     * Streams an upload in. `declared` is the Content-Length the uploader sent, checked against both caps before a byte
     * is written; the real count is checked as it arrives. `sha256`, when given, must match what arrived.
     */
    async put(jobId: string, body: Readable, want: { declared?: number; sha256?: string } = {}): Promise<PutResult> {
      const target = file(jobId);
      if (want.declared !== undefined && want.declared > maxBytes) return { ok: false, status: 413, error: "bundle_too_big" };
      ensure();
      if (used() + (want.declared ?? 0) > totalBytes) return { ok: false, status: 507, error: "bundle_store_full" };
      const part = `${target}.part`;
      const hash = createHash("sha256");
      let bytes = 0;
      const count = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          if (bytes > maxBytes) return cb(Object.assign(new Error("bundle_too_big"), { status: 413 }));
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(body, count, createWriteStream(part, { mode: 0o600 }));
      } catch (err) {
        rmSync(part, { force: true });
        if ((err as { status?: number }).status === 413) return { ok: false, status: 413, error: "bundle_too_big" };
        throw err;
      }
      const sha256 = hash.digest("hex");
      if ((want.sha256 && want.sha256 !== sha256) || (want.declared !== undefined && want.declared !== bytes)) {
        rmSync(part, { force: true });
        return { ok: false, status: 400, error: "bundle_mismatch" };
      }
      renameSync(part, target);
      return { ok: true, bytes, sha256 };
    },

    /** A finished bundle as a stream and its size, or null. */
    open(jobId: string): { stream: Readable; bytes: number } | null {
      const target = file(jobId);
      const st = statSync(target, { throwIfNoEntry: false });
      if (!st?.isFile()) return null;
      return { stream: createReadStream(target), bytes: st.size };
    },

    has: (jobId: string) => UUID.test(jobId) && !!statSync(file(jobId), { throwIfNoEntry: false })?.isFile(),

    remove(jobId: string) {
      if (!UUID.test(jobId)) return;
      rmSync(file(jobId), { force: true });
      rmSync(`${file(jobId)}.part`, { force: true });
    },

    /**
     * Removes every bundle whose job is not in `live` (running jobs on a worker). Returns the job ids removed. Only files
     * this store names (<uuid>.bundle, <uuid>.bundle.part) are ever touched, so a folder set to a shared place loses nothing else.
     */
    sweep(live: ReadonlySet<string>): string[] {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      const gone: string[] = [];
      for (const name of names) {
        const m = OWN_FILE.exec(name);
        if (!m || live.has(m[1]!.toLowerCase())) continue;
        rmSync(path.join(dir, name), { force: true });
        gone.push(m[1]!);
      }
      return gone;
    },

    /** Start-up: nothing in the folder belongs to a download in flight any more (a worker asks again). */
    clear() {
      ensure();
      this.sweep(new Set());
    },
  };
}

export type CheckBundleStore = ReturnType<typeof checkBundleStore>;
