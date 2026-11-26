import { describe, expect, it } from "vitest";
import { currentHandSteps } from "../src/services/decisions.js";
import { lintOwnerSteps } from "../src/services/steps.js";
import { sh, step } from "../src/services/steps.js";

// BOS-2747: a hand-apply card held by the card check is raised again from the steps stored when the owner approved,
// which can predate BOS-2527 (host-deployer copy mode) and BOS-2619 (no blue/green colour in a step).
const W = { host: "nas01", as: "root" as const };
const HOSTS = [{ name: "nas01", login: "owner", ownership: [{ path: "/srv/bm/src", owner: "root", group: "root", mode: "755", role: "backups" as const }, { path: "/srv/bm/deployer", owner: "root", group: "root", mode: "755" }] }];
const SRC = "/srv/bm/src/scripts/host-deployer.sh";
const DEST = "/srv/bm/deployer/host-deployer.sh";

const oldCopy = step("Copy the changed host-deployer script into the deployer folder with this command, on the same machine. It prints the one file it copied:", sh(`cp -v ${SRC} ${DEST} && chown root:root ${DEST} && chmod 750 ${DEST}`, W));
const oldColour = step("Check the new server has taken charge.", sh("cd /srv/bm/src && docker compose exec -T server-blue node -e \"1\"", W), "If it says standby, run this next:", sh("cd /srv/bm/src && docker compose kill -s SIGUSR2 server-blue", W));
const apply = step("Apply it.", sh("cd /srv/bm/src && scripts/rebuild-live.sh", W));

describe("currentHandSteps", () => {
  it("rewrites the old host-deployer copy and drops the colour step", () => {
    const out = currentHandSteps([apply, oldCopy, oldColour]);
    expect(out).toHaveLength(2);
    expect(out[1]).toContain(`install -v -m 0750 -o root -g root ${SRC} ${DEST}`);
    expect(out.join("\n")).not.toMatch(/server-(blue|green)|chmod 750/);
  });

  it("leaves current steps alone", () => {
    expect(currentHandSteps([apply])).toEqual([apply]);
  });

  it("the rewritten copy passes the owner-card R6 check, the old one did not", () => {
    const r6 = (s: string[]) => lintOwnerSteps(s, { hosts: HOSTS, serverHost: "nas01" }).refuse.filter((f) => f.rule === "R6");
    expect(r6([oldCopy])).not.toEqual([]);
    expect(r6(currentHandSteps([oldCopy]))).toEqual([]);
  });
});
