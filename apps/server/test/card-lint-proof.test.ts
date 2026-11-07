import { describe, expect, it } from "vitest";
import { checkAsk } from "../src/services/decisions.js";
import { lintOwnerSteps, parseProof, sh, shellCommands, step } from "../src/services/steps.js";

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

// BOS-543 (DR-024 amendment): on 6 Nov the owner was stuck at "(END)" and ":" after psql paged long output.
describe("R10: pagers, typed-into prompts and commands that never return", () => {
  const r10 = (cmd: string) => lintOwnerSteps([step("Run this. This prints nothing.", sh(cmd))]).refuse.filter((f) => f.rule === "R10");

  it.each([
    ["psql -U bossman -d bossman -c \"explain analyze select 1\"", /-P pager=off/],
    ["docker compose exec db psql -U bossman -c \"select 1\"", /-P pager=off/],
    ["git log -5", /--no-pager log/],
    ["git -C /srv/app diff", /--no-pager diff/],
    ["git show HEAD", /--no-pager show/],
    ["systemctl status docker", /--no-pager/],
    ["sudo systemctl status docker", /--no-pager/],
    ["journalctl -u docker", /--no-pager/],
    ["less /var/log/syslog", /pager \(less\)/],
    ["cat big.log | less", /pager \(less\)/],
    ["more notes.txt", /pager \(more\)/],
    ["man docker", /--help/],
    ["docker exec -it bossman-db psql -U bossman", /psql prompt.*-c/],
    ["sudo -u postgres psql", /psql prompt/],
    ["docker exec -it app bash", /shell inside the container/],
    ["docker compose exec app sh", /shell inside the container/],
    ["mysql -u root", /mysql prompt.*-e/],
    ["docker stats", /--no-stream/],
    ["docker logs -f app", /never returns.*--tail 50/],
    ["docker logs --follow app", /never returns/],
    ["docker logs -tf app", /never returns/],
    ["docker compose logs -f", /never returns/],
    ["docker compose -f docker-compose.yml logs --tail 20 -f app", /never returns/],
    ["tail -f /var/log/syslog", /never returns.*tail -n 50/],
    ["tail -n 50 -F app.log", /never returns/],
    ["journalctl -fu docker", /never returns.*--no-pager -n 50/],
    ["watch docker ps", /never returns.*once/],
    ["top", /top -b -n 1/],
    ["htop", /never returns/],
    ["ping 192.0.2.1", /-c 3/],
  ])("refuses %s and says what to use instead", (cmd, instead) => {
    const found = r10(cmd);
    expect(found.length, cmd).toBeGreaterThan(0);
    expect(found.map((f) => f.problem).join("\n")).toMatch(instead);
  });

  it.each([
    ["psql -P pager=off -U bossman -c \"explain analyze select 1\""],
    ["psql --pset=pager=off -c \"select 1\""],
    ["PAGER=cat psql -c \"select 1\""],
    ["docker exec bossman-db psql -U bossman -c \"select 1\""],
    ["docker exec -i bossman-db psql -U bossman < dump.sql"],
    ["psql -c \"select 1\" | cat"],
    ["D=$(psql -tAc \"select 1\")"],
    ["git --no-pager log -5"],
    ["git -P diff"],
    ["git log -5 | cat"],
    ["git -C /srv/app pull"],
    ["git diff --quiet"],
    ["systemctl --no-pager status docker"],
    ["sudo systemctl restart docker"],
    ["systemctl is-active docker"],
    ["journalctl --no-pager -n 50 -u docker"],
    ["journalctl -u docker | tail -n 50"],
    ["docker stats --no-stream"],
    ["docker logs --tail 50 app"],
    ["docker compose -f docker-compose.yml logs --tail 50"],
    ["tail -n 50 /var/log/syslog"],
    ["top -b -n 1 | head -n 20"],
    ["top -bn1"],
    ["ping -c 3 192.0.2.1"],
    ["docker exec app sh -c \"ls /data\""],
    ["docker exec -it app bash -lc \"ls /data\""],
    ["cat /var/log/more.log"],
    ["docker compose ps"],
  ])("lets %s through", (cmd) => {
    expect(r10(cmd)).toEqual([]);
  });

  it("refuses the 6 Nov speed-measuring steps (psql opened, queries typed into it)", () => {
    const steps = [step("Open the database. This prints nothing.", sh("docker exec -it bossman-db psql -U bossman")), "Paste `explain analyze select * from runs;` and press Enter."];
    expect(rules(steps, "rehearsed speed @ 0123abcd")).toContain("1:R10");
  });

  it("can't be overridden, even by the CEO", () => {
    for (const cmd of ["git log -5", "tail -f app.log", "docker exec -it db psql -U bossman"]) {
      const r = checkAsk({ triedFirst: TRIED, steps: [step("Look at it. This prints nothing.", sh(cmd))], lintOverride: "The owner knows to press q.", byCeo: true });
      expect(r.error, cmd).toMatch(/can't let through.*pager or never returns/);
    }
  });

  it("only accepts systemctl status as the look-only last step with --no-pager", () => {
    const steps = (last: string) => [step("Restart it. This prints nothing.", sh("sudo systemctl restart docker")), step("Check it's running.", sh(last))];
    expect(rules(steps("systemctl --no-pager status docker"), "not rehearsed: the owner's own host, first run there")).toEqual([]);
    expect(rules(steps("systemctl status docker"), "not rehearsed: the owner's own host, first run there")).toEqual(["2:R10", "2:R11"]);
  });
});

// The owner thought card 42cc7ccf's step 3 had failed because it printed nothing (6 Nov, BOS-550 answer).
describe("R12: steps that print nothing say so", () => {
  const at = { host: "bossman", as: "root" } as const;
  // Steps 2, 3, 6, 7 and 8 of card 42cc7ccf, as the CEO raised it at 09:38 on 6 Nov.
  const card = (say = "", echo = "") => [
    step(`Go to the install folder:${say}`, sh("cd /srv/apps/boss-man/src", at)),
    step(`Read the deployer folder's location from your settings file (the later steps use it):${say}`, sh(`D=$(sed -n 's/^BOSSMAN_DEPLOYER=//p' .env)${echo}`, at)),
    step(`Keep a backup of the current deployer, so you can undo:${say}`, sh('cp "$D/host-deployer.sh" "$D/host-deployer.sh.before-bos494"', at)),
    step(`Copy the new script next to it under a temporary name:${say}`, sh('install -o root -g root -m 750 scripts/host-deployer.sh "$D/host-deployer.sh.new"', at)),
    step(`Swap it into place in one move:${say}`, sh('mv "$D/host-deployer.sh.new" "$D/host-deployer.sh"', at)),
  ];
  const PROOF = "rehearsed host-deployer @ 0123abcd";

  it("refuses every step of card 42cc7ccf, and suggests echoing an assignment's value", () => {
    const { refuse } = lintOwnerSteps(card(), undefined, parseProof(PROOF) as never);
    expect(refuse.map((f) => `${f.step}:${f.rule}`)).toEqual(["1:R12", "2:R12", "3:R12", "4:R12", "5:R12"]);
    expect(refuse[1]!.problem).toMatch(/D=\$\(…\); echo "\$D"/);
    expect(refuse[0]!.problem).toMatch(/This prints nothing\./);
  });

  it("passes the same steps when they say so, or when the assignment echoes its value", () => {
    expect(rules(card(" This prints nothing."), PROOF)).toEqual([]);
    const echoed = card("", '; echo "$D"');
    expect(rules([echoed[1]!], PROOF)).toEqual([]);
    expect(rules(card(" It prints nothing."), PROOF)).toEqual([]);
  });

  it.each([
    ["export PATH=$PATH:/opt/bin"],
    ["mkdir -p /srv/app && chmod 750 /srv/app && chown root:root /srv/app"],
    ["sudo ln -s /srv/app/current /srv/app/live"],
    ["touch .env"],
    ["rm -f old.tar"],
    ["X=1 Y=2"],
  ])("refuses %s on its own", (cmd) => {
    expect(rules([step("Do it.", sh(cmd))], PROOF)).toEqual(["1:R12"]);
  });

  it.each([
    ["cp -v a b"],
    ["mkdir -pv /srv/app"],
    ["cd /srv/app && ls"],
    ["cd -"],
    ["export"],
    ["D=$(cat x); echo \"$D\""],
    ["docker compose up -d"],
    ["curl -fsS https://bossman.example.com/health"],
  ])("lets %s through", (cmd) => {
    expect(rules([step("Do it.", sh(cmd))], PROOF)).toEqual([]);
  });

  it("only judges command blocks, not inline code in a sentence", () => {
    expect(rules(["Your files are in the folder you opened with `cd /srv/app`."])).toEqual([]);
  });

  it("lintOverride lets R12 through, but not R10 on the same card", () => {
    const over = checkAsk({ triedFirst: TRIED, steps: card(), proof: PROOF, lintOverride: "Each step says what the next one checks.", byCeo: true });
    expect(over.error).toBeNull();
    expect(over.lint?.override?.findings.map((f) => f.rule)).toEqual(["R12", "R12", "R12", "R12", "R12"]);
    const both = checkAsk({ triedFirst: TRIED, steps: [...card(), step("Look at the log.", sh("tail -f app.log"))], proof: PROOF, lintOverride: "Each step says what the next one checks.", byCeo: true });
    expect(both.error).toMatch(/Step 6: .*never returns/);
    expect(checkAsk({ triedFirst: TRIED, steps: card(), proof: PROOF }).error).toMatch(/prints nothing when it works/);
  });
});

describe("shellCommands", () => {
  it("doesn't split inside quotes or $(…), and marks pipes", () => {
    expect(shellCommands("D=$(sed -n 's/^A=//p;s/b|c//' .env); echo \"$D; x\" | cat 2>&1 && ls").map((c) => [c.words.join(" "), c.pipedIn, c.pipedOut])).toEqual([
      ["D=$(sed -n 's/^A=//p;s/b|c//' .env)", false, false],
      ['echo "$D; x"', false, true],
      ["cat 2>&1", true, false],
      ["ls", false, false],
    ]);
  });
});

describe("R11: host commands need proof", () => {
  const host = [step("Restart Tailscale.", sh("docker compose -f docker-compose.tailscale.yml up -d")), step("Check it's up.", sh("docker compose ps"))];

  it.each([["docker ps"], ["docker-compose up -d"], ["sudo systemctl restart docker"], ["tailscale up"], ["chown -R 1000 /srv/bossman"], ["chmod 600 .env"], ["nano .env"], ["echo TS_AUTHKEY=abc >> /opt/bossman/.env"]])("refuses %s without proof", (cmd) => {
    expect(rules([step("Do it. This may print nothing.", sh(cmd))])).toEqual(["1:R11"]);
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
