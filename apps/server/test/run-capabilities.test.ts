import { describe, expect, it } from "vitest";
import { runCapabilities } from "../src/services/run-capabilities.js";

describe("runCapabilities (BOS-1300)", () => {
  const worker = { role: "worker", duty: null };
  it("gives an ordinary agent the same working set in chat as in a ticket run", () => {
    const chat = runCapabilities(worker, true);
    const run = runCapabilities(worker, false);
    expect(chat.boardToolsOnly).toBe(false);
    expect(chat.skillsAndToolServers).toBe(true);
    expect(chat.boardToolsOnly).toBe(run.boardToolsOnly);
    expect(chat.skillsAndToolServers).toBe(run.skillsAndToolServers);
    expect(chat.chatTools).toBe("worker");
  });
  it("keeps the CEO, Scrum Master and assistant chats narrow", () => {
    expect(runCapabilities({ role: "ceo", duty: null }, true)).toEqual({ boardToolsOnly: true, skillsAndToolServers: false, chatTools: "ceo" });
    expect(runCapabilities({ role: "worker", duty: "scrum_master" }, true)).toMatchObject({ boardToolsOnly: true, skillsAndToolServers: false, chatTools: "board" });
    expect(runCapabilities({ role: "worker", duty: "assistant" }, true).boardToolsOnly).toBe(true);
    expect(runCapabilities({ role: "worker", duty: "assistant" }, false).boardToolsOnly).toBe(true);
  });
  it("loads skills and tool servers in every non-chat run, whatever woke it", () => {
    for (const a of [worker, { role: "ceo", duty: null }, { role: "worker", duty: "scrum_master" }]) expect(runCapabilities(a, false).skillsAndToolServers).toBe(true);
  });
});
