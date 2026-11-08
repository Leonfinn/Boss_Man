// BOS-773 / DR-045: every text box the owner types into keeps a draft by default, so a new form can't
// forget one the way the New task form did. This ratchet fails on a raw <textarea> outside the one
// wrapper (DraftTextarea.tsx), unless its file is listed below with a reason. A file that is listed but
// no longer has a raw textarea is also a failure, so the list can only shrink: move the box over and
// delete its line here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
/** The only file allowed to write a raw <textarea>: the wrapper that keeps the draft. */
const WRAPPER = join(SRC, "components", "DraftTextarea.tsx");

/**
 * Boxes not yet moved over: one reason per file. This ticket (BOS-773) moves the New task / New
 * feature form and the reload prompt; the rest is the follow-up "Drafts everywhere" ticket, which
 * must delete each line as it moves the box.
 */
const PENDING: Record<string, string> = {
  "components/OwnerMessageBox.tsx": "Shared description box; moving it will cover the forms that render it.",
  "pages/Agents.tsx": "Agent hiring notes and instruction boxes; not a ticket/feature/wiki form.",
  "pages/Board.tsx": "Acceptance-criteria box inside the New task form, which keeps a whole-form draft.",
  "pages/Decisions.tsx": "Card answer in your own words; BOS-773 checks it and moves it if it has no draft.",
  "pages/Features.tsx": "Feature title/description editing; BOS-773 checks it and moves it if it has no draft.",
  "pages/Feedback.tsx": "Feedback note box; not in BOS-773's list.",
  "pages/Portal.tsx": "Public portal message box; not in BOS-773's list.",
  "pages/Rules.tsx": "Standing-rules editor; not in BOS-773's list.",
  "pages/Settings.tsx": "Settings text boxes; not in BOS-773's list.",
  "pages/Setup.tsx": "First-run setup boxes; not in BOS-773's list.",
  "pages/Skills.tsx": "Skill proposal boxes; not in BOS-773's list.",
  "pages/Ticket.tsx": "Ticket title/description editing; BOS-773 checks it and moves it if it has no draft.",
  "pages/Wiki.tsx": "Wiki page editing; BOS-773 checks it and moves it if it has no draft.",
};

/** Every .ts/.tsx under src, as paths relative to src. */
function sources(dir = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

const rawTextareas = (file: string) => (readFileSync(file, "utf8").match(/<textarea\b/g) ?? []).length;

describe("every owner text box keeps a draft (BOS-773 / DR-045)", () => {
  it("has no raw <textarea> outside DraftTextarea.tsx unless its file is on the PENDING list", () => {
    const stray = sources()
      .filter((f) => f !== WRAPPER)
      .filter((f) => rawTextareas(f) > 0)
      .map((f) => f.slice(SRC.length + 1))
      .filter((rel) => !(rel in PENDING));
    expect(stray, "Use <DraftTextarea draftKey=…> (or useFormDraft for a whole form), or add a reason to PENDING.").toEqual([]);
  });

  it("only lists files that still have a raw <textarea>, so the list can only shrink", () => {
    const stale = Object.keys(PENDING).filter((rel) => rawTextareas(join(SRC, rel)) === 0);
    expect(stale, "These files no longer have a raw <textarea>: delete their PENDING line.").toEqual([]);
  });

  it("gives every PENDING file a real reason", () => {
    for (const [rel, why] of Object.entries(PENDING)) {
      expect(why.trim().length, `${rel} needs a reason`).toBeGreaterThan(10);
    }
  });
});
