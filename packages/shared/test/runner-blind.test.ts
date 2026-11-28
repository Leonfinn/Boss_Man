import { describe, expect, it } from "vitest";
import { runnerBlindPhrase, runnerBlindRefusal, type Criterion } from "../src/acceptance.js";

// BOS-2864: an after-merge criterion the runner can't observe (no Docker daemon, no host logs, no owner-only panel)
// could never be reported, so it sat in "Merged, watching" for ever. Hits and misses both matter here.

describe("runnerBlindPhrase", () => {
  it.each([
    ["`docker ps` on the host shows the new container healthy", "docker ps"],
    ["docker compose logs show no restart loop", "docker compose logs"],
    ["The container logs show the line 'ready'", "container logs"],
    ["The file exists in the container", "in the container"],
    ["The host logs show no errors", "host logs"],
    ["journalctl shows the unit started", "journalctl"],
    ["syslog has no permission denied lines", "syslog"],
    ["On the host, the log file ends with 'done'", "On the host, the log"],
    ["The owner's panel shows the new button", "The owner's panel"],
    ["TrueNAS's UI lists the app as running", "TrueNAS's UI"],
  ])("matches %j", (text, phrase) => {
    expect(runnerBlindPhrase(text)).toBe(phrase);
  });

  it.each([
    "The merged tests cover the container restart handling",
    "The live page shows the new heading",
    "Settings → Runner lists the last 7 days of connection",
    "The server status reports repo.probe = ok",
    "The container image builds in CI",
    "A host report arrives after go-live",
  ])("does not match %j", (text) => {
    expect(runnerBlindPhrase(text)).toBeNull();
  });
});

describe("runnerBlindRefusal", () => {
  const after = (text: string): Criterion => ({ text, after: "merge" });

  it("refuses an after-merge criterion with no way to see it, naming it and the three ways out", () => {
    const r = runnerBlindRefusal([after("docker ps shows the container up")]);
    expect(r).toContain('"docker ps shows the container up"');
    expect(r).toContain("Rewrite it as a test");
    expect(r).toContain("fact clause");
    expect(r).toContain("page clause");
    expect(r).toContain("owner card");
  });

  it("accepts it with a fact clause, a page clause or a card that stands in", () => {
    expect(runnerBlindRefusal([after("docker ps shows it up (fact: repo.probe = ok)")])).toBeNull();
    expect(runnerBlindRefusal([after('The owner\'s panel shows it (page: https://example.com/app shows "Fernleaf dashboard")')])).toBeNull();
    expect(runnerBlindRefusal([after("docker logs show no loop, or the owner names one, with a card raised for it")])).toBeNull();
  });

  it("does not refuse a criterion checked before merge, or an unobservable-free one", () => {
    expect(runnerBlindRefusal(["docker ps parsing is covered by the test"])).toBeNull();
    expect(runnerBlindRefusal([after("The live page shows the new heading")])).toBeNull();
  });

  it("lists every offending criterion", () => {
    const r = runnerBlindRefusal([after("journalctl is clean"), "fine", after("container logs show ready")]);
    expect(r).toContain("journalctl is clean");
    expect(r).toContain("container logs show ready");
  });
});
