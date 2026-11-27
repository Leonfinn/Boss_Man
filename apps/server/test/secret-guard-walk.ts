import { expect } from "vitest";
import { secretRefusal, skipsSecretCheck } from "../src/mcp-secret-guard.js";

// Helper for the tests that list a live server's tools (BOS-2760). Built at run time so no file holds a key-shaped value.
const key = ["sk", "ant", "api03"].join("-") + "-aB3dE5gH7jK9mN1pQ3sT5vX7zC2fG4hJ6kL8";

/** Tools that only read: the only ones the secret check may skip whole. A tool that writes text must never be added here. */
const NAMED_READ_ONLY: ReadonlySet<string> = new Set([
  "agent_instructions", "board", "devices", "features", "list_my_work", "model_options", "open_attachment", "owner_answers",
  "server_status", "sizing_guide", "tickets", "whats_new", "permission_report", "merge_line_records", "workflow_scorecard",
]);

/**
 * Walks a server's tool names: every tool the check skips whole must be on the named read-only list, and every other tool
 * (even with an action nobody has listed) must refuse a key in its text. So a writing tool added later fails here until it is guarded.
 */
export function expectEveryWriterGuarded(names: string[]): void {
  for (const name of names) {
    if (skipsSecretCheck(name)) expect(NAMED_READ_ONLY.has(name), `${name} skips the secret check but is not a named read-only tool`).toBe(true);
    else expect(secretRefusal(name, { action: "an_action_nobody_listed", text: key, message: key }), `${name} is not guarded`).toContain("anthropic-key");
  }
}
