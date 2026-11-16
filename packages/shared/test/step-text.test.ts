import { describe, expect, it } from "vitest";
import { fenceWhere, parseStep, strayFence } from "../src/step-text.js";

// The shape of the 6 Nov deployer-copy card (BOS-550): a sentence, then a labelled fence on its own line. The old
// web renderer (```[a-z]*\n) read none of these as a command; this parser, shared by the lint and the card, reads all.
const CARD = [
  'Open a terminal and become root:\n```sh host="app01" as="login"\nsudo -i\n```',
  'Go to the install folder:\n```sh host="app01" as="root"\ncd /srv/app\n```',
  "Read the deployer folder's location from your settings file:\n```sh host=\"app01\" as=\"root\"\nD=$(sed -n 's/^DEPLOYER=//p' .env)\n```",
  'Check it worked. This must print 2:\n```sh host="app01" as="root"\ngrep -c recover "$D/deployer.sh"\n```',
];

describe("one reading of a step's fences (BOS-550)", () => {
  it("reads every step of a labelled-fence card as a sentence and a command with its host and account", () => {
    for (const s of CARD) {
      const p = parseStep(s);
      expect(p).toHaveLength(2);
      expect(p[0]!.type).toBe("text");
      expect(p[1]).toMatchObject({ type: "command", where: { host: "app01" } });
      expect(strayFence(p)).toBeNull();
    }
    expect(parseStep(CARD[2]!)[1]).toEqual({ type: "command", text: "D=$(sed -n 's/^DEPLOYER=//p' .env)", where: { host: "app01", as: "root" } });
  });

  it("reads a labelled fence indented under a numbered list item, and pastes the command without the indent", () => {
    const text = '1. Check the folder:\n   ```sh host="app01" as="root"\n   ls -l /srv/app\n   ```\n2. Then go on.';
    expect(parseStep(text)).toEqual([
      { type: "text", text: "1. Check the folder:" },
      { type: "command", text: "ls -l /srv/app", where: { host: "app01", as: "root" } },
      { type: "text", text: "2. Then go on." },
    ]);
  });

  it("reads Windows line endings as plain ones", () => {
    expect(parseStep('Run:\r\n```sh host="app01" as="root"\r\nid\r\n```')).toEqual([
      { type: "text", text: "Run:" },
      { type: "command", text: "id", where: { host: "app01", as: "root" } },
    ]);
  });

  it("treats any info string as a fence, naming a host only for the sh host=… as=… form", () => {
    expect(parseStep("```bash\nls\n```")).toEqual([{ type: "command", text: "ls" }]);
    expect(parseStep('```sh host="app01" as="root" extra\nls\n```')).toEqual([{ type: "command", text: "ls" }]);
    expect(fenceWhere('sh host="app 01" as="root"')).toBeUndefined();
    expect(fenceWhere('sh host="app01" as="admin"')).toBeUndefined();
    expect(fenceWhere('  sh host="app01"  as="login" ')).toEqual({ host: "app01", as: "login" });
  });

  it("leaves a fence that isn't on its own line, or never closes, in the text, and reports it", () => {
    const inline = parseStep("Run this: ```sh\nls\n```");
    expect(inline.some((p) => p.type === "command")).toBe(false);
    expect(strayFence(inline)).toBe("Run this: ```sh");
    const open = parseStep('Run:\n```sh host="app01" as="root"\nls');
    expect(open.some((p) => p.type === "command")).toBe(false);
    expect(strayFence(open)).toBe('```sh host="app01" as="root"');
    const trailing = parseStep("Run:\n```sh\nls\n``` and press Enter");
    expect(strayFence(trailing)).not.toBeNull();
  });

  it("keeps inline code and plain text as they are", () => {
    expect(parseStep("Open Settings and press `Save`.")).toEqual([{ type: "text", text: "Open Settings and press `Save`." }]);
    expect(strayFence(parseStep("Open Settings and press `Save`."))).toBeNull();
    expect(parseStep("")).toEqual([]);
  });
});

import { CHECKER_TAG_PATTERNS, leftoverCheckerTag, splitOwnerSteps, splitStepSource } from "../src/step-text.js";

describe("R19 source tags are hidden from the owner's text (BOS-1665)", () => {
  const id = "66010c79-1111-4222-8333-444455556666";
  it("takes a seen tag out of the text and reads it into source", () => {
    const r = splitStepSource(`Click Save (seen: ${id})`);
    expect(r.text).toBe("Click Save");
    expect(r.source).toEqual({ kind: "seen", imageId: id });
  });
  it("takes a not-seen tag out and keeps the url and date", () => {
    const r = splitStepSource("Open DNS. not seen: https://docs.example.com/dns, 2026-11-01");
    expect(r.text).toBe("Open DNS.");
    expect(r.source).toEqual({ kind: "notSeen", url: "https://docs.example.com/dns", date: "2026-11-01" });
  });
  it("leaves a step with no tag as it is", () => {
    expect(splitStepSource("Click Save")).toEqual({ text: "Click Save" });
  });
  it("splitOwnerSteps leaves no checker tag in any step and keeps each source; leftoverCheckerTag sees every pattern", () => {
    const eng = "engagement:11111111-2222-4333-8444-555555555555";
    const r = splitOwnerSteps([`Click Save (seen: ${id})`, "Open DNS. not seen: https://docs.example.com/dns, 2026-11-01", "Plain"], { [id]: "2026-11-02T10:00:00Z" });
    for (const s of r.steps) expect(leftoverCheckerTag(s)).toBeUndefined();
    expect(r.stepSources).toEqual([{ kind: "seen", imageId: id, takenAt: "2026-11-02" }, { kind: "notSeen", url: "https://docs.example.com/dns", date: "2026-11-01" }, null]);
    expect(splitOwnerSteps(["Plain"]).stepSources).toBeUndefined();
    // Every listed pattern matches its own tag, so a tag left in owner text is caught.
    expect(CHECKER_TAG_PATTERNS.length).toBe(3);
    for (const t of [`seen: ${id}`, "not seen: https://docs.example.com/x, 2026-11-01", eng]) expect(leftoverCheckerTag(`Do it (${t})`), t).toBeDefined();
  });
});
