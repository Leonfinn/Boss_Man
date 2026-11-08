// Reading a .zip the owner attached (BOS-228): a company export is a zip, and an agent that can't open it
// has to send the owner back to unzip files by hand. The archive is untrusted: paths are checked, the entry
// count and the declared uncompressed size are capped, any entry inflating past its declared size or budget is
// refused (zlib's maxOutputLength, so a huge buffer is never allocated), overlapping entries are refused, and
// only text entries are inflated at all. Nothing is written anywhere and nothing is executed.
import { inflateRawSync } from "node:zlib";
import { cleanPath } from "./skills.js";

export const ZIP_LIMITS = {
  /** Entries named in the zip's index; a real company export has a few hundred at most. */
  entries: 5_000,
  /** Bytes actually unpacked, added up (the real zip-bomb guard: counted as inflation happens, not trusted). */
  unpackedBytes: 64 * 1024 * 1024,
  /** A single entry bigger than this is listed by name and size, never inflated. */
  entryBytes: 4 * 1024 * 1024,
  /** How much of a text entry is kept; the rest is reported as cut. */
  textPerEntry: 200_000,
};

export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type ZipEntry = { path: string; size: number };
export type ZipText = { path: string; text: string; truncated: boolean };

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;
const utf8 = new TextDecoder("utf-8", { fatal: true });

type Entry = { name: string; size: number; packed: number; offset: number; method: number };

/** The zip's central directory: every entry's name, its stated sizes and where its data starts. */
function index(zip: Buffer): Entry[] {
  const min = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) if (zip.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new ZipReadError("That file isn't a zip Boss Man can read.");
  const count = zip.readUInt16LE(eocd + 10);
  const start = zip.readUInt32LE(eocd + 16);
  const entries: Entry[] = [];
  let p = start;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || zip.readUInt32LE(p) !== CEN) throw new ZipReadError("That file isn't a zip Boss Man can read.");
    const method = zip.readUInt16LE(p + 10);
    const packed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, size, packed, offset, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry's bytes, inflated here and now with a hard output ceiling (a header can lie about its size). */
function readEntry(zip: Buffer, e: Entry): Buffer {
  if (e.method !== 0 && e.method !== 8) throw new ZipReadError(`This entry uses a compression method Boss Man can't read (method ${e.method}).`);
  if (e.size > ZIP_LIMITS.entryBytes) throw new ZipReadError("too big");
  const p = e.offset;
  if (p + 30 > zip.length || zip.readUInt32LE(p) !== LOC) throw new ZipReadError("That file isn't a zip Boss Man can read.");
  const nameLen = zip.readUInt16LE(p + 26);
  const extraLen = zip.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  // Only this entry's own packed bytes: never read on into the next entry or the central directory.
  const data = zip.subarray(start, Math.min(zip.length, start + e.packed));
  if (e.method === 0) return data.subarray(0, Math.min(e.size, data.length));
  // A ceiling of min(declared size, entryBytes): inflateRawSync hands back the full buffer only when it fits,
  // so an entry that lies small cannot make it allocate a huge one. A stream inflating past its declared size
  // is a bomb, refused here rather than trusted.
  const ceiling = Math.min(e.size, ZIP_LIMITS.entryBytes);
  try {
    return inflateRawSync(data, { maxOutputLength: Math.max(1, ceiling) });
  } catch (err) {
    const code = (err as { code?: string }).code;
    // The stream inflated past the ceiling: either a bomb or a header that understates the real size.
    if (code === "ERR_BUFFER_TOO_LARGE" || code === "ERR_OUT_OF_RANGE") throw new ZipReadError(`"${e.name}" unpacks to more than its ${Math.min(ceiling, ZIP_LIMITS.entryBytes)} bytes and isn't trusted, so Boss Man won't open it.`);
    throw new ZipReadError(`"${e.name}" isn't readable as a zip file's contents.`);
  }
}

/** A text file's bytes as text, or null when they aren't UTF-8 text (pictures, zips, anything binary). */
function asText(bytes: Buffer): string | null {
  const sample = bytes.subarray(0, 64 * 1024);
  if (sample.includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

const isTextName = (p: string) => /\.(txt|md|markdown|json|jsonc|ya?ml|toml|csv|tsv|log|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|sh|py|sql|ini|conf|cfg|env|gitignore)$/i.test(p) || /(^|\/)\.gitignore$/.test(p);

/** The bytes of the zip file an entry's data occupies (its local header plus its packed bytes). */
function rangeOf(zip: Buffer, e: Entry): [number, number] {
  const p = e.offset;
  if (p + 30 > zip.length || zip.readUInt32LE(p) !== LOC) return [p, p];
  const nameLen = zip.readUInt16LE(p + 26);
  const extraLen = zip.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  return [start, start + e.packed];
}

/** True when any two entries' data ranges overlap (or share a start): the same bytes read twice. */
function overlap(ranges: Array<[number, number]>): boolean {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev[1] > cur[0] || prev[0] === cur[0]) return true;
  }
  return false;
}

