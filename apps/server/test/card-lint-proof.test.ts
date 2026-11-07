import { describe, expect, it } from "vitest";
import { checkAsk } from "../src/services/decisions.js";
import { lintOwnerSteps, parseProof, sh, step } from "../src/services/steps.js";

// Card lint R10 (no commands that wait for typed input) and R11 (cards with host commands say how they were
// proven), DR-024 ticket 3 (BOS-528). The 5 Nov 22:40 card asked the owner to type a Tailscale key into a
// `read -rsp` prompt, on steps nobody had tried on a machine with Docker.

const TRIED = "I can't reach the owner's host from the runner, and this needs their Tailscale account.";
const rules = (steps: string[], proof?: string) => lintOwnerSteps(steps, undefined, proof === undefined ? undefined : (parseProof(proof) as never)).refuse.map((f) => `${f.step}:${f.rule}`);

describe("R10: commands that wait for typed input", () => {
  it.each([
    ["read -rsp 'Auth key: ' TS_AUTHKEY"],
    ["read -p 'Host: ' HOST"],
    ["read KEY"],
    ["cd ~/bossman && read -s KEY"],
    ["echo secret | sudo -S true"],
    ["sudo -kS whoami"],
    ["passwd"],
    ["sudo passwd bossman"],
    ["ssh-keygen"],
    ["ssh-keygen -t ed25519 -f /root/.ssh/bossman"],
    ["docker login ghcr.io"],
  ])("refuses %s", (cmd) => {
    expect(rules([step("Run this.", sh(cmd))])).toContain("1:R10");
  });

  it("refuses one in inline code too, and says what to do instead", () => {
    const { refuse } = lintOwnerSteps(["Type `read -rsp 'Key: ' TS_AUTHKEY` and paste the key."]);
    expect(refuse).toEqual([expect.objectContaining({ step: 1, rule: "R10", problem: expect.stringMatching(/Secrets screen/) })]);
  });

  it.each([
    ["ssh-keygen -t ed25519 -N '' -f /root/.ssh/bossman"],
    ["ssh-keygen -lf /root/.ssh/bossman.pub"],
    ["echo \"$TOKEN\" | docker login ghcr.io -u bossman --password-stdin"],
    ["cat .bash_history | grep reader"],
    ["docker run --read-only alpine true"],
    ["cat ~/readme.txt"],
    ["sudo systemctl restart docker"],
  ])("lets %s through", (cmd) => {
    expect(rules([step("Run this.", sh(cmd)), step("Check it.", sh("docker compose ps"))], "not rehearsed: the owner's own host, first run there")).not.toContain("1:R10");
  });

  it("can't be overridden, even by the CEO", () => {
    const r = checkAsk({ triedFirst: TRIED, steps: [step("Enter the key.", sh("read -rsp 'Key: ' TS_AUTHKEY"))], lintOverride: "The owner knows what to type here.", byCeo: true });
    expect(r.error).toMatch(/R10|typed input|answer by typing/);
    expect(r.error).toMatch(/waits for typed input/);
  });
});

describe("R11: host commands need proof", () => {
  const host = [step("Restart Tailscale.", sh("docker compose -f docker-compose.tailscale.yml up -d")), step("Check it's up.", sh("docker compose ps"))];

  it.each([["docker ps"], ["docker-compose up -d"], ["sudo systemctl restart docker"], ["tailscale up"], ["chown -R 1000 /srv/bossman"], ["chmod 600 .env"], ["nano .env"], ["echo TS_AUTHKEY=abc >> /opt/bossman/.env"]])("refuses %s without proof", (cmd) => {
    expect(rules([step("Do it.", sh(cmd))])).toEqual(["1:R11"]);
  });

  it("names the first step with a host command, once", () => {
    expect(rules(["Open Settings → Server and runner.", ...host])).toEqual(["2:R11"]);
  });

  it("leaves cards without host commands alone", () => {
    expect(rules(["Open Settings → Server and runner → Updates.", "Click Build and update runners.", step("Check the page answers.", sh("curl -fsS https://bossman.example.com/health"))])).toEqual([]);
    expect(rules(["The docker page in Settings shows the version.", "Your .env file needs nothing new."])).toEqual([]);
  });

  it("accepts a rehearsal, and a first-time card that ends with a look-only check", () => {
    expect(rules(host, "rehearsed tailscale @ 0123abcd")).toEqual([]);
    expect(rules(host, "not rehearsed: the login needs the owner's own Tailscale account")).toEqual([]);
  });

  it("refuses a first-time card whose last step changes something", () => {
    const steps = [host[1]!, host[0]!];
    expect(rules(steps, "not rehearsed: the login needs the owner's own Tailscale account")).toEqual(["2:R11"]);
    expect(rules([...steps, "Tell us it worked."], "not rehearsed: the login needs the owner's own Tailscale account")).toEqual(["3:R11"]);
  });

  it("reads the two proof forms and refuses anything else", () => {
    expect(parseProof("  rehearsed   tailscale @ 0123ABCD ")).toEqual({ rehearsed: true, script: "tailscale", commit: "0123abcd" });
    expect(parseProof("Rehearsed scripts/rehearse/tailscale.sh@0123abcdef")).toEqual({ rehearsed: true, script: "scripts/rehearse/tailscale.sh", commit: "0123abcdef" });
    expect(parseProof("not rehearsed: the owner's router setting")).toEqual({ rehearsed: false, part: "the owner's router setting" });
    for (const bad of ["rehearsed", "rehearsed tailscale", "rehearsed tailscale @ main", "not rehearsed: new", "tested it", "yes"]) expect(typeof parseProof(bad)).toBe("string");
  });

  it("checkAsk refuses a malformed proof, keeps a good one for the banner, and lets the CEO override a missing one", () => {
    expect(checkAsk({ triedFirst: TRIED, steps: host, proof: "tested it" }).error).toMatch(/proof must be "rehearsed <script> @ <commit>"/);
    expect(checkAsk({ triedFirst: TRIED, steps: host }).error).toMatch(/Step 1: has a host command, so the card needs proof/);
    const ok = checkAsk({ triedFirst: TRIED, steps: host, proof: "not rehearsed: the login needs the owner's own account" });
    expect(ok.error).toBeNull();
    expect(ok.lint?.proof).toEqual({ rehearsed: false, part: "the login needs the owner's own account" });
    const over = checkAsk({ triedFirst: TRIED, steps: host, lintOverride: "Rehearsal job isn't built yet; same steps as yesterday's card.", byCeo: true });
    expect(over.error).toBeNull();
    expect(over.lint?.override?.findings).toEqual([expect.objectContaining({ rule: "R11" })]);
    expect(checkAsk({ triedFirst: TRIED, steps: host, lintOverride: "Rehearsal job isn't built yet.", byCeo: false }).error).toMatch(/Only the CEO/);
  });

  it("a card without steps needs no proof", () => {
    expect(checkAsk({ triedFirst: TRIED, proof: "rehearsed tailscale @ 0123abcd" })).toEqual({ error: null });
  });
});
