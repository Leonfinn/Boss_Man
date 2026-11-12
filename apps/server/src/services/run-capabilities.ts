// BOS-1300: the one table that says what a run may have, so the scheduler (what is sent to the runner), the MCP server choice
// (which Boss Man tools) and the chat prompt (what the agent is told it has) cannot drift apart.
// Order matters: the first matching row wins.
//   1. A personal assistant stays read-only, whatever woke it.
//   2. The Scrum Master keeps its restricted set, in chat too (BOS-58).
//   3. The CEO's chat has the board plus its run tools, but no shell, files, skills or tool servers.
//   4. Every other agent, in a ticket run or in the owner chat, has its full working set.

export const SCRUM_MASTER = "scrum_master";

export type Capabilities = {
  /** Claude's own file and shell tools (and OpenCode's edit/bash) are off. */
  boardToolsOnly: boolean;
  /** The agent's skills and the company's tool servers go with the run. */
  skillsAndToolServers: boolean;
  /** Which Boss Man tools a chat run registers: the board only, the CEO's run tools, or the worker's own-ticket tools. */
  chatTools: "board" | "ceo" | "worker";
};

export function runCapabilities(agent: { role: string; duty: string | null }, chat: boolean): Capabilities {
  if (agent.duty === "assistant") return { boardToolsOnly: true, skillsAndToolServers: !chat, chatTools: "board" };
  if (!chat) return { boardToolsOnly: false, skillsAndToolServers: true, chatTools: "board" };
  if (agent.duty === SCRUM_MASTER) return { boardToolsOnly: true, skillsAndToolServers: false, chatTools: "board" };
  if (agent.role === "ceo") return { boardToolsOnly: true, skillsAndToolServers: false, chatTools: "ceo" };
  return { boardToolsOnly: false, skillsAndToolServers: true, chatTools: "worker" };
}
