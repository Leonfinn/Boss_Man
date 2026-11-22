import { describe, expect, it } from "vitest";
import {
  fillHostTokensIn,
  fillServerHost,
  gitUmaskFindings,
  lintLines,
  placeFindings,
  runnerUpdateFindings,
  sh,
  step,
  unfilledTokens,
  updateCardFindings,
  type LintFacts,
  type LintFinding,
  type RunnerHold,
  type SelfDeployFacts,
} from "../src/services/steps.js";

const fence = (line: string, command = "id") => `Run this:\n\n\`\`\`${line}\n${command}\n\`\`\``;

describe("fillServerHost (BOS-774, DR-046)", () => {
  it("puts the reported server name on a fence that named only the account", () => {
    expect(fillServerHost([fence('sh as="root"')], "nas01")).toEqual([fence('sh host="nas01" as="root"')]);
    expect(fillServerHost([fence('sh as="login"')], "nas01")).toEqual([fence('sh host="nas01" as="login"')]);
  });

  it("fills the {{host}} token with the reported name", () => {
    expect(fillServerHost([fence('sh host="{{host}}" as="root"')], "nas01")).toEqual([fence('sh host="nas01" as="root"')]);
    expect(fillServerHost([fence('sh host="{{ host }}" as="login"')], "nas01")).toEqual([fence('sh host="nas01" as="login"')]);
  });

  it("leaves a fence naming another host alone, so R6 can refuse it", () => {
    const other = fence('sh host="nas02" as="root"');
    expect(fillServerHost([other], "nas01")).toEqual([other]);
  });

  it("fills nothing when no name has been reported (and trims a blank one)", () => {
    const hostless = fence('sh as="root"');
    const token = fence('sh host="{{host}}" as="root"');
    expect(fillServerHost([hostless, token], null)).toEqual([hostless, token]);
    expect(fillServerHost([hostless, token], undefined)).toEqual([hostless, token]);
    expect(fillServerHost([hostless, token], "   ")).toEqual([hostless, token]);
  });

  it("leaves a block that names neither host nor account alone", () => {
    const bare = fence("sh");
    expect(fillServerHost([bare], "nas01")).toEqual([bare]);
  });
});

describe("unfilledTokens (R4)", () => {
  it("finds nothing in filled text", () => {
    expect(unfilledTokens("Edit /srv/example/.env on 192.168.1.50")).toEqual([]);
  });

  it("names each token once, however it is spaced", () => {
    expect(unfilledTokens("Use {{host.env.file}} then {{ host.env.file }} again")).toEqual(["{{host.env.file}}"]);
  });

  it("names an unknown token too", () => {
    expect(unfilledTokens("Copy {{host.nowhere}} first")).toEqual(["{{host.nowhere}}"]);
  });

  it("finds several different tokens", () => {
    expect(unfilledTokens("{{host.env.file}} and {{company.slug.deployTarget.name}}")).toEqual(["{{host.env.file}}", "{{company.slug.deployTarget.name}}"]);
  });
});

describe("fillHostTokensIn (a free-text field)", () => {
  const values = { "env.file": "/srv/example/.env", "paths.src": "/srv/example/src" };

  it("fills every recorded token and reports none missing", () => {
    expect(fillHostTokensIn("Edit {{host.env.file}} in {{host.paths.src}}", values)).toEqual({ text: "Edit /srv/example/.env in /srv/example/src", missing: [] });
  });

  it("leaves an unknown token in place and names it missing", () => {
    expect(fillHostTokensIn("Copy to {{host.nowhere}}", values)).toEqual({ text: "Copy to {{host.nowhere}}", missing: ["nowhere"] });
  });

  it.each([
    ["", "empty"],
    ["   ", "blank"],
    ["a\nb", "a newline"],
    ["a\rb", "a carriage return"],
    ["a`b", "a backtick"],
  ])("leaves a token with an unusable value (%s) in place", (value) => {
    expect(fillHostTokensIn("Edit {{host.env.file}}", { "env.file": value })).toEqual({ text: "Edit {{host.env.file}}", missing: ["env.file"] });
  });

  it("names a missing key once even when it appears twice", () => {
    expect(fillHostTokensIn("{{host.nowhere}} then {{host.nowhere}}", values).missing).toEqual(["nowhere"]);
  });
});

