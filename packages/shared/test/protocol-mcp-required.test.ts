import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ServerMessage } from "../src/protocol.js";

// BOS-552 adds run.start.mcpRequired. A rolling update runs old and new runners together, so an older
// runner (whose RunnerCommand schema predates the field) must still accept the message and run as before:
// zod objects strip unknown keys rather than reject them.
describe("run.start mcpRequired", () => {
  const command = {
    type: "command" as const,
    id: "c1",
    command: {
      type: "run.start" as const,
      runId: "00000000-0000-4000-8000-000000000001",
      agentId: "00000000-0000-4000-8000-000000000002",
      agentKind: "opencode",
      model: null,
      fundingSourceId: null,
      cwd: "/tmp",
      prompt: "hi",
      mcpToken: "t",
      mcpRequired: true,
    },
  };

  it("parses with the flag kept", () => {
    const msg = ServerMessage.parse(command);
    expect(msg.type).toBe("command");
    if (msg.type === "command") expect(msg.command.type === "run.start" && msg.command.mcpRequired).toBe(true);
  });

  it("still parses without the flag, so a server that doesn't send it works", () => {
    const { mcpRequired: _drop, ...rest } = command.command;
    const msg = ServerMessage.parse({ ...command, command: rest });
    if (msg.type === "command") expect(msg.command.type === "run.start" && msg.command.mcpRequired).toBeUndefined();
  });

  it("an older runner's schema strips the unknown flag instead of failing", () => {
    // The shape an older runner defined before this field existed: a plain zod object without mcpRequired.
    const OlderRunStart = z.object({ type: z.literal("run.start"), runId: z.string(), mcpToken: z.string() });
    const parsed = OlderRunStart.parse(command.command) as Record<string, unknown>;
    expect(parsed.type).toBe("run.start");
    expect(parsed.mcpToken).toBe("t");
    expect("mcpRequired" in parsed).toBe(false);
  });
});
