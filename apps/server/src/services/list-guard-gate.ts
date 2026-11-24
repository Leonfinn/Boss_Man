// BOS-2522: the list guards at the move to review. Florence's 24 Nov workflow review: engineers' first-time pass fell to
// 67%, mostly from 10 tickets that broke a list guard (scripts/check-guards.sh) and left it to the queued quick check.
// This runs three of the four guards' rules on the branch's changed files when the ticket moves to review, and refuses
// with the exact edits. Pure: the caller reads the diff, the list files and the changed .tsx files (list-guard-move.ts).
//
// Design choices:
// - Refuse only on a sure miss. Each rule asks "does the name appear anywhere in the list file?", a looser question
//   than the guard's own, so it can't refuse what the guard passes (test/list-guard-gate.test.ts runs it over
//   every source file on main and expects silence). What it lets through (a label under the wrong screen, a component
//   shown on a screen its file doesn't say) the quick check still catches.
// - The scanners are the guards' own (guard-scan.ts), so the two read a file the same way.
// - Screen inventory is not checked here: its guard compares a snapshot of the whole app's page graph, which a few
//   changed files can't rebuild. The quick check runs it as before.
// - Anything the caller couldn't read (a truncated diff hunk, a file the runner didn't give) is skipped, never refused.
import type { WorkspaceDiff } from "@boss-man/shared";
import { buttonLabels, fieldLabels, HOLD_READER, NOT_WAKE_CODES, wakeReasonsIn } from "./guard-scan.js";

export const OWNER_CONTROLS_FILE = "packages/shared/src/owner-controls.ts";
export const OWNER_CONTROL_TEST = "apps/server/test/owner-control-list.test.ts";
export const WAKE_CLASSES_FILE = "apps/server/src/services/wake-classes.ts";
export const WAKE_CLASSES_TEST = "apps/server/test/wake-classes.test.ts";
export const UPDATE_WAITS_TEST = "apps/server/test/update-waits-guard.test.ts";
/** More changed .tsx files than this and the owner-controls rule is left to the quick check: one runner read each. */
export const MAX_SCREEN_FILES = 25;

const WEB_SRC = "apps/web/src/";
const SERVER_SRC = "apps/server/src/";
const WEB_TSX = /^apps\/web\/src\/.+\.tsx$/;
const SERVER_TS = /^apps\/server\/src\/.+\.ts$/;

type Diff = Pick<WorkspaceDiff, "files" | "diff" | "truncated">;
export type GuardPlan = {
  /** Changed web .tsx files to read whole at the branch head (owner controls). */
  webFiles: string[];
  /** Wake reasons on added lines of server source, with the file that names each. */
  reasons: Array<{ reason: string; file: string }>;
  /** Server source files (relative to apps/server/src) whose added lines read an update hold. */
  readers: string[];
  /** The list files the rules above need, to read at the branch head. */
  lists: string[];
  /** Rules left to the quick check, with why. */
  skipped: string[];
};

/** Each file's added lines (without the +), by its new path. A file the diff text doesn't reach is absent. */
export function addedLinesByFile(diff: string): Map<string, string[]> {
  const out = new Map<string, string[]>(); // not state: a local of this function, rebuilt on every call
  let current: string[] | null = null;
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (head) {
      current = [];
      out.set(head[2]!, current);
      continue;
    }
    if (current && line.startsWith("+") && !line.startsWith("+++")) current.push(line.slice(1));
  }
  return out;
}

/** What the rules need read, from the branch's diff. */
export function guardReads(d: Diff): GuardPlan {
  const added = addedLinesByFile(d.diff);
  const changed = d.files.filter((f) => f.added > 0).map((f) => f.path);
  const skipped: string[] = [];
  let webFiles = changed.filter((p) => WEB_TSX.test(p));
  if (webFiles.length > MAX_SCREEN_FILES) {
    skipped.push(`owner-controls (${webFiles.length} changed .tsx files, over ${MAX_SCREEN_FILES})`);
    webFiles = [];
  }
  const reasons: GuardPlan["reasons"] = [];
  const readers: string[] = [];
  let unreadServer = 0;
  for (const p of changed.filter((x) => SERVER_TS.test(x))) {
    const lines = added.get(p);
    if (!lines) {
      unreadServer++;
      continue;
    }
    for (const reason of new Set(lines.flatMap(wakeReasonsIn))) if (!NOT_WAKE_CODES.includes(reason)) reasons.push({ reason, file: p });
    if (lines.some((l) => HOLD_READER.test(l))) readers.push(p.slice(SERVER_SRC.length));
  }
  if (unreadServer) skipped.push(`wake-classes and update-waits for ${unreadServer} server file${unreadServer === 1 ? "" : "s"} past the end of the diff`);
  const lists = [...(webFiles.length ? [OWNER_CONTROLS_FILE, OWNER_CONTROL_TEST] : []), ...(reasons.length ? [WAKE_CLASSES_FILE, WAKE_CLASSES_TEST] : []), ...(readers.length ? [UPDATE_WAITS_TEST] : [])];
  return { webFiles, reasons, readers, lists, skipped };
}

