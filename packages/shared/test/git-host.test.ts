import { describe, expect, it } from "vitest";
import { apiBaseFor, isLanHost, parseRepoUrl, repoUrlAllowed } from "../src/git-host.js";

describe("isLanHost", () => {
  it("is true for private IPv4 addresses, localhost and .local/.lan names", () => {
    expect(isLanHost("192.168.1.50")).toBe(true);
    expect(isLanHost("10.0.0.5")).toBe(true);
    expect(isLanHost("localhost")).toBe(true);
    expect(isLanHost("nas.local")).toBe(true);
    expect(isLanHost("gitea.lan")).toBe(true);
  });

  it("ignores case and a trailing dot", () => {
    expect(isLanHost("LOCALHOST")).toBe(true);
    expect(isLanHost("NAS.LOCAL")).toBe(true);
    expect(isLanHost("GITEA.LAN.")).toBe(true);
    expect(isLanHost("192.168.1.50.")).toBe(true);
  });

  it("is false for a public name or a public address", () => {
    expect(isLanHost("example.com")).toBe(false);
    expect(isLanHost("203.0.113.7")).toBe(false);
    expect(isLanHost("172.32.0.1")).toBe(false);
  });
});

describe("repo addresses (R59)", () => {
  it("allows plain http only to a LAN host", () => {
    expect(repoUrlAllowed("http://192.168.1.50:3003/leon/site.git")).toBe(true);
    expect(repoUrlAllowed("http://10.0.0.5/leon/site")).toBe(true);
    expect(repoUrlAllowed("http://172.20.1.1/a/b")).toBe(true);
    expect(repoUrlAllowed("http://gitea.lan/a/b")).toBe(true);
    expect(repoUrlAllowed("http://nas.local:3000/a/b")).toBe(true);
    expect(repoUrlAllowed("http://172.32.0.1/a/b")).toBe(false);
    expect(repoUrlAllowed("http://192.168.example.com/a/b")).toBe(false);
    expect(repoUrlAllowed("http://github.com/a/b")).toBe(false);
    expect(repoUrlAllowed("https://github.com/a/b")).toBe(true);
    expect(repoUrlAllowed("git@github.com:a/b.git")).toBe(true);
    expect(repoUrlAllowed("ftp://x/a/b")).toBe(false);
  });

  it("finds the host, owner and repo", () => {
    expect(parseRepoUrl("https://github.com/Leonfinn/Boss_Man.git")).toEqual({ kind: "github", origin: "https://github.com", owner: "Leonfinn", repo: "Boss_Man" });
    expect(parseRepoUrl("git@github.com:Leonfinn/Boss_Man.git")).toEqual({ kind: "github", origin: "https://github.com", owner: "Leonfinn", repo: "Boss_Man" });
    expect(parseRepoUrl("http://192.168.1.50:3003/leon/site.git")).toEqual({ kind: null, origin: "http://192.168.1.50:3003", owner: "leon", repo: "site" });
    expect(parseRepoUrl("https://example.com/git/leon/site")).toEqual({ kind: null, origin: "https://example.com/git", owner: "leon", repo: "site" });
    expect(parseRepoUrl("ssh://git@192.168.1.50:2222/leon/site.git")).toEqual({ kind: null, origin: "https://192.168.1.50", owner: "leon", repo: "site" });
    expect(parseRepoUrl("/srv/repos/site")).toBeNull();
    expect(parseRepoUrl("https://github.com/only-owner")).toBeNull();
    expect(apiBaseFor("gitea", "http://192.168.1.50:3003")).toBe("http://192.168.1.50:3003/api/v1");
    expect(apiBaseFor("github", "https://github.com")).toBe("https://api.github.com");
  });
});