/**
 * Lists a zip's entries and reads the text files inside it safely. Returns the listing first, then the
 * text files, all as one string: the tool then caps it like any other long text.
 */
export function readZip(zip: Buffer): string {
  if (zip.length > 48 * 1024 * 1024) throw new ZipReadError("A zip can be at most 48 MB.");
  const all = index(zip);
  if (all.length > ZIP_LIMITS.entries) throw new ZipReadError(`This zip has ${all.length} entries; Boss Man reads at most ${ZIP_LIMITS.entries}.`);
  const entries: ZipEntry[] = [];
  let declared = 0;
  for (const e of all) {
    const name = e.name.replace(/\\/g, "/");
    // A folder entry (a trailing slash) names nothing to read; a Mac's clutter is skipped, not refused.
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || name.endsWith(".DS_Store")) continue;
    const clean = cleanPath(name);
    if (!clean || clean !== name) throw new ZipReadError(`This zip has an unsafe entry ("${name}"): it goes outside its own folder (../ or an absolute or odd path), so Boss Man won't open it.`);
    declared += e.size;
    entries.push({ path: clean, size: e.size });
  }
  // Refuse from the index before inflating anything when the declared total is already too big.
  if (declared > ZIP_LIMITS.unpackedBytes) throw new ZipReadError(`This zip unpacks to ${Math.round(declared / 1024 / 1024)} MB; Boss Man reads at most ${ZIP_LIMITS.unpackedBytes / 1024 / 1024} MB.`);
  // The non-recursive bomb: many central entries all pointing at one local entry's data, or overlapping data.
  const names = new Set(entries.map((x) => x.path));
  const used = all.filter((e) => names.has(e.name.replace(/\\/g, "/"))).map((e) => rangeOf(zip, e));
  if (overlap(used)) throw new ZipReadError("This zip has entries that share or overlap their packed data, which a real archive never does; Boss Man won't open it.");

  const byPath = new Map(all.map((e) => [e.name.replace(/\\/g, "/"), e] as const));

  const texts: ZipText[] = [];
  const notes: string[] = [];
  let inflated = 0;
  for (const entry of entries) {
    const e = byPath.get(entry.path)!;
    if (!isTextName(entry.path)) continue;
    if (entry.size > ZIP_LIMITS.entryBytes) {
      notes.push(`${entry.path} is ${entry.size} bytes, too big to show; listed by name and size only.`);
      continue;
    }
    // Stop before inflating once the real unpacked budget is spent: an entry not counted here isn't paid for.
    if (inflated + Math.min(entry.size, ZIP_LIMITS.entryBytes) > ZIP_LIMITS.unpackedBytes) {
      notes.push(`${entry.path} isn't shown here because the unpacked size budget is used up.`);
      continue;
    }
    let text: string;
    try {
      const bytes = readEntry(zip, e);
      // Every inflated byte counts against the real budget, binary-named or not, so it can't be blown past.
      inflated += bytes.length;
      if (inflated > ZIP_LIMITS.unpackedBytes) throw new ZipReadError(`This zip unpacks to more than ${ZIP_LIMITS.unpackedBytes / 1024 / 1024} MB; Boss Man reads at most that.`);
      const got = asText(bytes);
      if (got === null) continue; // a binary file that happened to have a text name is listed only.
      text = got;
    } catch (err) {
      if (err instanceof ZipReadError && err.message === "too big") continue; // the listing already names it with its size.
      throw err;
    }
    // Keep up to the per-entry cap; the tool's cut() pages the whole body through on later offset calls.
    const truncated = text.length > ZIP_LIMITS.textPerEntry;
    texts.push({ path: entry.path, text: truncated ? text.slice(0, ZIP_LIMITS.textPerEntry) : text, truncated });
  }

  const listing = entries.map((e) => `- ${e.path} (${e.size} bytes)`).join("\n");
  const body = texts.map((t) => `--- ${t.path}${t.truncated ? " (cut here; it continues in the next part)" : ""} ---\n${t.text}`).join("\n\n");
  const extras = notes.length ? `\n\n${notes.join("\n")}` : "";
  return `A zip with ${entries.length} files:\n${listing}${extras}\n\n${texts.length ? "What's in the text files:" : "No text files inside it."}\n\n${body}`;
}