/** True when the string sits anywhere in the source text as a list entry: quoted, or with the " …" a "starts with" entry has. */
export function listedIn(text: string, label: string): boolean {
  // The label is as the source shows it; a list entry with a quote in it escapes that quote (JSON.stringify's form).
  const dq = label.replace(/\\?"/g, '\\"');
  return [`"${label}"`, `"${dq}"`, `'${label}'`, `\`${label}\``, `"${dq} …"`, `"${dq} \\u2026"`].some((s) => text.includes(s));
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A key of the WAKE_CLASS table (or anything that looks like one: this only has to be looser than the guard). */
function inWakeTable(text: string, reason: string): boolean {
  return text.includes(`"${reason}"`) || new RegExp(`^\\s*${escapeRe(reason)}\\s*:`, "m").test(text);
}

/**
 * The refusal for a move to review, or null when no rule finds a sure miss. `texts` holds each path in plan.lists and
 * plan.webFiles with its whole text at the branch head, or null when it couldn't be read whole (then its rule is skipped).
 */
export function listGuardRefusal(plan: GuardPlan, texts: Record<string, string | null>): string | null {
  const edits: string[] = [];
  const guards = new Set<string>(); // not state: a local of this function

  const controls = texts[OWNER_CONTROLS_FILE];
  const controlTest = texts[OWNER_CONTROL_TEST];
  if (controls && controlTest) {
    const noScreen: string[] = [];
    for (const path of plan.webFiles) {
      const src = texts[path];
      if (!src) continue;
      const buttons = [...new Set(buttonLabels(src))];
      const fields = [...new Set(fieldLabels(src))];
      if (!buttons.length && !fields.length) continue;
      const file = path.slice(WEB_SRC.length);
      if (!controlTest.includes(`"${file}"`)) noScreen.push(file);
      const screen = new RegExp(`"${escapeRe(file)}":\\s*"([^"]+)"`).exec(controlTest)?.[1];
      const where = screen ? `"${screen}"` : `"<its screen>"`;
      const quote = (xs: string[]) => xs.map((x) => JSON.stringify(x)).join(", ");
      const missingButtons = buttons.filter((l) => !listedIn(controls, l));
      const missingFields = fields.filter((l) => !listedIn(controls, l));
      if (missingButtons.length) edits.push(`owner-controls: ${path} shows ${quote(missingButtons)}: add to OWNER_CONTROLS[${where}] in ${OWNER_CONTROLS_FILE}`);
      if (missingFields.length) edits.push(`owner-controls: ${path} has the field${missingFields.length === 1 ? "" : "s"} ${quote(missingFields)}: add to OWNER_FIELDS[${where}] in ${OWNER_CONTROLS_FILE}`);
      if (missingButtons.length || missingFields.length) guards.add("owner-controls");
    }
    if (noScreen.length) {
      guards.add("owner-controls");
      edits.push(`owner-controls: ${noScreen.join(", ")} show${noScreen.length === 1 ? "s" : ""} buttons or fields but ${noScreen.length === 1 ? "isn't" : "aren't"} in FILE_SCREEN: add ${noScreen.map((f) => `"${f}": "<screen>",`).join(" ")} to FILE_SCREEN in ${OWNER_CONTROL_TEST} (the screen whose list holds its buttons; "Any screen" for a widget used everywhere)`);
    }
  }

  const wakeTable = texts[WAKE_CLASSES_FILE];
  const wakeTest = texts[WAKE_CLASSES_TEST];
  if (wakeTable && wakeTest) {
    const missing = new Map<string, string>(); // not state: a local of this function
    for (const { reason, file } of plan.reasons) if (!inWakeTable(wakeTable, reason) && !wakeTest.includes(`"${reason}"`)) missing.set(reason, file);
    if (missing.size) {
      guards.add("wake-classes");
      const key = (r: string) => (/^[a-z_]+$/.test(r) ? r : JSON.stringify(r));
      edits.push(
        `wake-classes: ${[...missing].map(([r, f]) => `"${r}" (${f})`).join(", ")} ha${missing.size === 1 ? "s" : "ve"} no wake class: add ${[...missing.keys()].map((r) => `${key(r)}: "<class>",`).join(" ")} to WAKE_CLASS in ${WAKE_CLASSES_FILE} (class waiting, scheduled or agent; see the table's header), or, if it is not a wake's reason, add ${[...missing.keys()].map((r) => JSON.stringify(r)).join(", ")} to NOT_WAKE_REASONS in ${WAKE_CLASSES_TEST}`,
      );
    }
  }

  const waitsTest = texts[UPDATE_WAITS_TEST];
  if (waitsTest) {
    const extra = plan.readers.filter((f) => !waitsTest.includes(`"${f}"`));
    if (extra.length) {
      guards.add("update-waits");
      edits.push(
        `update-waits: apps/server/src/${extra.join(", apps/server/src/")} now read${extra.length === 1 ? "s" : ""} an update hold (softHold, holdBlocksStarts, getHold or landingMergeIds). A wait that holds work back needs a kind in WAIT_RULES (apps/server/src/services/update-waits.ts) with its own end, its CEO wake and its words for the screen; then add ${extra.map((f) => `"${f}"`).join(", ")} to READERS in ${UPDATE_WAITS_TEST}`,
      );
    }
  }

  if (!edits.length) return null;
  return [
    `This branch would fail the list guard${guards.size === 1 ? "" : "s"} ${[...guards].join(", ")} that the quick check runs first (BOS-2522), so it isn't moved to review yet. Make these edits, commit, and move it again:`,
    ...edits.map((e) => `- ${e}`),
    `To confirm, run ${[...guards].map((g) => `scripts/check-guards.sh ${g}`).join(" and ")} (or the test file named above, by path, from apps/server).`,
    'If an edit here is wrong (the name is listed in a way this check doesn\'t read), move to review again with listGuardWrong: "<why>"; the quick check still runs the real guards.',
  ].join("\n");
}
