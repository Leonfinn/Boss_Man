import { describe, expect, it } from "vitest";
import { normaliseUtilization, parseAcpUsageCost, parseClaudeRateLimit, parseCodexRateLimits, parseSyntheticQuota } from "../src/quota.js";
import { checkSecretFormat, findCredential, normaliseSecret, secretHint } from "../src/secrets.js";

// Built at run time so the file holds no key-shaped line for the secret scans (BOS-1932).
const PEM_BEGIN = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");

describe("parseClaudeRateLimit", () => {
  // Shape copied from spike S2's real run (claude-agent-acp 0.91.0, setup-token).
  const meta = {
    "_claude/rateLimit": {
      status: "rejected",
      resetsAt: 1792245600,
      rateLimitType: "seven_day",
      overageStatus: "allowed",
      overageResetsAt: 1793491200,
      isUsingOverage: true,
      overageInUse: true,
      unifiedWindows: {
        five_hour: { utilization: 0, resetsAt: 1792177800 },
        seven_day: { utilization: 1, resetsAt: 1792245600 },
      },
    },
    "_claude/model": "claude-sonnet-5-5",
  };

  it("reads both windows with reset times", () => {
    const samples = parseClaudeRateLimit(meta);
    expect(samples).toHaveLength(2);
    const week = samples.find((s) => s.window === "seven_day")!;
    expect(week.utilization).toBe(1);
    expect(week.resetsAt?.toISOString()).toBe("2026-10-17T14:00:00.000Z");
    expect(week.status).toBe("rejected");
    expect(week.overageInUse).toBe(true);
    const fiveHour = samples.find((s) => s.window === "five_hour")!;
    expect(fiveHour.status).toBeNull();
  });

  it("ignores updates without rate-limit data", () => {
    expect(parseClaudeRateLimit({ "_claude/model": "x" })).toEqual([]);
    expect(parseClaudeRateLimit(null)).toEqual([]);
  });
});

describe("normaliseUtilization", () => {
  it("keeps fractions and converts percentages", () => {
    expect(normaliseUtilization(0.42)).toBe(0.42);
    expect(normaliseUtilization(42)).toBe(0.42);
    expect(normaliseUtilization(250)).toBe(1);
    expect(normaliseUtilization(-1)).toBeNull();
    expect(normaliseUtilization("1")).toBeNull();
  });
});

describe("parseCodexRateLimits", () => {
  it("maps primary and secondary windows", () => {
    const samples = parseCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1792177800 },
        secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1792245600 },
      },
    });
    expect(samples.map((s) => [s.window, s.utilization])).toEqual([
      ["five_hour", 0.125],
      ["seven_day", 0.6],
    ]);
  });
});

describe("parseSyntheticQuota", () => {
  // The real /v2/quotas body captured on 31 Oct 2026 (BOS-260), key removed. The request window reads 0
  // while the plan was heavily used; the weekly credits are the measure it actually spends.
  const real = {
    subscription: { limit: 500, requests: 0, renewsAt: "2026-10-31T21:13:27.305Z" },
    search: { hourly: { limit: 250, requests: 0, renewsAt: "2026-10-31T17:13:27.306Z" } },
    planWeeklyLimit: { nextRegenAt: "2026-10-31T19:15:30.000Z", percentRemaining: 48.30020605714286, nextRegenPercent: 2 },
  };

  it("reads the weekly credits from the real response, beside the unused request window", () => {
    expect(parseSyntheticQuota(real)).toEqual({
      weekly: { percentRemaining: 48.30020605714286, nextRegenAt: new Date("2026-10-31T19:15:30.000Z"), nextRegenPercent: 2 },
      requests: { used: 0, limit: 500, renewsAt: new Date("2026-10-31T21:13:27.305Z") },
    });
  });

  it("keeps the request window when only that is sent, so older accounts still read", () => {
    const renewsAt = "2026-11-30T00:00:00.000Z";
    expect(parseSyntheticQuota({ subscription: { limit: 1000 }, requests: 123, renewsAt })).toEqual({
      weekly: null,
      requests: { used: 123, limit: 1000, renewsAt: new Date(renewsAt) },
    });
    expect(parseSyntheticQuota({ subscription: { limit: 50, requests: 7, renewsAt } })).toEqual({
      weekly: null,
      requests: { used: 7, limit: 50, renewsAt: new Date(renewsAt) },
    });
  });

  it("treats a response with nothing usable as unknown, never 0", () => {
    expect(parseSyntheticQuota(null)).toBeNull();
    expect(parseSyntheticQuota({})).toBeNull();
    expect(parseSyntheticQuota({ subscription: { limit: 0 }, requests: 1 })).toBeNull();
    expect(parseSyntheticQuota({ subscription: { limit: 10 }, requests: "3" })).toBeNull();
  });

  it("ignores a weekly block it can't trust, and a percent above 100 is not a percentage", () => {
    expect(parseSyntheticQuota({ planWeeklyLimit: { percentRemaining: "48" } })).toBeNull();
    expect(parseSyntheticQuota({ planWeeklyLimit: { percentRemaining: 140 } })).toBeNull();
    // A weekly block missing its regeneration time is still a usable percentage.
    expect(parseSyntheticQuota({ planWeeklyLimit: { percentRemaining: 0 } })?.weekly).toEqual({ percentRemaining: 0, nextRegenAt: null, nextRegenPercent: null });
  });
});

