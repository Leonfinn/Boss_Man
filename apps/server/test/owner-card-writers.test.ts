// BOS-2336: every writer of an owner to-do card runs the card check (R19, R19b, R19c and the host fences) before the
// owner sees it. The guard at the bottom reads src/ and fails when a writer is added or moved without being listed here;
// the rows above run each writer's own fixed steps through the same check with the options its card really offers.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkOwnerSetup } from "../src/services/owner-setup-check.js";
import { lintLines, outsideSiteKeys, SCREEN_DIFFERENT_OPTION } from "../src/services/steps.js";
import { CI_IDENTITY_STEPS, CI_KEEP_EMAILS } from "../src/services/ci-identity-card.js";
import { TODO_DONE, TODO_FAILED } from "../src/services/decisions.js";

/** The options raiseOwnerTodo builds for a card: a step on an outside site adds "My screen looks different". */
const optionsFor = (steps: string[], extra: string[] = []) => [TODO_DONE, ...extra, ...(steps.some((s) => outsideSiteKeys(s, null).length) ? [SCREEN_DIFFERENT_OPTION] : []), TODO_FAILED];

describe("fixed step lists pass the owner-card check", () => {
  it("the CI-identity card (a GitHub card, opened with a checkpoint and the screen-differs stop)", () => {
    const c = checkOwnerSetup(CI_IDENTITY_STEPS, { options: optionsFor(CI_IDENTITY_STEPS, [CI_KEEP_EMAILS]), todo: true }, "raise");
    expect(lintLines([...c.hard, ...c.soft]) || "no findings").toBe("no findings");
  });

  it("the same card is refused when GitHub's docs misled the owner in the last 30 days and the steps say 'not seen'", () => {
    const now = new Date("2026-11-24T10:00:00Z");
    const c = checkOwnerSetup(CI_IDENTITY_STEPS, { options: optionsFor(CI_IDENTITY_STEPS, [CI_KEEP_EMAILS]), mismatchedSites: { github: "2026-11-10T10:00:00Z" }, now, todo: true }, "raise");
    expect(c.hard.length + c.soft.length).toBeGreaterThan(0);
  });
});

const SRC = join(__dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
const rel = (f: string) => f.slice(SRC.length + 1);
const count = (text: string, re: RegExp) => [...text.matchAll(re)].length;

describe("every owner-card writer is listed", () => {
  const all = files(SRC).map((f) => ({ file: rel(f), text: readFileSync(f, "utf8") }));

  it("raiseOwnerTodo callers (each checked inside raiseOwnerTodo itself)", () => {
    const callers = Object.fromEntries(all.map((f) => [f.file, count(f.text, /\braiseOwnerTodo\(/g)]).filter(([file, n]) => (n as number) > 0 && file !== "services/decisions.ts"));
    // A new caller needs its steps added to the rows above (or a test that raises its card) before it is listed here.
    expect(callers).toEqual({ "services/ci-identity-card.ts": 1, "services/self-deploy.ts": 3 });
    // The hand-apply to-do is raised inside decisions.ts (its handSteps come from self-deploy.ts's builder).
    expect(count(all.find((f) => f.file === "services/decisions.ts")!.text, /\braiseOwnerTodo\(db,/g)).toBe(1);
  });

  it("each listed writer has a named test that shows its steps held when the check refuses them", () => {
    // writer (as listed above) → [test file, test titles that must still exist there]. A new caller adds its row here
    // with its own held-card test; a renamed or deleted test fails this row.
    const tests: Record<string, [string, string[]]> = {
      "services/ci-identity-card.ts": ["owner-todo-check.test.ts", ["the CI-identity card is held while GitHub's docs have misled the owner"]],
      "services/self-deploy.ts (service cards)": ["self-deploy.test.ts", ["holds the database card when the host's own name is not the one its steps run on (R6)", "holds the proxy card when its check names the standby colour (R31c)"]],
      "services/self-deploy.ts (deployer-script card)": ["self-deploy.test.ts", ["holds a new deployer-script card on an R6 refusal", "keeps the open deployer-script card's old steps when the refreshed ones are refused"]],
      "services/self-deploy.ts (by-hand steps left, BOS-2783)": ["self-deploy.test.ts", ["holds the remaining-steps card on an R6 refusal"]],
      "services/decisions.ts (hand-apply to-do)": ["owner-todo-check.test.ts", ["is held on an R6 host fence refusal", "is held on an R31 compose refusal", "a held card is raised again by the sweep"]],
    };
    for (const [writer, [file, titles]] of Object.entries(tests)) {
      const text = readFileSync(join(__dirname, file), "utf8");
      for (const title of titles) expect(text.includes(title), `${writer}: no test titled "${title}" in ${file}`).toBe(true);
    }
    // Every raiseOwnerTodo caller file in src/ has a row.
    const callerFiles = all.filter((f) => f.file !== "services/decisions.ts" && /\braiseOwnerTodo\(/.test(f.text)).map((f) => f.file).sort();
    expect([...new Set(Object.keys(tests).map((k) => k.split(" ")[0]))].sort()).toEqual(expect.arrayContaining(callerFiles));
  });

  it("every card context that carries steps for the owner is written by a listed file", () => {
    const writers = all.filter((f) => /type: "owner_todo"|type: "owner_setup"/.test(f.text)).map((f) => f.file).sort();
    // self-deploy.ts only names the type when it reads an open to-do back; its writes go through raiseOwnerTodo.
    expect(writers).toEqual(["services/decisions.ts", "services/self-deploy.ts"]);
  });

  it("a writer that rewrites an open card's steps checks them too", () => {
    const rewriters = all.filter((f) => /\.set\(\{ context: \{ \.\.\.ctx, steps/.test(f.text)).map((f) => f.file);
    expect(rewriters).toEqual(["services/self-deploy.ts"]);
    const text = all.find((f) => f.file === "services/self-deploy.ts")!.text;
    expect(text).toMatch(/vetOwnerTodoSteps\(/);
  });
});
