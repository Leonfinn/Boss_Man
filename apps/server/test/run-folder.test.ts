import { describe, expect, it } from "vitest";
import { runFolder } from "../src/services/run-folder.js";

// BOS-1145: the folder a run opens in (BOS-1120). A ticket run opens in that ticket's checkout,
// a reply run in its own reply folder, and a run with no ticket in a clean per-agent folder
// under "agents", never the bare "<root>/<agentId>" that on older runners held a stale ticket.

const root = "/ws";
const agent = "agent-1";
const ticket = "ticket-1";

describe("runFolder", () => {
  describe("with a ticket", () => {
    it("opens in the ticket's checkout", () => {
      expect(runFolder(root, agent, { ticketId: ticket })).toBe("/ws/ticket-1");
    });

    it("ignores a reply flag that is explicitly off", () => {
      expect(runFolder(root, agent, { ticketId: ticket, reply: false })).toBe("/ws/ticket-1");
    });
  });

  describe("a reply run", () => {
    it("opens in its own reply folder", () => {
      expect(runFolder(root, agent, { reply: true })).toBe("/ws/reply/agent-1");
    });

    it("wins over a ticket id, so a reply run never opens in the ticket's checkout", () => {
      expect(runFolder(root, agent, { ticketId: ticket, reply: true })).toBe("/ws/reply/agent-1");
    });
  });

  describe("with no ticket", () => {
    it.each([
      ["undefined", undefined],
      ["null", null],
      ["an empty string", ""],
    ])("opens in the per-agent agents folder when the ticket is %s", (_label, ticketId) => {
      expect(runFolder(root, agent, { ticketId })).toBe("/ws/agents/agent-1");
    });

    it("never opens in the bare root/agent folder", () => {
      expect(runFolder(root, agent, { ticketId: "" })).not.toBe("/ws/agent-1");
    });

    it("opens in the per-agent agents folder when no options are given", () => {
      expect(runFolder(root, agent, {})).toBe("/ws/agents/agent-1");
    });
  });

  describe("path shape", () => {
    it("uses forward slashes", () => {
      expect(runFolder(root, agent, { ticketId: ticket })).toBe("/ws/ticket-1");
    });

    it("gives no double slash when the root has a trailing slash", () => {
      expect(runFolder(root + "/", agent, { ticketId: ticket })).toBe("/ws/ticket-1");
      expect(runFolder(root + "/", agent, { reply: true })).toBe("/ws/reply/agent-1");
      expect(runFolder(root + "/", agent, {})).toBe("/ws/agents/agent-1");
      expect(runFolder(root + "/", agent, { ticketId: ticket })).not.toContain("//");
    });

    it("keeps a nested root intact", () => {
      expect(runFolder("/home/agent/workspaces", agent, { ticketId: ticket })).toBe("/home/agent/workspaces/ticket-1");
    });
  });
});
