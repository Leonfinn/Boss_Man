import { describe, expect, it } from "vitest";
import { decidePermission, judgePermission, selfSetVariableRefusal } from "../src/index.js";

// BOS-2244 (R58). The ticket folder of the asking agent; a made-up id.
const OWN = "0a294937-f4cc-47a1-926e-00ff4883b5c6";
const ROOT = "/home/node/workspaces";
const CHECKOUT = `${ROOT}/tickets/${OWN}`;
const judge = (cmd: string) => judgePermission("It runs a command.", cmd, OWN, "-p", ROOT);
const exec = (command: string) => ({ title: command, kind: "execute", rawInput: { command } });

describe("a self-set literal variable is read like its typed-out form (BOS-2244 a)", () => {
  it.each([
    [`R=${CHECKOUT}; git -C "$R" grep -n x`, `git -C ${CHECKOUT} grep -n x`],
    [`R=${CHECKOUT}; git -C $R grep -n x`, `git -C ${CHECKOUT} grep -n x`],
    [`R=${CHECKOUT}; git -C \${R} grep -n x`, `git -C ${CHECKOUT} grep -n x`],
    [`R=${CHECKOUT}; cd "$R" && git --no-pager log --oneline -5`, `cd ${CHECKOUT} && git --no-pager log --oneline -5`],
  ])("%s is judged like %s", (withVar, typed) => {
    expect(judge(typed).verdict).toBe("allow");
    expect(judge(withVar).verdict).toBe("allow");
    // The policy never raised a card for these.
    expect(decidePermission(exec(withVar), []).outcome).toBe("allow");
  });
  it.each([
    "R=/etc; git -C \"$R\" grep -n x",
    "R=$HOME; git -C \"$R\" grep -n x",
    `R=${CHECKOUT}; R=/etc; git -C "$R" grep -n x`,
    `read R; git -C "$R" grep -n x`,
    `R=$(cat /tmp/where); git -C "$R" grep -n x`,
    `git -C "$R" grep -n x; R=${CHECKOUT}`,
    `for R in /etc ${CHECKOUT}; do git -C "$R" grep -n x; done`,
    `R=/etc; cd "$R" && git --no-pager log`,
  ])("keeps today's Deny: %s", (cmd) => expect(judge(cmd).verdict).toBe("deny"));
});

describe("a program run through a variable the command set itself is refused with a rewrite (BOS-2244 b)", () => {
  it.each([
    [`R=${CHECKOUT}; G="git -C $R"; $G grep -n x`, "G"],
    [`G="git -C ${CHECKOUT}"; $G grep -n x`, "G"],
    [`G=git; $G status`, "G"],
    [`G=git; "$G" status`, "G"],
    [`for c in "git status"; do $c; done`, "c"],
    [`T=${CHECKOUT}/scripts; $T/run.sh`, "T"],
  ])("%s", (cmd, name) => {
    // Before this change the guard sent every one of these to a card.
    expect(decidePermission(exec(cmd), []).outcome).toBe("owner");
    const text = selfSetVariableRefusal(cmd);
    expect(text).toContain(`$${name}`);
    expect(text).toMatch(/Type the command out in full/);
  });
});

describe("everything else keeps today's route (BOS-2244 c)", () => {
  it.each([
    "R=/etc; rm -rf $R",
    `G="git -C ${CHECKOUT}"; $G grep -n x; rm -rf /etc`,
    `read G; $G status`,
    `G=$(cat /tmp/g); $G status`,
    "G=`cat /tmp/g`; $G status",
    "G=git; G=rm; $G -rf /",
    `$G status; G=git`,
    "HOME=/tmp; $HOME/x",
    "$G status",
    "G=git; eval $G status",
    "export G=git; $G status",
    "G=git; git status",
    "echo hello",
  ])("no refusal: %s", (cmd) => expect(selfSetVariableRefusal(cmd)).toBeNull());
});
