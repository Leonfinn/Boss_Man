// BOS-2522: the list-guard rule at the move to review (list-guard-gate.ts). Unit cases on made-up files, then the whole
// repo as it is: every web .tsx and server .ts treated as changed must draw no refusal, so the rule can't refuse what the
// guards themselves pass. That part reads repo files by path, so the merge gate runs it (whole-repo test).
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { WorkspaceDiff } from "@boss-man/shared";
import { guardReads, listGuardRefusal, MAX_SCREEN_FILES, OWNER_CONTROL_TEST, OWNER_CONTROLS_FILE, UPDATE_WAITS_TEST, WAKE_CLASSES_FILE, WAKE_CLASSES_TEST, type GuardPlan } from "../src/services/list-guard-gate.js";

const diffOf = (files: Record<string, string[]>, opts: { removed?: Record<string, string[]>; truncated?: boolean } = {}): Pick<WorkspaceDiff, "files" | "diff" | "truncated"> => ({
  files: Object.entries(files).map(([p, lines]) => ({ path: p, added: lines.length, removed: opts.removed?.[p]?.length ?? 0 })),
  diff: Object.entries(files)
    .map(([p, lines]) => [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`, ...(opts.removed?.[p] ?? []).map((l) => `-${l}`), ...lines.map((l) => `+${l}`)].join("\n"))
    .join("\n"),
  truncated: opts.truncated ?? false,
});

// Made-up list files, shaped like the real ones.
const CONTROLS = `export const OWNER_CONTROLS = {\n  "Any screen": ["Save", "Menu …"],\n  Board: ["Open filters", 'Archive'],\n};\nexport const OWNER_FIELDS = {\n  Board: ["Project name"],\n};\n`;
const CONTROL_TEST = `const FILE_SCREEN: Record<string, OwnerScreen> = {\n  "pages/Board.tsx": "Board",\n  "components/Lightbox.tsx": "Any screen",\n};\n`;
const WAKE_TABLE = `const WAKE_TABLE = {\n  decision: "waiting",\n  "review requested": "waiting",\n};\n`;
const WAKE_TEST = `const NOT_WAKE_REASONS = new Set([\n  "meaning none",\n]);\n`;
const WAITS_TEST = `const READERS = [\n  "app.ts",\n  "services/scheduler.ts",\n];\n`;
const LISTS = { [OWNER_CONTROLS_FILE]: CONTROLS, [OWNER_CONTROL_TEST]: CONTROL_TEST, [WAKE_CLASSES_FILE]: WAKE_TABLE, [WAKE_CLASSES_TEST]: WAKE_TEST, [UPDATE_WAITS_TEST]: WAITS_TEST };
const BOARD = "apps/web/src/pages/Board.tsx";

function refuse(files: Record<string, string[]>, whole: Record<string, string> = {}, opts: Parameters<typeof diffOf>[1] = {}) {
  const plan = guardReads(diffOf(files, opts));
  return { plan, refusal: listGuardRefusal(plan, { ...LISTS, ...whole }) };
}

describe("owner-controls at the move", () => {
  it("names a new button missing from the list, with the screen FILE_SCREEN gives and the file to edit", () => {
    const src = `export function Board() { return <div><button onClick={go}>Open filters</button><button>Frobnicate all</button></div>; }`;
    const { refusal } = refuse({ [BOARD]: ["<button>Frobnicate all</button>"] }, { [BOARD]: src });
    expect(refusal).toContain('"Frobnicate all"');
    expect(refusal).toContain(`OWNER_CONTROLS["Board"] in ${OWNER_CONTROLS_FILE}`);
    expect(refusal).not.toContain('"Open filters"');
    expect(refusal).toContain("scripts/check-guards.sh owner-controls");
    expect(refusal).toContain("listGuardWrong");
  });

  it("names a new field label under OWNER_FIELDS", () => {
    const src = `export const F = () => <label>Budget cap<input /></label>;`;
    expect(refuse({ [BOARD]: ["x"] }, { [BOARD]: src }).refusal).toContain(`has the field "Budget cap": add to OWNER_FIELDS["Board"]`);
  });

  it("names a new file with buttons that has no FILE_SCREEN entry, with the line to add", () => {
    const file = "apps/web/src/components/NewPanel.tsx";
    const { refusal } = refuse({ [file]: ["x"] }, { [file]: `export const P = () => <button>Save</button>;` });
    expect(refusal).toContain(`"components/NewPanel.tsx": "<screen>",`);
    expect(refusal).toContain(`FILE_SCREEN in ${OWNER_CONTROL_TEST}`);
  });

  it("passes listed labels (quoted either way, or a … entry) and a file with no buttons", () => {
    const src = `export const B = () => <><button>Open filters</button><button>Archive</button><button>Menu {name}</button><button>Save</button></>;`;
    expect(refuse({ [BOARD]: ["x"] }, { [BOARD]: src }).refusal).toBeNull();
    const plain = "apps/web/src/components/Plain.tsx";
    expect(refuse({ [plain]: ["x"] }, { [plain]: "export const P = () => <p>Hello</p>;" }).refusal).toBeNull();
  });

  it("skips a file it couldn't read whole, a list it couldn't read, and more changed files than it reads", () => {
    expect(refuse({ [BOARD]: ["<button>Frobnicate</button>"] }, {}).refusal).toBeNull(); // the .tsx unread
    const plan = guardReads(diffOf({ [BOARD]: ["x"] }));
    expect(listGuardRefusal(plan, { [BOARD]: "<button>Frobnicate</button>", [OWNER_CONTROL_TEST]: CONTROL_TEST })).toBeNull();
    const many = Object.fromEntries(Array.from({ length: MAX_SCREEN_FILES + 1 }, (_, i) => [`apps/web/src/components/C${i}.tsx`, ["x"]]));
    const big = guardReads(diffOf(many));
    expect(big.webFiles).toEqual([]);
    expect(big.skipped.join()).toContain("owner-controls");
  });
});

describe("wake-classes at the move", () => {
  const SCHED = "apps/server/src/services/scheduler.ts";
  it("names a new wake reason on an added line, with the WAKE_CLASS line and the not-a-wake way out", () => {
    const { refusal } = refuse({ [SCHED]: ['  await scheduler.wake({ agentId, reason: "plan due" });', 'export const LATE_REASON = "late_check";'] });
    expect(refusal).toContain(`"plan due": "<class>", late_check: "<class>",`);
    expect(refusal).toContain(`WAKE_CLASS in ${WAKE_CLASSES_FILE}`);
    expect(refusal).toContain(`NOT_WAKE_REASONS in ${WAKE_CLASSES_TEST}`);
    expect(refusal).toContain(SCHED);
  });

  it("passes a classified reason (bare or quoted key), a listed non-wake, a refusal code, a removed line and a sentence", () => {
    const lines = ['wake({ reason: "decision" })', 'wake({ reason: "review requested" })', 'x({ reason: "meaning none" })', 'res({ reason: "no_wrapup" })', 'refuse({ reason: "That ticket is closed." })'];
    expect(refuse({ [SCHED]: lines }, {}, { removed: { [SCHED]: ['wake({ reason: "gone away" })'] } }).refusal).toBeNull();
  });

  it("skips a server file past the end of a truncated diff, and a list it couldn't read", () => {
    const d = diffOf({ [SCHED]: ['wake({ reason: "plan due" })'] });
    const plan = guardReads({ ...d, diff: "", truncated: true });
    expect(plan.reasons).toEqual([]);
    expect(plan.skipped.join()).toContain("past the end of the diff");
    const p2 = guardReads(d);
    expect(listGuardRefusal(p2, { [WAKE_CLASSES_FILE]: WAKE_TABLE, [WAKE_CLASSES_TEST]: null })).toBeNull();
  });
});

describe("update-waits at the move", () => {
  it("names a new file that reads an update hold, with the rule and READERS line", () => {
    const f = "apps/server/src/services/new-wait.ts";
    const { refusal } = refuse({ [f]: ["  if (await getHold(db)) return;"] });
    expect(refusal).toContain(`"services/new-wait.ts" to READERS in ${UPDATE_WAITS_TEST}`);
    expect(refusal).toContain("WAIT_RULES");
  });
  it("passes a listed reader", () => {
    expect(refuse({ "apps/server/src/services/scheduler.ts": ["  if (softHold()) return;"] }).refusal).toBeNull();
  });
});

describe("the whole repo as it is (whole-repo test)", () => {
  const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
  const walk = (dir: string, ext: string): string[] =>
    readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`, ext) : e.name.endsWith(ext) ? [`${dir}/${e.name}`] : []));
  const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

  it("refuses nothing with every web .tsx and server .ts treated as changed in full", () => {
    const web = walk("apps/web/src", ".tsx");
    const server = walk("apps/server/src", ".ts");
    const all = guardReads(diffOf(Object.fromEntries(server.map((p) => [p, read(p).split("\n")]))));
    // The cap is for one branch's runner reads; here every file is read from disk.
    const plan: GuardPlan = { ...all, webFiles: web };
    // The scan found what the guards guard, so an empty pass can't hide a miss.
    expect(plan.webFiles.length).toBeGreaterThan(100);
    expect(new Set(plan.reasons.map((r) => r.reason)).size).toBeGreaterThan(30);
    expect(plan.readers.length).toBeGreaterThan(10);
    const texts = Object.fromEntries([...plan.lists, OWNER_CONTROLS_FILE, OWNER_CONTROL_TEST, ...web].map((p) => [p, read(p)]));
    expect(listGuardRefusal(plan, texts)).toBeNull();
  });
});
