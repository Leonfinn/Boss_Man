// BOS-2727: mergeFacts turns a merge's changed files into the runner facts Boss Man stores,
// and hostWarningAlertKey names one host warning's alert. Pure calls only.
import { describe, expect, it } from "vitest";
import { deploysNothing, touchesRunnerCode, touchesRunnerUpdate } from "@boss-man/shared";
import { mergeFacts } from "../src/services/ticket-merges.js";
import { hostWarningAlertKey } from "../src/services/host-warnings.js";

const WEB_ONLY = ["apps/web/src/pages/Board.tsx"];
const RUNNER_CODE = ["apps/runner/src/index.ts"];
const RUNNER_UPDATE = ["scripts/update-runner.sh"];
const DOCS_ONLY = ["docs/guide.md", "README.md"];

const LISTS: Array<{ name: string; files: readonly string[] }> = [
  { name: "only web files", files: WEB_ONLY },
  { name: "a runner code file", files: RUNNER_CODE },
  { name: "the runner-update script", files: RUNNER_UPDATE },
  { name: "only docs files", files: DOCS_ONLY },
  { name: "web and runner code together", files: [...WEB_ONLY, ...RUNNER_CODE] },
  { name: "the empty list", files: [] },
];

describe("mergeFacts", () => {
  it("treats a missing or undefined file list as touching the runners, the rest unknown", () => {
    expect(mergeFacts(null)).toEqual({ touchesRunner: true, touchesRunnerUpdate: null, deploysNothing: null });
    expect(mergeFacts(undefined)).toEqual({ touchesRunner: true, touchesRunnerUpdate: null, deploysNothing: null });
  });

  it("gives the empty list its own answer, not the null one", () => {
    expect(mergeFacts([])).toEqual({ touchesRunner: false, touchesRunnerUpdate: false, deploysNothing: false });
  });

  it("matches the shared go-live rules for every known file list", () => {
    for (const { name, files } of LISTS) {
      expect(mergeFacts(files), name).toEqual({
        touchesRunner: touchesRunnerCode(files),
        touchesRunnerUpdate: touchesRunnerUpdate(files),
        deploysNothing: deploysNothing(files),
      });
    }
  });

  it("pins the facts for the example lists the ticket names", () => {
    expect(mergeFacts(WEB_ONLY)).toEqual({ touchesRunner: false, touchesRunnerUpdate: false, deploysNothing: false });
    expect(mergeFacts(RUNNER_CODE)).toEqual({ touchesRunner: true, touchesRunnerUpdate: false, deploysNothing: false });
    expect(mergeFacts(RUNNER_UPDATE)).toEqual({ touchesRunner: false, touchesRunnerUpdate: true, deploysNothing: false });
    expect(mergeFacts(DOCS_ONLY)).toEqual({ touchesRunner: false, touchesRunnerUpdate: false, deploysNothing: true });
  });
});

describe("hostWarningAlertKey", () => {
  it("prefixes the host-reported key with alert:host-warning:", () => {
    expect(hostWarningAlertKey("check.container_status.app")).toBe("alert:host-warning:check.container_status.app");
  });

  it("gives two different keys two different alert keys", () => {
    const first = hostWarningAlertKey("check.container_status.app");
    const second = hostWarningAlertKey("addon.tailscale");
    expect(first).not.toBe(second);
    expect(hostWarningAlertKey("check.container_status.app")).toBe(first);
  });
});
