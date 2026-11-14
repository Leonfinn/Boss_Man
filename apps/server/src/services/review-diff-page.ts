// One page of a ticket's diff for the review tool. A diff longer than a page is never cut silently:
// the page ends on a whole line, and a closing note says how many files and lines are left, names them,
// and gives the offset (or file path) that fetches the rest.

export const DIFF_PAGE_CHARS = 60_000;

type Section = { path: string; start: number };

/** Where each file's part of a unified diff starts (a "diff --git a/x b/y" line). */
function sections(diff: string): Section[] {
  const out: Section[] = [];
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  for (let m = re.exec(diff); m; m = re.exec(diff)) out.push({ path: m[2]!, start: m.index });
  return out;
}

const lineCount = (s: string) => (s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);

export interface DiffPageInput {
  diff: string;
  /** Read only this file's part of the diff. */
  path?: string;
  /** Character offset into the diff (or into the one file's part) to start from; the cut note gives the next one. */
  offset?: number;
  limit?: number;
}

export function pageDiff({ diff, path, offset = 0, limit = DIFF_PAGE_CHARS }: DiffPageInput): { text: string; error?: string } {
  const all = sections(diff);
  let body = diff;
  let scope = "the diff";
  let paths = all;
  if (path) {
    const i = all.findIndex((s) => s.path === path);
    if (i < 0) return { text: "", error: `No file ${path} in this diff. Files in it:\n${all.map((s) => s.path).join("\n") || "(none)"}` };
    body = diff.slice(all[i]!.start, all[i + 1]?.start ?? diff.length);
    scope = path;
    paths = [];
  }
  if (offset < 0 || offset > body.length) return { text: "", error: `offset ${offset} is outside ${scope} (${body.length} characters).` };
  let end = Math.min(body.length, offset + limit);
  if (end < body.length) {
    const nl = body.lastIndexOf("\n", end - 1);
    if (nl > offset) end = nl + 1; // end on a whole line
  }
  const page = body.slice(offset, end);
  if (end >= body.length) {
    return { text: offset === 0 ? page : `${page}\n[End of ${scope}: you have now read all of it.]` };
  }
  const rest = body.slice(end);
  const arg = path ? `path "${path}" offset ${end}` : `offset ${end}`;
  // Files not yet started, and the file the cut falls inside (its remainder is still unread).
  const notStarted = paths.filter((s) => s.start >= end).map((s) => s.path);
  const inside = paths.filter((s) => s.start < end).pop();
  const left = [...(inside ? [`${inside.path} (rest of this file)`] : []), ...notStarted];
  const filesNote = path ? "" : `, ${left.length} file(s) left: ${left.join(", ")}`;
  return {
    text: `${page}\n[DIFF CUT HERE: characters ${offset}-${end} of ${body.length} of ${scope} shown; ${lineCount(rest)} line(s) not shown${filesNote}. You have NOT read it all. Call review action diff again with ${arg} for the next part, or with path set to one file to read just that file.]`,
  };
}
