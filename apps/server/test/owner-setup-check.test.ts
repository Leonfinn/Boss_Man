// DR-052 (BOS-1138): the owner setup steps' card check. R17 is a phrase table tested row by row; the fill and the
// check are the same when the steps are written and when the go-live card is raised. Every host value here is a
// made-up example: real ones only ever come from the host deployer's report.
import { describe, expect, it } from "vitest";
import { composeCommand, flattenHostRecord, type HostRecord } from "../src/services/host-facts.js";
import { checkOwnerSetup, fillOwnerSetup, ownerSetupWriteCheck } from "../src/services/owner-setup-check.js";
import { lintOwnerSteps } from "../src/services/steps.js";

const r17 = (step: string) => lintOwnerSteps([step]).refuse.filter((f) => f.rule === "R17");

describe("R17 vague host step: refused rows", () => {
  it.each([
    // The original wording of go-live cards 1378a4a8 (ntfy upgrade) and 64b7098a (Checks at once), 11 Nov.
    ["1378a4a8: a .env line with no path", "Remove the NTFY_IMAGE line from .env"],
    ["1378a4a8: a restart with no command", "Restart the notifications add-on"],
    ["64b7098a: a .env line with no path", "Delete BOSSMAN_CHECK_SLOTS from .env"],
    ["a compose file by name only", "Edit docker-compose.override.yml and add the port"],
    ["a compose.yaml by name only", "Open compose.yaml and check the service is listed"],
    ["host.json by name only", "Look in host.json for the folder"],
    [".env in backticks is still only a name", "Open `.env` and set BOSSMAN_HOST_PORT to 3199"],
    ["stop a container", "Stop the ntfy container"],
    ["recreate the stack", "Recreate the stack"],
    ["restart a service", "Restart the proxy service"],
    ["pull with no command", "Pull the ntfy service again"],
    ["remove … from a service", "Remove the old port from the proxy service"],
    ["delete … from a compose file", "Delete the ntfy block from docker-compose.yml"],
  ])("%s", (_name, step) => {
    expect(r17(step)).toHaveLength(1);
  });
});

describe("R17 vague host step: passing rows", () => {
  it.each([
    ["a token for the .env", "Remove the NTFY_IMAGE line from {{host.env.file}}"],
    ["an absolute path", "Remove the NTFY_IMAGE line from /opt/example/src/.env"],
    ["a command that names the file", "Remove the NTFY_IMAGE line from .env: `sed -i '/^NTFY_IMAGE=/d' /opt/example/src/.env`. This prints nothing."],
    ["a command with the host token", "Remove the NTFY_IMAGE line from the stack's .env: `sed -i '/^NTFY_IMAGE=/d' {{host.env.file}}`. This prints nothing."],
    ["a restart with its command", "Restart the notifications add-on: `{{host.compose.cmd}} up -d ntfy`"],
    ["a restart by button path", "Restart the runner service from Settings → Server and runner"],
    ["Boss Man's pointer when it doesn't know the folder", "Remove the NTFY_IMAGE line from the .env file the stack starts with (Settings → Server and runner → This server shows it)"],
    ["no host thing at all", "Start using the new funding source"],
    ["a file that only looks like .env", "Leave .envrc and my.env alone"],
    ["a file named with nothing to do to it", "Your .env file needs nothing new."],
    ["a plain app step", "Settings → Funding → Add funding source"],
  ])("%s", (_name, step) => {
    expect(r17(step)).toEqual([]);
  });
});

/** Made-up facts as the deployer would report them on some host. */
const EXAMPLE: HostRecord = { version: 1, name: "example-host", writtenAt: "2026-11-11T12:00:00Z", ownership: [], paths: { install: "/opt/example", src: "/opt/example/src", deployer: "/opt/example/deployer" }, compose: { files: ["docker-compose.yml", "deploy/ntfy.yml"], bluegreen: false, liveColour: "" }, env: { file: "/opt/example/src/.env" } };
const VALUES = flattenHostRecord(EXAMPLE);

