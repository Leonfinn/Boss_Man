import { describe, expect, it } from "vitest";
import { reachesPrivateNetwork } from "../src/policy.js";

// BOS-1421: reachesPrivateNetwork is row 1 of the permission table (the home-network guard, BOS-495).
// The guard's effect is covered through evaluatePermission in policy.test.ts; this file pins the
// function itself: which requests it looks at, and what counts as a private address.

const outsideTool = (url: string | null, title = "mcp__crawl4ai__md", kind = "other") => ({
  title,
  kind,
  rawInput: url === null ? {} : { url },
});

describe("reachesPrivateNetwork", () => {
  it("is true for a private URL passed to an outside tool server", () => {
    expect(reachesPrivateNetwork(outsideTool("http://192.168.1.50/"))).toBe(true);
  });

  it("is false for a public URL passed to the same outside tool server", () => {
    expect(reachesPrivateNetwork(outsideTool("https://example.com/page"))).toBe(false);
  });

  it("is false for Boss Man's own tools, even with a private URL", () => {
    expect(reachesPrivateNetwork(outsideTool("http://192.168.1.50/", "mcp__bossman__wiki_read"))).toBe(false);
  });

  it("is true for a fetch of a private URL", () => {
    expect(reachesPrivateNetwork({ title: "WebFetch", kind: "fetch", rawInput: { url: "http://192.168.1.50/" } })).toBe(true);
  });

  it("is false for a plain shell command that names a private URL", () => {
    expect(reachesPrivateNetwork({ title: "curl http://192.168.1.50/", kind: "execute", rawInput: { command: "curl http://192.168.1.50/" } })).toBe(false);
  });

  it("counts an unparseable URL on an outside tool as private", () => {
    expect(reachesPrivateNetwork(outsideTool("http://[not-a-host"))).toBe(true);
  });

  it("is false when the call carries no URL", () => {
    expect(reachesPrivateNetwork(outsideTool(null))).toBe(false);
  });
});
