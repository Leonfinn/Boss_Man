import { describe, expect, it } from "vitest";
import { DEFAULT_NOTIFY_SETTINGS, urgentPushOf, wantsEveryPush } from "../src/services/notifications.js";

describe("urgentPushOf", () => {
  it("reads null when a card has no context", () => {
    expect(urgentPushOf(null)).toBeNull();
    expect(urgentPushOf(undefined)).toBeNull();
  });

  it("reads null when the context is not a stored object", () => {
    expect(urgentPushOf("urgentPush")).toBeNull();
  });

  it("reads null when the context holds no urgent mark", () => {
    expect(urgentPushOf({})).toBeNull();
    expect(urgentPushOf({ urgentPush: null })).toBeNull();
  });

  it("reads the CEO's urgent mark", () => {
    const mark = { by: "ceo-1", at: "2026-11-12T02:15:00.000Z", why: "server is down" };
    expect(urgentPushOf({ urgentPush: mark })).toEqual(mark);
  });

  it("reads null when the reason is not a string", () => {
    expect(urgentPushOf({ urgentPush: { by: "ceo-1", at: "2026-11-12T02:15:00.000Z", why: 5 } })).toBeNull();
  });

  it("reads null when the reason is missing", () => {
    expect(urgentPushOf({ urgentPush: { by: "ceo-1", at: "2026-11-12T02:15:00.000Z" } })).toBeNull();
  });

  it("does not care about other context keys", () => {
    const mark = { by: "ceo-1", at: "2026-11-12T02:15:00.000Z", why: "server is down" };
    expect(urgentPushOf({ type: "stalled_run", runId: "run-1", urgentPush: mark })).toEqual(mark);
    expect(urgentPushOf({ type: "stalled_run", runId: "run-1" })).toBeNull();
  });
});

describe("wantsEveryPush", () => {
  it("wants every push only when the owner chose all", () => {
    expect(wantsEveryPush({ ...DEFAULT_NOTIFY_SETTINGS, phonePush: "all" })).toBe(true);
  });

  it("does not want every push when the owner chose urgent only", () => {
    expect(wantsEveryPush({ ...DEFAULT_NOTIFY_SETTINGS, phonePush: "urgent" })).toBe(false);
  });

  it("treats the default settings as urgent only", () => {
    expect(wantsEveryPush(DEFAULT_NOTIFY_SETTINGS)).toBe(false);
  });
});