describe("placeFindings (R21)", () => {
  it("writes a Where line per place and finds nothing when every step names one", () => {
    const steps = [
      step("List the backups:", sh("ls -l /mnt/example", { host: "nas01", as: "root" })),
      "Open Settings → Secrets.",
      "Go to https://example.com/admin and sign in.",
    ];
    expect(placeFindings(steps)).toEqual({
      where: ["Step 1: terminal on nas01", "Step 2: Boss Man, in Settings", "Step 3: Example, in your browser"],
      findings: [],
    });
  });

  it("reports a step with no place as R21", () => {
    const { where, findings } = placeFindings(["Just do the thing."]);
    expect(where).toEqual([]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ step: 1, rule: "R21" });
    expect(findings[0]!.problem).toMatch(/^doesn't say where it happens/);
  });

  it("reports only the step that names no place, at its own number", () => {
    const { findings } = placeFindings(["Open Settings → Secrets.", "Do the other thing."]);
    expect(findings.map((f) => f.step)).toEqual([2]);
  });

  it("names a hostless command block as the server, or the reported server name", () => {
    expect(placeFindings([fence("sh")]).where).toEqual(["Step 1: terminal on the server"]);
    expect(placeFindings([fence("sh")], "nas01").where).toEqual(["Step 1: terminal on nas01"]);
  });
});

describe("lintLines", () => {
  it("writes one line per finding, numbering steps and naming setup text", () => {
    const findings: LintFinding[] = [
      { step: 2, rule: "R4", problem: "has a token" },
      { step: 0, rule: "R4", problem: "looks odd" },
    ];
    expect(lintLines(findings)).toBe("- Step 2: has a token.\n- The setup text: looks odd.");
  });

  it("writes nothing when there is no finding", () => {
    expect(lintLines([])).toBe("");
  });
});

describe("gitUmaskFindings (R14)", () => {
  it("passes a git write inside a (umask 022 && …) subshell", () => {
    expect(gitUmaskFindings(1, "(umask 022 && cd /srv/example/src && git checkout main)")).toEqual([]);
    expect(gitUmaskFindings(1, "(umask 0022; git pull)")).toEqual([]);
  });

  it("passes a read-only git form", () => {
    expect(gitUmaskFindings(1, "git stash list")).toEqual([]);
    expect(gitUmaskFindings(1, "git status")).toEqual([]);
  });

  it("passes a umask kept inside its own subshell", () => {
    expect(gitUmaskFindings(1, "(umask 077; pg_dump example > /srv/example/backup.dump)")).toEqual([]);
  });

  it("refuses a git write outside the subshell", () => {
    const found = gitUmaskFindings(3, "git pull");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ step: 3, rule: "R14" });
    expect(found[0]!.problem).toMatch(/outside a \(umask 022/);
  });

  it("refuses a umask set at the top level, where it stays set in the terminal", () => {
    const found = gitUmaskFindings(1, "umask 077");
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ step: 1, rule: "R14" });
    expect(found[0]!.problem).toMatch(/stays set in the owner's terminal/);
  });

  it("sees a git write inside a plain subshell", () => {
    expect(gitUmaskFindings(1, "(git clone https://example.com/repo.git)").map((f) => f.rule)).toEqual(["R14"]);
  });
});