describe("host facts for setup steps (DR-052)", () => {
  it("env.file is the deployer's reported .env", () => {
    expect(VALUES["env.file"]).toBe("/opt/example/src/.env");
  });

  it("with no env report (an older deployer) there is no env.file at all, never one built from the src folder", () => {
    const { env: _gone, ...older } = EXAMPLE;
    const flat = flattenHostRecord(older as HostRecord);
    expect(flat["env.file"]).toBeUndefined();
    expect(Object.values(flat)).not.toContain("/opt/example/src/.env");
    // The card then says where to look it up instead of guessing.
    const filled = fillOwnerSetup(["Remove the NTFY_IMAGE line from {{host.env.file}}"], flat);
    expect(filled.generic).toBe(true);
    expect(filled.steps[0]).toBe("Remove the NTFY_IMAGE line from the .env file the stack starts with (Settings → Server and runner → This server shows it)");
  });

  it("compose.cmd is built from the checkout and the reported compose files", () => {
    expect(VALUES["compose.cmd"]).toBe("cd /opt/example/src && docker compose -f docker-compose.yml -f deploy/ntfy.yml");
    expect(composeCommand({ paths: EXAMPLE.paths, compose: { files: [], bluegreen: false, liveColour: "" } })).toBe("cd /opt/example/src && docker compose");
  });

  it("compose.cmd is absent when a fact is missing or not safe to paste", () => {
    expect(composeCommand({ compose: EXAMPLE.compose })).toBeNull();
    expect(composeCommand({ paths: { ...EXAMPLE.paths!, src: "/opt/my stack" }, compose: EXAMPLE.compose })).toBeNull();
    expect(composeCommand({ paths: EXAMPLE.paths, compose: { files: ["a.yml;reboot"], bluegreen: false, liveColour: "" } })).toBeNull();
  });
});

