import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { describeFetchError } from "../src/services/notifications.js";

// BOS-1290: Node's fetch throws "fetch failed" and keeps the reason on `cause`. The add-on state shows pushError,
// so the reason must be in the message.
describe("describeFetchError", () => {
  it("names the cause code and the host of a refused connection, from a real fetch", async () => {
    // Take a free port, then close it, so nothing answers there.
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const url = `http://127.0.0.1:${port}/some/path?x=1`;
    const err = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then(() => null, (e: unknown) => e);
    expect((err as Error).message).toBe("fetch failed");
    const text = describeFetchError(err, url);
    expect(text).toContain("ECONNREFUSED");
    expect(text).toContain(`127.0.0.1:${port}`);
    // Only the host: no path, query or token.
    expect(text).not.toContain("some/path");
    expect(text).not.toContain("x=1");
  });

  it("names a name that does not resolve", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND ntfy"), { code: "ENOTFOUND" });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    expect(describeFetchError(err, new URL("http://ntfy:80/"))).toBe("fetch failed to ntfy (ENOTFOUND: getaddrinfo ENOTFOUND ntfy)");
  });

  it("reads the codes of an AggregateError (every address tried)", () => {
    const cause = Object.assign(new Error(""), { errors: [{ code: "ENETUNREACH" }, { code: "ECONNREFUSED" }] });
    const err = Object.assign(new TypeError("fetch failed"), { cause });
    expect(describeFetchError(err, "https://ntfy.example.ts.net:8443/")).toBe("fetch failed to ntfy.example.ts.net:8443 (ENETUNREACH: ECONNREFUSED)");
  });

  it("says a timeout is a timeout", () => {
    const err = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    expect(describeFetchError(err, "http://ntfy:80/")).toBe("ntfy request to ntfy (timed out after 10 s)");
  });
});
