import { afterEach, describe, expect, it, vi } from "vitest";
import {
  away,
  isUnavailable,
  reportAnswered,
  reportFailure,
  reportSlow,
  resetServerWatch,
  serverDown,
  subscribeServer,
} from "../src/server-watch";

// BOS-637: a server that is restarting, unreachable or stalled shows one small banner over the page. These
// tests pin which failures count as "away", the stall threshold, and how listeners hear about the change.

afterEach(() => {
  resetServerWatch();
});

describe("isUnavailable: failures that mean the server was away", () => {
  it("treats a request that never reached the server (status 0) as unavailable", () => {
    expect(isUnavailable({ status: 0 })).toBe(true);
  });

  it("treats the front door's restarting statuses as unavailable", () => {
    expect(isUnavailable({ status: 502 })).toBe(true);
    expect(isUnavailable({ status: 503 })).toBe(true);
    expect(isUnavailable({ status: 504 })).toBe(true);
  });

  it("leaves a real answer from the server out of the banner, whatever its status", () => {
    expect(isUnavailable({ status: 200 })).toBe(false);
    expect(isUnavailable({ status: 404 })).toBe(false);
    expect(isUnavailable({ status: 500 })).toBe(false);
    expect(isUnavailable({ status: 501 })).toBe(false);
    expect(isUnavailable({ status: 505 })).toBe(false);
  });

  it("ignores a status that is not a number", () => {
    expect(isUnavailable({ status: "503" })).toBe(false);
    expect(isUnavailable({ status: NaN })).toBe(false);
  });

  it("copes with null, undefined and values that are not objects", () => {
    expect(isUnavailable(null)).toBe(false);
    expect(isUnavailable(undefined)).toBe(false);
    expect(isUnavailable("503")).toBe(false);
    expect(isUnavailable(503)).toBe(false);
    expect(isUnavailable(new Error("fetch failed"))).toBe(false);
  });
});

describe("away: a screen with nothing to show yet keeps its place", () => {
  it("is true exactly when the failure is an unavailable server", () => {
    expect(away({ status: 0 })).toBe(true);
    expect(away({ status: 503 })).toBe(true);
    expect(away({ status: 404 })).toBe(false);
    expect(away(null)).toBe(false);
  });
});

describe("reportSlow: a stall is the outage too", () => {
  it("starts out with the server marked as here", () => {
    expect(serverDown()).toBe(false);
  });

  it("leaves the banner down for an answer just under the stall threshold", () => {
    reportSlow(9_999);
    expect(serverDown()).toBe(false);
  });

  it("raises the banner for an answer at the stall threshold", () => {
    reportSlow(10_000);
    expect(serverDown()).toBe(true);
  });

  it("raises the banner for an answer past the stall threshold", () => {
    reportSlow(60_000);
    expect(serverDown()).toBe(true);
  });

  it("takes the banner down when a later answer comes back quickly", () => {
    reportSlow(10_000);
    expect(serverDown()).toBe(true);
    reportAnswered();
    expect(serverDown()).toBe(false);
  });
});

describe("serverDown: one flag for the banner", () => {
  it("goes up for an unreachable server and stays up for a refused click", () => {
    reportFailure({ status: 0 });
    expect(serverDown()).toBe(true);
    reportFailure({ status: 404 });
    expect(serverDown()).toBe(true);
  });

  it("stays down for a refused click while the server is here", () => {
    reportFailure({ status: 404 });
    reportFailure({ status: 500 });
    expect(serverDown()).toBe(false);
  });

  it("goes back down on any answered request", () => {
    reportFailure({ status: 503 });
    expect(serverDown()).toBe(true);
    reportAnswered();
    expect(serverDown()).toBe(false);
  });
});

describe("subscribeServer: screens hear about the change once per transition", () => {
  it("tells every listener when the banner goes up and when it comes down", () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = subscribeServer(first);
    const offSecond = subscribeServer(second);

    reportFailure({ status: 503 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    reportAnswered();
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);

    offFirst();
    offSecond();
  });

  it("announces a second failure while already down only once", () => {
    const listener = vi.fn();
    const off = subscribeServer(listener);

    reportFailure({ status: 503 });
    reportFailure({ status: 504 });
    reportSlow(20_000);
    expect(listener).toHaveBeenCalledTimes(1);

    off();
  });

  it("stops calling a listener once it has unsubscribed", () => {
    const listener = vi.fn();
    const off = subscribeServer(listener);
    off();

    reportFailure({ status: 503 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not call a listener when a single request is answered while the server was never away", () => {
    const listener = vi.fn();
    const off = subscribeServer(listener);

    reportAnswered();
    expect(listener).not.toHaveBeenCalled();

    off();
  });
});

describe("resetServerWatch: back to 'the server is here'", () => {
  it("clears an outage", () => {
    reportSlow(10_000);
    expect(serverDown()).toBe(true);
    resetServerWatch();
    expect(serverDown()).toBe(false);
  });

  it("is harmless when the server was already marked as here", () => {
    const listener = vi.fn();
    const off = subscribeServer(listener);

    resetServerWatch();
    expect(serverDown()).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    off();
  });
});
