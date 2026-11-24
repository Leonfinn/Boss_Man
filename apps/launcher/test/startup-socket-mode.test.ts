// BOS-2363 (background lane): the launcher's copy of the socket group check. It is pure: given the
// socket path and its stat mode it either says nothing or returns the plain-words problem.
// No host paths here: /var/run/docker.sock and /s are the usual, made-up-looking examples.
import { describe, expect, it } from "vitest";
import { socketModeProblem } from "../src/startup.js";

describe("socketModeProblem (BOS-2363)", () => {
  it("says nothing when the mode is unknown, since there is nothing to judge", () => {
    expect(socketModeProblem("/var/run/docker.sock", {})).toBeNull();
  });

  it("says nothing when the socket's group can read and write it", () => {
    expect(socketModeProblem("/var/run/docker.sock", { mode: 0o660 })).toBeNull();
    expect(socketModeProblem("/var/run/docker.sock", { mode: 0o666 })).toBeNull();
  });

  it("names the socket and its mode when the group cannot read and write it", () => {
    const problem = socketModeProblem("/var/run/docker.sock", { mode: 0o640 });
    expect(problem).toBe(
      "The Docker socket (/var/run/docker.sock) is not read-write for its group (mode 640), so the launcher cannot use it as a non-root user. Allow the socket's group to read and write it.",
    );
  });

  it("reports a group that can read but not write, or write but not read", () => {
    expect(socketModeProblem("/s", { mode: 0o640 })).not.toBeNull();
    expect(socketModeProblem("/s", { mode: 0o620 })).not.toBeNull();
    expect(socketModeProblem("/s", { mode: 0o600 })).not.toBeNull();
  });

  it("masks the stat mode to its permission bits in the message", () => {
    // statSync's mode includes the file type (0o140000 for a socket); only the permission bits are printed.
    expect(socketModeProblem("/s", { mode: 0o140640 })).toContain("(mode 640)");
  });
});