describe("the setup-step check (fill, then the whole card lint)", () => {
  // The CEO's rewrite of the 11 Nov cards, written host-neutral with tokens, as the steps should be.
  const NTFY = [
    "Check the NTFY_IMAGE line is there: `grep -n '^NTFY_IMAGE=' {{host.env.file}}`",
    "Remove the NTFY_IMAGE line from the stack's .env: `sed -i '/^NTFY_IMAGE=/d' {{host.env.file}}`. This prints nothing.",
    "Restart the notifications add-on: `{{host.compose.cmd}} up -d ntfy`",
    "Check it is running: `{{host.compose.cmd}} ps ntfy`",
  ];
  const SLOTS = ["Delete the BOSSMAN_CHECK_SLOTS line from {{host.env.file}}: `sed -i '/^BOSSMAN_CHECK_SLOTS=/d' {{host.env.file}}`. This prints nothing."];

  it("the CEO's rewritten 1378a4a8 and 64b7098a steps pass, filled with this host's values", () => {
    for (const steps of [NTFY, SLOTS]) {
      for (const mode of ["write", "raise"] as const) {
        const c = checkOwnerSetup(steps, { values: VALUES, serverHost: "example-host" }, mode);
        // These steps keep their commands in sentences, so R21 (no place) is tested on its own below.
        expect([...c.hard, ...c.soft].filter((f) => f.rule !== "R21")).toEqual([]);
        expect(c.generic).toBe(false);
      }
    }
    const shown = checkOwnerSetup(NTFY, { values: VALUES }, "raise").steps;
    expect(shown[1]).toContain("sed -i '/^NTFY_IMAGE=/d' /opt/example/src/.env");
    expect(shown[2]).toContain("`cd /opt/example/src && docker compose -f docker-compose.yml -f deploy/ntfy.yml up -d ntfy`");
  });

  it("the original 1378a4a8 and 64b7098a steps are refused when written", () => {
    const out = ownerSetupWriteCheck(["Remove the NTFY_IMAGE line from .env", "Restart the notifications add-on", "Delete BOSSMAN_CHECK_SLOTS from .env"], { values: VALUES }, { byCeo: false });
    expect(out.error).toMatch(/Step 1: names \.env without saying where it is/);
    expect(out.error).toMatch(/Step 2: says "Restart the notifications add-on"/);
    expect(out.error).toMatch(/Step 3: names \.env/);
    expect(out.error).toContain("{{host.env.file}}");
  });

  it("with no host report, a token in the words becomes the label; one in a command is let through when written but stops the go-live card", () => {
    const write = checkOwnerSetup(NTFY, {}, "write");
    expect([...write.hard, ...write.soft].filter((f) => f.rule !== "R21")).toEqual([]);
    const raise = checkOwnerSetup(NTFY, {}, "raise");
    expect(raise.hard.map((f) => f.rule)).toContain("R4");
    const words = checkOwnerSetup(["Remove the NTFY_IMAGE line from {{host.env.file}}"], {}, "raise");
    expect([...words.hard, ...words.soft].filter((f) => f.rule !== "R21")).toEqual([]);
    expect(words.generic).toBe(true);
  });

  // BOS-1880: the Umami go-live card (BOS-1739) sent the owner to "the go-live card" for the place of two values.
  it("a step that names no place is refused, when written and at go-live, and a step that does gets a Where line", () => {
    const umami = ["Set the two Umami values where the go-live card names"];
    for (const mode of ["write", "raise"] as const) {
      const c = checkOwnerSetup(umami, {}, mode);
      expect([...c.hard, ...c.soft].map((f) => f.rule)).toEqual(expect.arrayContaining(["R21", "R1"]));
    }
    expect(ownerSetupWriteCheck(umami, {}, { byCeo: true, lintOverride: "The owner knows where." }).error).toMatch(/Step 1: doesn't say where it happens/);
    const ok = checkOwnerSetup(["Open Settings → Secrets and add the key.", "Open http://192.168.1.50/admin and save."], {}, "raise");
    expect([...ok.hard, ...ok.soft]).toEqual([]);
    expect(ok.where).toEqual(["Step 1: Boss Man, in Settings", "Step 2: Boss Man, in your browser"]);
  });

  it.each([["the go-live card names"], ["the value the card says"], ["see the setup card"], ["as the owner's go-live card lists"]])("R1 refuses a pointer to a card: %s", (text) => {
    expect(lintOwnerSteps([`Open Settings → Secrets and use ${text}.`]).refuse.map((f) => f.rule)).toContain("R1");
  });

  it("an unknown host token is refused when written", () => {
    const out = ownerSetupWriteCheck(["Open {{host.paths.nowhere}}"], { values: VALUES }, { byCeo: false });
    expect(out.error).toMatch(/R4|no value/);
  });

  it("lintOverride is the CEO's only, needs a reason, covers soft findings and is returned to store", () => {
    const vague = ["Restart the notifications add-on at http://192.168.1.50/admin"];
    expect(ownerSetupWriteCheck(vague, {}, { byCeo: false, lintOverride: "the add-on restarts itself" }).error).toMatch(/Only the CEO/);
    expect(ownerSetupWriteCheck(vague, {}, { byCeo: true, lintOverride: "short" }).error).toMatch(/at least 10/);
    expect(ownerSetupWriteCheck(vague, {}, { byCeo: true })).toMatchObject({ error: expect.stringContaining("pass lintOverride") });
    // R35: a plain reason on one refused step is stored with the step it covers.
    const stored = ownerSetupWriteCheck(vague, {}, { byCeo: true, lintOverride: "The add-on restarts by itself on the update." });
    expect(stored).toEqual({ error: null, override: expect.any(String) });
    expect(JSON.parse((stored as { override: string }).override)).toEqual([{ steps: [1], rules: [expect.any(String)], reason: "The add-on restarts by itself on the update." }]);
    // Nothing to let through: nothing is stored.
    expect(ownerSetupWriteCheck(["Settings → Funding → Add funding source"], {}, { byCeo: true, lintOverride: "not needed at all here" })).toEqual({ error: null, override: null });
    // A command that isn't copy-safe is never let through.
    expect(ownerSetupWriteCheck(["Run `mkdir <your-folder>`"], {}, { byCeo: true, lintOverride: "The owner knows which folder." }).error).toMatch(/placeholder/);
  });

  it("R35: the override names the steps it covers; a refused step it leaves out stays refused (fails on the old code)", () => {
    const two = ["Restart the notifications add-on at http://192.168.1.50/a", "Settings → Funding → Add funding source", "Restart the other add-on at http://192.168.1.50/b"];
    const why = "Both add-ons restart by themselves.";
    // One reason can't cover refusals on two steps.
    expect(ownerSetupWriteCheck(two, {}, { byCeo: true, lintOverride: why }).error).toMatch(/name the steps it covers/);
    // Naming one leaves the other refused.
    const one = ownerSetupWriteCheck(two, {}, { byCeo: true, lintOverride: [{ steps: [1], reason: why }] });
    expect(one.error).toMatch(/Step 3: /);
    expect(one.error).toMatch(/isn't covered/);
    // Naming a step with no refusal is itself refused.
    expect(ownerSetupWriteCheck(two, {}, { byCeo: true, lintOverride: [{ steps: [1, 2, 3], reason: why }] }).error).toMatch(/override for step 2 matches nothing/);
    // Naming both is stored with its scope, and a re-check of the stored value (not strict) passes.
    const both = ownerSetupWriteCheck(two, {}, { byCeo: true, lintOverride: [{ steps: [1, 3], reason: why }] });
    expect(both).toEqual({ error: null, override: expect.any(String) });
    const stored = JSON.parse((both as { override: string }).override);
    expect(stored).toEqual([{ steps: [1, 3], rules: [expect.any(String)], reason: why }]);
    expect(ownerSetupWriteCheck(two, {}, { byCeo: true, lintOverride: stored, strict: false })).toEqual({ error: null, override: expect.any(String) });
    // Step 3 edited to something else: the stored override no longer covers a new refusal there, and an entry whose refusal went is only unused.
    expect(ownerSetupWriteCheck(two, {}, { byCeo: true, lintOverride: [{ steps: [1], reason: why }], strict: false }).error).toMatch(/Step 3/);
    expect(ownerSetupWriteCheck(["Restart the notifications add-on at http://192.168.1.50/a", "Settings → Funding → Add funding source", "Settings → Funding → Add funding source"], {}, { byCeo: true, lintOverride: stored, strict: false })).toMatchObject({ error: null });
  });
});
