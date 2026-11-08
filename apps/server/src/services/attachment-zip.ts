// Reading a .zip the owner attached (BOS-228): a company export is a zip, and an agent that can't open it
// has to send the owner back to unzip files by hand. The archive is untrusted: paths are checked, the
// entry count and the uncompressed size are capped before anything is inflated, and only text entries are
// inflated at all. Nothing is written anywhere and nothing is executed.
import { Inflate } from "fflate";
import { cleanPath } from "./skills.js";

export const ZIP_LIMITS = {
  /** Entries named in the zip's index; a real company export has a few hundred at most. */
  entries: 5_000,
  /** Bytes every entry claims to unpack to, added up (the usual zip-bomb guard, before inflating). */
  unpackedBytes: 64 * 1024 * 1024,
  /** A single entry bigger than this is listed by name and size, never inflated. */
  entryBytes: 4 * 1024 * 1024,
  /** How much of a text entry is kept; the rest is reported as cut. */
  textPerEntry: 200_000,
  /** All the text returned in one call, so a big export still reaches the agent in parts. */
  textTotal: 60_000,
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

/** The zip's central directory: every entry's name, its stated unpacked size and where its data starts. */
function index(zip: Buffer) {
  const min = Math.max(0, zip.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = zip.length - 22; i >= min; i--) if (zip.readUInt32LE(i) === EOCD) { eocd = i; break; }
  if (eocd < 0) throw new ZipReadError("That file isn't a zip Boss Man can read.");
  const count = zip.readUInt16LE(eocd + 10);
  const start = zip.readUInt32LE(eocd + 16);
  const entries: Array<{ name: string; size: number; offset: number; method: number }> = [];
  let p = start;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || zip.readUInt32LE(p) !== CEN) throw new ZipReadError("That file isn't a zip Boss Man can read.");
    const method = zip.readUInt16LE(p + 10);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const offset = zip.readUInt32LE(p + 42);
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    entries.push({ name, size, offset, method });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** One entry's bytes, inflated here and now, stopping the moment it passes the cap (a header can lie). */
function readEntry(zip: Buffer, e: { size: number; offset: number; method: number }): Buffer {
  if (e.method !== 0 && e.method !== 8) throw new ZipReadError(`This entry uses a compression method Boss Man can't read (method ${e.method}).`);
  if (e.size > ZIP_LIMITS.entryBytes) throw new ZipReadError("too big");
  const p = e.offset;
  if (p + 30 > zip.length || zip.readUInt32LE(p) !== LOC) throw new ZipReadError("That file isn't a zip Boss Man can read.");
  const nameLen = zip.readUInt16LE(p + 26);
  const extraLen = zip.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const data = zip.subarray(start);
  if (e.method === 0) {
    if (e.size > ZIP_LIMITS.entryBytes) throw new ZipReadError("too big");
    return data.subarray(0, e.size);
  }
  // Inflated in pieces against a hard ceiling: an entry whose header understates it is cut off, not grown.
  const parts: Buffer[] = [];
  let total = 0;
  try {
    new Inflate((chunk) => {
      total += chunk.length;
      if (total > ZIP_LIMITS.entryBytes) throw new ZipReadError("too big");
      parts.push(Buffer.from(chunk));
    }).push(data, true);
  } catch (err) {
    if (err instanceof ZipReadError) throw err;
    throw new ZipReadError("That entry isn't readable as a zip file's contents.");
  }
  return Buffer.concat(parts);
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

/**
 * Lists a zip's entries and reads the text files inside it safely. Returns the listing first, then the
 * text files, all as one string: the tool then caps it like any other long text.
 */
export function readZip(zip: Buffer): string {
  if (zip.length > 48 * 1024 * 1024) throw new ZipReadError("A zip can be at most 48 MB.");
  const all = index(zip);
  if (all.length > ZIP_LIMITS.entries) throw new ZipReadError(`This zip has ${all.length} entries; Boss Man reads at most ${ZIP_LIMITS.entries}.`);
  const entries: ZipEntry[] = [];
  let unpacked = 0;
  for (const e of all) {
    const name = e.name.replace(/\\/g, "/");
    // A folder entry (a trailing slash) names nothing to read; a Mac's clutter is skipped, not refused.
    if (name.endsWith("/") || name.startsWith("__MACOSX/") || name.endsWith(".DS_Store")) continue;
    const clean = cleanPath(name);
    if (!clean || clean !== name) throw new ZipReadError(`This zip has an unsafe entry ("${name}"): it goes outside its own folder (../ or an absolute or odd path), so Boss Man won't open it.`);
    unpacked += e.size;
    entries.push({ path: clean, size: e.size });
  }
  if (unpacked > ZIP_LIMITS.unpackedBytes) throw new ZipReadError(`This zip unpacks to ${Math.round(unpacked / 1024 / 1024)} MB; Boss Man reads at most ${ZIP_LIMITS.unpackedBytes / 1024 / 1024} MB.`);

  const byPath = new Map(all.map((e) => [e.name.replace(/\\/g, "/"), e] as const));
  const texts: ZipText[] = [];
  const notes: string[] = [];
  let total = 0;
  for (const entry of entries) {
    const e = byPath.get(entry.path)!;
    if (!isTextName(entry.path)) continue;
    if (entry.size > ZIP_LIMITS.entryBytes) {
      notes.push(`${entry.path} is ${entry.size} bytes, too big to show; listed by name and size only.`);
      continue;
    }
    let text: string;
    try {
      const got = asText(readEntry(zip, e));
      if (got === null) continue; // a binary file that happened to have a text name is listed only.
      text = got;
    } catch (err) {
      if (err instanceof ZipReadError && err.message === "too big") continue; // the listing already names it with its size.
      throw err;
    }
    const room = Math.min(ZIP_LIMITS.textPerEntry, ZIP_LIMITS.textTotal - total);
    if (room <= 0) {
      notes.push(`${entry.path} isn't shown here because this call is full; open it in a later part.`);
      continue;
    }
    const truncated = text.length > room;
    texts.push({ path: entry.path, text: truncated ? text.slice(0, room) : text, truncated });
    total += Math.min(text.length, room);
  }

  const listing = entries.map((e) => `- ${e.path} (${e.size} bytes)`).join("\n");
  const body = texts.map((t) => `--- ${t.path}${t.truncated ? " (cut here; it continues in the next part)" : ""} ---\n${t.text}`).join("\n\n");
  const extras = notes.length ? `\n\n${notes.join("\n")}` : "";
  return `A zip with ${entries.length} files:\n${listing}${extras}\n\n${texts.length ? "What's in the text files:" : "No text files inside it."}\n\n${body}`;
}
