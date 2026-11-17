// R31 (BOS-1666): owner-card steps that run docker compose, checked against the host's reported compose files and
// blue/green state. Every host value is a made-up example: real ones only come from the host deployer's report.
import { describe, expect, it } from "vitest";
import { composeFactsFrom } from "../src/services/compose-steps.js";
import { checkOwnerSetup } from "../src/services/owner-setup-check.js";
import { lintOwnerSteps } from "../src/services/steps.js";

const FILES = "docker-compose.yml,deploy/bluegreen.yml";
const single = { "compose.files": FILES, "compose.bluegreen": "false", "compose.liveColour": "", "compose.cmd": "cd /opt/example/src && docker compose -f docker-compose.yml -f deploy/bluegreen.yml", "paths.src": "/opt/example/src", "env.file": "/opt/example/src/.env" };
const bg = { ...single, "compose.bluegreen": "true", "compose.liveColour": "blue" };
const bgUnknown = { ...bg, "compose.liveColour": "" };

/** The R31 findings of a card, through the same fill and check the owner-setup steps get. */
const r31 = (steps: string[], values: Record<string, string> = bg) => {
  const c = checkOwnerSetup(steps, { values, serverHost: "example-host" }, "write");
  return [...c.hard, ...c.soft].filter((f) => f.rule === "R31");
};

const EDIT = "In `{{host.env.file}}` change the line to `COMPOSE_FILE=docker-compose.yml:deploy/bluegreen.yml:deploy/tunnel.yml`. This prints nothing.";

describe("composeFactsFrom", () => {
  it("is undefined when the host reported no compose fact, so R31 stays quiet", () => {
    expect(composeFactsFrom(undefined)).toBeUndefined();
    expect(composeFactsFrom({ "paths.src": "/opt/example/src" })).toBeUndefined();
  });
  it("reads files, blue/green and the live colour", () => {
    expect(composeFactsFrom(bg)).toMatchObject({ files: ["docker-compose.yml", "deploy/bluegreen.yml"], bluegreen: true, liveColour: "blue" });
  });
});

describe("R31a: stale compose command", () => {
  // The a2591501 draft: an edit to COMPOSE_FILE, then the token, whose -f list is from the last report. Passed the checker before R31.
  const draft = [EDIT, "Start the tunnel: `{{host.compose.cmd}} up -d cloudflared`"];
  it("refuses {{host.compose.cmd}} after a step that edits COMPOSE_FILE", () => {
    const f = r31(draft, single);
    expect(f).toHaveLength(1);
    expect(f[0]!.step).toBe(2);
    expect(f[0]!.problem).toContain("R31a");
    expect(f[0]!.problem).toContain("cd {{host.paths.src}} && docker compose");
  });
  it("passes the corrected card: cd to the checkout, compose reads COMPOSE_FILE from .env", () => {
    expect(r31([EDIT, "Start the tunnel: `cd {{host.paths.src}} && docker compose up -d --no-deps cloudflared`"])).toEqual([]);
    expect(r31([EDIT, "Start the tunnel: `cd {{host.paths.src}} && docker compose up -d --no-deps cloudflared`"], single)).toEqual([]);
  });
  it("passes the token when no step edits COMPOSE_FILE", () => {
    expect(r31(["Restart the proxy: `{{host.compose.cmd}} restart proxy`"], single)).toEqual([]);
  });
  it("refuses a -f file the host doesn't report when no earlier step adds it", () => {
    const f = r31(["Start it: `cd {{host.paths.src}} && docker compose -f docker-compose.yml -f deploy/tunnel.yml up -d --no-deps cloudflared`"], single);
    expect(f.map((x) => x.problem).join("\n")).toContain("R31a: names the compose file deploy/tunnel.yml");
  });
  it("passes that -f file once an earlier step adds it, and a reported one given another way (./ prefix)", () => {
    expect(r31([EDIT, "Start it: `cd {{host.paths.src}} && docker compose -f docker-compose.yml -f deploy/tunnel.yml up -d --no-deps cloudflared`"], single)).toEqual([]);
    expect(r31(["Look: `cd {{host.paths.src}} && docker compose -f ./deploy/bluegreen.yml ps`"], single)).toEqual([]);
  });
  it("does not read `logs -f` as a compose file", () => {
    expect(r31(["Watch: `cd {{host.paths.src}} && docker compose logs -f proxy`"], single)).toEqual([]);
  });
});

