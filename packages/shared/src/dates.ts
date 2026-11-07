// One cached date formatter for the whole company (BOS-652). Building an Intl.DateTimeFormat costs
// ~70-90 µs and ~24 KiB of native memory the GC doesn't see; formatting with one ~1 µs. Any per-row
// `new Intl.DateTimeFormat` is a server freeze waiting to happen (BOS-643, BOS-649), so formatters
// come from here instead and are rebuilt only when the cache is emptied.
//
// The cache is keyed by locale, time zone and options, stays bounded, and is emptied wholesale when
// it would grow past FORMAT_CACHE_MAX. A real server sees a handful of zone spellings; a caller that
// makes up zones can't grow it without bound.

export type DateFormatOptions = Intl.DateTimeFormatOptions;

const FORMAT_CACHE_MAX = 256;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatKey(locale: string, opts: DateFormatOptions | undefined, withZone: boolean): string {
  const { timeZone, ...rest } = opts ?? {};
  const parts = Object.keys(rest)
    .sort()
    .map((k) => `${k}:${String((rest as Record<string, unknown>)[k])}`);
  // Whether a zone is given decides whether the runtime default zone applies, so keep them apart.
  return `${locale}\u0000${withZone ? String(timeZone) : "\u0000default"}\u0000${parts.join(",")}`;
}

/**
 * A formatter for `locale` and `opts`, reused across calls. `opts.timeZone` is the zone; an omitted
 * zone uses the runtime default. The map is keyed by every input that changes the output, so one
 * warm formatter serves every later call with the same ones.
 */
export function dateFormat(locale: string, opts?: DateFormatOptions): Intl.DateTimeFormat {
  const withZone = !!opts?.timeZone;
  const key = formatKey(locale, opts, withZone);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(locale, opts);
    if (formatters.size + 1 > FORMAT_CACHE_MAX) formatters.clear();
    formatters.set(key, f);
  }
  return f;
}

/** Answers already worked out for isTimeZone, so validating a zone costs nothing after the first time. */
const zoneChecks = new Map<string, boolean>();

/** Whether Intl accepts `tz` as a time zone name. The answer is cached per spelling and the map bounded. */
export function isTimeZone(tz: string): boolean {
  const known = zoneChecks.get(tz);
  if (known !== undefined) return known;
  let ok: boolean;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    ok = true;
  } catch {
    ok = false;
  }
  if (zoneChecks.size + 1 > FORMAT_CACHE_MAX) zoneChecks.clear();
  zoneChecks.set(tz, ok);
  return ok;
}

/** How many formatter keys the cache holds; for tests of the cap. */
export function formatCacheSize(): number {
  return formatters.size;
}

/** Format `date` through the cached formatter: "4 Nov", "Sat 4 Nov", "07:35" and the like. */
export function formatDate(locale: string, date: Date, opts: DateFormatOptions): string {
  return dateFormat(locale, opts).format(date);
}