describe("parseAcpUsageCost", () => {
  it("reads the final usage_update of a turn", () => {
    const c = parseAcpUsageCost({
      used: 16480,
      size: 1000000,
      cost: { amount: 0.0332164, currency: "USD" },
      _meta: { "_claude/model": "claude-sonnet-5-5" },
      sessionUpdate: "usage_update",
    });
    expect(c).toEqual({ costMicros: 33216, currency: "USD", model: "claude-sonnet-5-5", contextUsed: 16480 });
  });
  it("returns null for updates without cost", () => {
    expect(parseAcpUsageCost({ used: 1, size: 2 })).toBeNull();
  });
});

describe("secrets", () => {
  it("strips every whitespace character from tokens", () => {
    const pasted = "sk-ant-oat01-abc\ndef  ghi\t";
    expect(normaliseSecret("claude_oauth_token", pasted)).toBe("sk-ant-oat01-abcdefghi");
  });
  it("keeps newlines inside SSH keys and ends with one", () => {
    const key = `${PEM_BEGIN}\r\nabc\r\n-----END OPENSSH PRIVATE KEY-----`;
    expect(normaliseSecret("ssh_private_key", key)).toBe(`${PEM_BEGIN}\nabc\n-----END OPENSSH PRIVATE KEY-----\n`);
  });
  it("flags wrong prefixes and quotes", () => {
    expect(checkSecretFormat("claude_oauth_token", "sk-ant-oat01-ok").ok).toBe(true);
    expect(checkSecretFormat("claude_oauth_token", "sk-ant-api03-x").problems[0]).toMatch(/sk-ant-oat01-/);
    expect(checkSecretFormat("anthropic_api_key", "'sk-ant-api03-x'").problems.some((p) => /quote/.test(p))).toBe(true);
    expect(checkSecretFormat("ssh_private_key", "not a key\n").ok).toBe(false);
  });
  it("shows at most the last four characters", () => {
    expect(secretHint("sk-ant-oat01-abcdefgh1234")).toBe("••••1234");
    expect(secretHint("short")).toBe("••••");
  });
});

describe("findCredential", () => {
  it("spots common secret shapes", () => {
    expect(findCredential("token sk-ant-oat01-abcdefghijklmnop")).toBe("an Anthropic key or token");
    expect(findCredential("use ghp_0123456789abcdefghijABCDEFGHIJ")).toBe("a GitHub token");
    expect(findCredential(PEM_BEGIN)).toBe("a private key");
    expect(findCredential("postgres://app:hunter2@db:5432/app")).toBe("a password in a URL");
    expect(findCredential("AKIAIOSFODNN7EXAMPLE")).toBe("an AWS access key");
  });
  it("lets ordinary deliverables through", () => {
    expect(findCredential("Deployed v1.4 (git tag v1.4.0, commit 7d2d5cb). Health check: https://app.lan/healthz")).toBeNull();
    expect(findCredential("Set APP_TOKEN from the grant named app-deploy; the value is in the secrets store.")).toBeNull();
  });
});
