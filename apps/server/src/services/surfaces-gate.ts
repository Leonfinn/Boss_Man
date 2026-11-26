// BOS-2733 (BOS-2668 audit, row 2): a branch that changes owner-facing code reaches review only with a "Surfaces:" line
// naming each screen, card or command form the author checked. The most often broken rule in the audit was "list every
// place the change must apply"; the list guards (BOS-2522) cover button labels only. Pure: the caller reads the diff.
// The reviewer judges whether the list is complete; nothing here refuses a list for looking short.
import type { WorkspaceDiff } from "@boss-man/shared";

export const SURFACES_MIN = 10;
export const SURFACES_MAX = 300;

/** Owner-facing code, v1: any non-test file under apps/web/src (a .ts or .tsx, css, not a *.test.* file). */
const WEB_SRC = /^apps\/web\/src\/.+$/;
const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** The server files that build owner card text. Add a path here when a new file starts writing owner-facing cards or steps. */
export const OWNER_CARD_FILES: readonly string[] = [
  "apps/server/src/services/owner-todo.ts",
  "apps/server/src/services/owner-form-steps.ts",
  "apps/server/src/services/owner-screens.ts",
  "apps/server/src/services/compose-steps.ts",
  "apps/server/src/services/card-check.ts",
  "apps/server/src/services/ci-identity-card.ts",
  "apps/server/src/services/decisions.ts",
];

type Diff = Pick<WorkspaceDiff, "files">;

/** The branch's changed owner-facing files (renames count by their new path). */
export function ownerFacingFiles(d: Diff): string[] {
  return d.files.map((f) => f.path).filter((p) => !TEST_FILE.test(p) && (WEB_SRC.test(p) || OWNER_CARD_FILES.includes(p)));
}

/** A problem with the author's own line, or null. */
export function surfacesProblem(line: string): string | null {
  const t = line.trim();
  if (t.length < SURFACES_MIN) return `surfaces needs at least ${SURFACES_MIN} characters: name each screen, card or command form you checked.`;
  if (/[\r\n]/.test(t)) return "surfaces must be one line.";
  return null;
}

export function surfacesRefusal(files: string[]): string {
  const named = files.slice(0, 5).join(", ") + (files.length > 5 ? ` and ${files.length - 5} more` : "");
  return `This branch changes owner-facing code (${named}), so the move to review needs a surfaces line (BOS-2733): one line (up to ${SURFACES_MAX} characters) naming every screen, card or command form where you checked the change applies, e.g. "Board card, Ticket page header, Roadmap milestone line; server and runner update cards". Move to review again with surfaces: "<list>". The reviewer judges whether the list is complete.`;
}

/** For the review wake and the review tool's description. */
export const SURFACES_REVIEW_GUIDANCE =
  'Surfaces (BOS-2733): if the state note has a "Surfaces:" line, judge whether it is complete: is there another screen, card or command form that shows the same thing and was left out? Name any you find in your verdict; request changes if one is missed.';