describe("updateCardFindings (R15)", () => {
  const enabled: SelfDeployFacts = { enabled: true, installDir: "/srv/example/src" };

  it("finds nothing when the host deployer is not installed", () => {
    const out: LintFinding[] = [];
    updateCardFindings(1, ["bash scripts/deploy.sh", "git checkout main"], { enabled: false, installDir: "/srv/example/src" }, out);
    expect(out).toEqual([]);
  });

  it("refuses an update script, directly or through an interpreter", () => {
    const direct: LintFinding[] = [];
    updateCardFindings(1, ["./scripts/rebuild-live.sh"], enabled, direct);
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({ step: 1, rule: "R15" });
    expect(direct[0]!.problem).toMatch(/update script \(rebuild-live\.sh\)/);

    const through: LintFinding[] = [];
    updateCardFindings(2, ["bash scripts/deploy.sh"], enabled, through);
    expect(through).toHaveLength(1);
    expect(through[0]!.problem).toMatch(/update script \(scripts\/deploy\.sh\)/);
  });

  it("refuses a git write in the install folder, named by cd, -C or the reported folder", () => {
    for (const command of ["git checkout main", "git -C /srv/example/src pull", "(umask 022 && cd /srv/example/src && git pull)"]) {
      const out: LintFinding[] = [];
      updateCardFindings(4, [command], enabled, out);
      expect(out, command).toHaveLength(1);
      expect(out[0]).toMatchObject({ step: 4, rule: "R15" });
      expect(out[0]!.problem).toMatch(/in the install folder/);
    }
  });

  it("passes a git write in another folder (the agent's own checkout)", () => {
    const out: LintFinding[] = [];
    updateCardFindings(1, ["git -C /home/dylan/example checkout main", "cd /home/dylan/example && git pull"], enabled, out);
    expect(out).toEqual([]);
  });

  it("passes a read-only git form", () => {
    const out: LintFinding[] = [];
    updateCardFindings(1, ["git stash list"], enabled, out);
    expect(out).toEqual([]);
  });

  it("never guesses a folder when the install folder is not reported", () => {
    const out: LintFinding[] = [];
    updateCardFindings(1, ["git checkout main"], { enabled: true }, out);
    expect(out).toEqual([]);
  });

  it("appends to the findings it is given", () => {
    const out: LintFinding[] = [{ step: 9, rule: "R3", problem: "earlier" }];
    updateCardFindings(1, ["bash scripts/deploy.sh"], enabled, out);
    expect(out.map((f) => f.rule)).toEqual(["R3", "R15"]);
  });
});

describe("runnerUpdateFindings (R16)", () => {
  const facts = (hold: RunnerHold | null): LintFacts => ({ selfDeploy: { enabled: true, hold } });

  it("finds nothing when the host deployer is not installed", () => {
    const refuse: LintFinding[] = [];
    const warn: LintFinding[] = [];
    runnerUpdateFindings(1, "Press Build and update runners", ["docker ps"], { selfDeploy: { enabled: false, hold: { kind: "update" } } }, refuse, warn);
    expect({ refuse, warn }).toEqual({ refuse: [], warn: [] });
  });

  it("refuses the button while an image update is under way, naming the wait", () => {
    const refuse: LintFinding[] = [];
    const warn: LintFinding[] = [];
    runnerUpdateFindings(2, "Press Build and update runners", [], facts({ kind: "update", since: "10:00" }), refuse, warn);
    expect(refuse).toHaveLength(1);
    expect(refuse[0]).toMatchObject({ step: 2, rule: "R16" });
    expect(refuse[0]!.problem).toMatch(/already under way \(waiting for runs since 10:00\)/);
    expect(warn).toEqual([]);
  });

  it("lets the button through when the pending change is a setting, or nothing is pending", () => {
    for (const hold of [{ kind: "settings" as const }, null]) {
      const refuse: LintFinding[] = [];
      const warn: LintFinding[] = [];
      runnerUpdateFindings(1, "Press Build and update runners", [], facts(hold), refuse, warn);
      expect({ refuse, warn }, String(hold)).toEqual({ refuse: [], warn: [] });
    }
  });

  it("warns about a look-only check of the runners, never refusing it", () => {
    const refuse: LintFinding[] = [];
    const warn: LintFinding[] = [];
    runnerUpdateFindings(3, "Check the runners", ["docker ps"], facts(null), refuse, warn);
    expect(refuse).toEqual([]);
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ step: 3, rule: "warn" });
    expect(warn[0]!.problem).toMatch(/server_status/);
  });

  it("says nothing about a docker look that is not about the runners", () => {
    const refuse: LintFinding[] = [];
    const warn: LintFinding[] = [];
    runnerUpdateFindings(1, "Check the containers", ["docker ps"], facts(null), refuse, warn);
    expect({ refuse, warn }).toEqual({ refuse: [], warn: [] });
  });
});