describe("R31b: bare up or start under blue/green", () => {
  it.each([
    ["bare up", "Start everything: `cd {{host.paths.src}} && docker compose up -d`"],
    ["up with only flags", "Start everything: `cd {{host.paths.src}} && docker compose up -d --no-deps --pull always`"],
    ["bare start", "Start it: `cd {{host.paths.src}} && docker compose start`"],
    ["the filled token", "Start it: `{{host.compose.cmd}} up -d`"],
  ])("refuses %s", (_n, step) => {
    const f = r31([step]);
    expect(f.some((x) => x.problem.startsWith("R31b"))).toBe(true);
  });
  it("passes a named service, with or without --no-deps, and a bare restart", () => {
    expect(r31(["Start it: `cd {{host.paths.src}} && docker compose up -d --no-deps cloudflared`"])).toEqual([]);
    expect(r31(["Start it: `cd {{host.paths.src}} && docker compose up -d --pull never cloudflared`"])).toEqual([]);
    expect(r31(["Restart: `cd {{host.paths.src}} && docker compose restart`"])).toEqual([]);
  });
  it("leaves a single-server host alone", () => {
    expect(r31(["Start everything: `cd {{host.paths.src}} && docker compose up -d`"], single)).toEqual([]);
  });
});

describe("R31c: a colour named where it lasts, or in a command", () => {
  it.each([
    ["a tunnel URL", "Point the tunnel's service URL at `http://server-blue:3100`"],
    ["a .env value", "Set `BOSSMAN_UPSTREAM=server-green-front` in `{{host.env.file}}`"],
    ["a bookmark, in a sentence", "Bookmark the proxy address of server-blue for the phone"],
  ])("refuses %s", (_n, step) => {
    const f = r31([step]);
    expect(f.some((x) => x.problem.startsWith("R31c") && x.problem.includes("lasts"))).toBe(true);
  });
  it("refuses a command naming a colour when the live colour is unknown", () => {
    const f = r31(["Look: `cd {{host.paths.src}} && docker compose logs --tail 20 server-blue`"], bgUnknown);
    expect(f.some((x) => x.problem.includes("hasn't reported which colour is live"))).toBe(true);
  });
  it("refuses a command naming the standby, passes the live colour", () => {
    expect(r31(["Look: `cd {{host.paths.src}} && docker compose logs --tail 20 server-green`"]).some((x) => x.problem.includes("the standby colour"))).toBe(true);
    expect(r31(["Look: `cd {{host.paths.src}} && docker compose logs --tail 20 server-blue`"])).toEqual([]);
  });
  it("passes the proxy's alias, which always reaches the live colour", () => {
    expect(r31(["Point the tunnel's service URL at `http://server:3100`"])).toEqual([]);
  });
  it("leaves a single-server host alone", () => {
    expect(r31(["Point the tunnel's service URL at `http://server-blue:3100`"], single)).toEqual([]);
  });
});

describe("R31d: the parked server service under blue/green", () => {
  it.each([
    ["restart", "Restart: `cd {{host.paths.src}} && docker compose restart server`"],
    ["up", "Start: `cd {{host.paths.src}} && docker compose up -d --no-deps server`"],
  ])("refuses %s of server", (_n, step) => {
    expect(r31([step]).some((x) => x.problem.startsWith("R31d"))).toBe(true);
  });
  it("passes it on a single-server host, and a different service starting with 'server'", () => {
    expect(r31(["Restart: `cd {{host.paths.src}} && docker compose restart server`"], single)).toEqual([]);
    expect(r31(["Restart: `cd {{host.paths.src}} && docker compose restart server-tools`"])).toEqual([]);
  });
});

describe("R31 reaches every card path", () => {
  it("lintOwnerSteps gets the facts through LintFacts.compose (what raise_decision passes)", () => {
    const compose = composeFactsFrom(bg)!;
    const out = lintOwnerSteps(["Start everything: `cd /opt/example/src && docker compose up -d`"], { compose, serverHost: "example-host" });
    expect(out.refuse.some((f) => f.rule === "R31")).toBe(true);
  });
  it("is quiet without compose facts", () => {
    const out = lintOwnerSteps(["Start everything: `cd /opt/example/src && docker compose up -d`"], { serverHost: "example-host" });
    expect(out.refuse.some((f) => f.rule === "R31")).toBe(false);
  });
});
