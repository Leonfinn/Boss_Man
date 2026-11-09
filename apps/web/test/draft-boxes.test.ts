// BOS-773 / DR-045: every text box the owner types into keeps a draft by default, so a new form can't
// forget one the way the New task form did. This ratchet fails on a raw <textarea> outside the one
// wrapper (DraftTextarea.tsx), unless its file is listed below with a reason. A file that is listed but
// no longer has a raw textarea is also a failure, so the list can only shrink.
//
// BOS-784 emptied the list: every owner text box now goes through DraftTextarea or useFormDraft, so it
// must stay empty. A new box that really must not keep a draft still passes DraftTextarea a `draftKey` of
// null with a `noDraft` reason (the wrapper enforces that), rather than writing a raw <textarea> here.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");
/** The only file allowed to write a raw <textarea>: the wrapper that keeps the draft. */
const WRAPPER = join(SRC, "components", "DraftTextarea.tsx");

/**
 * Files still holding a raw <textarea>, each with a reason. BOS-784 moved the last one over, so this is
 * empty; a new line needs a real reason and a ticket that will delete it. A box with no draft belongs
 * in DraftTextarea with draftKey={null} and a noDraft reason, not here.
 */
const PENDING: Record<string, string> = {};

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
