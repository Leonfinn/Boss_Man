// BOS-1673 (background lane): the pure checks behind Settings → Tools → Penpot.
// penpotUrlProblem decides whether the address the owner typed can be saved and opened by the network guard,
// and PENPOT_ENV is the four grant names agents and skills/penpot read. Neither touches the database, the
// network or the clock.
import { describe, expect, it } from "vitest";
import { PENPOT_ENV, penpotUrlProblem } from "../src/routes/penpot.js";

const BAD_URL = "Use Penpot's full address, like http://192.168.1.50:9001.";
const BAD_PROTOCOL = "Use an http:// or https:// address.";
const BAD_LOGIN = "Leave the login out of the address: put the access token in its own field.";
const BAD_GUARD = "The network guard can't open that address. Use a host name or IPv4 address (not one of Boss Man's own services) with an optional port.";

describe("PENPOT_ENV", () => {
  it("keeps the four grant names the runner and skills read", () => {
    expect(PENPOT_ENV).toEqual({
      url: "PENPOT_URL",
      token: "PENPOT_TOKEN",
      email: "PENPOT_EMAIL",
      password: "PENPOT_PASSWORD",
    });
  });
});

describe("penpotUrlProblem", () => {
  it("accepts a LAN address with a port", () => {
    expect(penpotUrlProblem("http://192.168.1.50:9001")).toBeNull();
  });

  it("accepts an https address and fills in the default port by itself", () => {
    expect(penpotUrlProblem("https://penpot.example.com")).toBeNull();
    expect(penpotUrlProblem("http://penpot.example.com")).toBeNull();
  });

  it("ignores the path, query and fragment after the address", () => {
    expect(penpotUrlProblem("https://penpot.example.com:8443/workspace?file=one#page")).toBeNull();
  });

  it("reads the scheme and host in any case", () => {
    expect(penpotUrlProblem("HTTPS://Penpot.Example.COM:8443")).toBeNull();
  });

  it("rejects text that is not an address", () => {
    expect(penpotUrlProblem("")).toBe(BAD_URL);
    expect(penpotUrlProblem("not an address")).toBe(BAD_URL);
  });

  it("rejects a port the URL parser refuses", () => {
    expect(penpotUrlProblem("http://penpot.example.com:99999")).toBe(BAD_URL);
  });

  it("rejects a scheme other than http or https", () => {
    expect(penpotUrlProblem("ftp://penpot.example.com:9001")).toBe(BAD_PROTOCOL);
    expect(penpotUrlProblem("mailto:designer@example.com")).toBe(BAD_PROTOCOL);
    // Without "//" the URL parser reads "penpot.example.com:" as the scheme.
    expect(penpotUrlProblem("penpot.example.com:9001")).toBe(BAD_PROTOCOL);
  });

  it("rejects an address with a login in it", () => {
    expect(penpotUrlProblem("http://owner:secret@192.168.1.50:9001")).toBe(BAD_LOGIN);
    expect(penpotUrlProblem("http://owner@penpot.example.com")).toBe(BAD_LOGIN);
  });

  it("rejects Boss Man's own service names", () => {
    for (const host of ["db", "server", "launcher", "netguard", "ntfy", "postgres", "runner-abc"]) {
      expect(penpotUrlProblem(`http://${host}:9001`)).toBe(BAD_GUARD);
    }
  });

  it("rejects a service name with a trailing dot that resolves to the same host", () => {
    expect(penpotUrlProblem("http://db.")).toBe(BAD_GUARD);
  });

  it("rejects an IPv6 literal the launcher cannot allow", () => {
    expect(penpotUrlProblem("http://[::1]:9001")).toBe(BAD_GUARD);
    expect(penpotUrlProblem("http://[2001:db8::1]:9001")).toBe(BAD_GUARD);
  });

  it("rejects a host name ending in a dot and port zero", () => {
    expect(penpotUrlProblem("http://penpot.example.com.:9001")).toBe(BAD_GUARD);
    expect(penpotUrlProblem("http://penpot.example.com:0")).toBe(BAD_GUARD);
  });
});
