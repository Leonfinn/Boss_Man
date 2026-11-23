// The swap settings (941b): absent = a move stops at ready-to-swap as in 941a; present = parsed strictly.
import { describe, expect, test } from "vitest";
import { swapConfig } from "./fake-daemon.js";
import { testConfig } from "./helpers.js";

describe("swap settings", () => {
  test("without the front network there is no swap", () => {
    expect(testConfig().swap).toBeNull();
  });

  test("with them: the install's values, the design's timings", () => {
    const sw = swapConfig().swap!;
    expect(sw).toMatchObject({ frontNetwork: "test_front", dbContainer: "test-db", readySeconds: 120, handoverSeconds: 30, soakSeconds: 900, soakCheckSeconds: 60, soakPollSeconds: 10, handoverCallSeconds: 1, backupsKeep: 3, layout: 1, selfName: "updater" });
    expect(sw.serverEnv).toContain("BOSSMAN_LAUNCHER=1");
    expect(sw.serverMounts[0]).toEqual({ source: "test_config", target: "/run/config", readOnly: true });
  });

  test("the updater's own settings are kept to give the next updater", () => {
    expect(swapConfig().rawEnv["UPDATER_FRONT_NETWORK"]).toBe("test_front");
    expect(Object.keys(swapConfig().rawEnv).every((k) => k.startsWith("UPDATER_"))).toBe(true);
  });

  test.each([
    ["a colour set in the spec env", { UPDATER_SPEC_ENV: "BOSSMAN_COLOUR=blue" }, /must not set BOSSMAN_COLOUR/],
    ["a role set in the spec env", { UPDATER_SPEC_ENV: "BOSSMAN_ROLE=auto" }, /must not set BOSSMAN_COLOUR or BOSSMAN_ROLE/],
    ["a line that is not KEY=value", { UPDATER_SPEC_ENV: "not a pair" }, /not KEY=value/],
    ["a mount that is not volume:/path", { UPDATER_SPEC_MOUNTS: "/etc:/etc" }, /not volume:\/path/],
    ["a mount with an odd mode", { UPDATER_SPEC_MOUNTS: "vol:/x:rw" }, /not volume:\/path/],
    ["no database container", { UPDATER_DB_CONTAINER: "" }, /UPDATER_DB_CONTAINER is not set/],
  ])("stops at start-up with %s", (_n, over, re) => {
    expect(() => swapConfig(over)).toThrowError(re);
  });
});
