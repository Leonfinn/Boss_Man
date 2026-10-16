import { describe, expect, it } from "vitest";
import { normaliseUtilization, parseAcpUsageCost, parseClaudeRateLimit, parseCodexRateLimits } from "../src/quota.js";
import { checkSecretFormat, normaliseSecret, secretHint } from "../src/secrets.js";

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
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\r\nabc\r\n-----END OPENSSH PRIVATE KEY-----";
    expect(normaliseSecret("ssh_private_key", key)).toBe("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n");
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
