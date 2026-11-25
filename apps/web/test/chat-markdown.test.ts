import { describe, expect, it } from "vitest";
import { chatMarkdown } from "../src/pages/Chat";

// BOS-2514: the whole conversation as Markdown (BOS-2313), tested as a pure call.
type Message = { id: string; role: "owner" | "assistant" | "system"; text: string; createdAt: string };
const msg = (id: string, role: Message["role"], text: string, createdAt: string): Message => ({ id, role, text, createdAt });

describe("chatMarkdown (BOS-2514)", () => {
  it("starts with the agent and the day", () => {
    expect(chatMarkdown("Rada Gast", "2026-11-23", [])).toBe("# Chat with Rada Gast, 2026-11-23\n\n");
  });

  it("names the owner as You, a system message as System and an agent message by name", () => {
    const items = [
      msg("m1", "owner", "Hello", "2026-11-23T09:15:00.000Z"),
      msg("m2", "system", "The runner restarted", "2026-11-23T09:16:00.000Z"),
      msg("m3", "assistant", "All done", "2026-11-23T09:17:00.000Z"),
    ];
    const text = chatMarkdown("Rada Gast", "2026-11-23", items);
    expect(text).toContain("**You** · 2026-11-23 09:15 UTC\n\nHello\n");
    expect(text).toContain("**System** · 2026-11-23 09:16 UTC\n\nThe runner restarted\n");
    expect(text).toContain("**Rada Gast** · 2026-11-23 09:17 UTC\n\nAll done\n");
  });

  it("shows each time in UTC to the minute, oldest first", () => {
    const items = [
      msg("m1", "owner", "first", "2026-11-23T08:05:42.123Z"),
      msg("m2", "assistant", "second", "2026-11-23T23:59:00.000Z"),
    ];
    const text = chatMarkdown("Rada Gast", "2026-11-23", items);
    expect(text).toContain("**You** · 2026-11-23 08:05 UTC");
    expect(text).toContain("**Rada Gast** · 2026-11-23 23:59 UTC");
    expect(text.indexOf("first")).toBeLessThan(text.indexOf("second"));
    expect(text).not.toContain("42.123");
  });

  it("puts one blank line between messages in a row", () => {
    const items = [
      msg("m1", "owner", "one", "2026-11-23T10:00:00.000Z"),
      msg("m2", "owner", "two", "2026-11-23T10:01:00.000Z"),
      msg("m3", "owner", "three", "2026-11-23T10:02:00.000Z"),
    ];
    expect(chatMarkdown("Rada Gast", "2026-11-23", items)).toBe(
      "# Chat with Rada Gast, 2026-11-23\n\n" +
        "**You** · 2026-11-23 10:00 UTC\n\none\n" +
        "\n" +
        "**You** · 2026-11-23 10:01 UTC\n\ntwo\n" +
        "\n" +
        "**You** · 2026-11-23 10:02 UTC\n\nthree\n",
    );
  });

  it("keeps an empty message in place without failing", () => {
    const items = [msg("m1", "owner", "", "2026-11-23T10:00:00.000Z")];
    expect(chatMarkdown("Rada Gast", "2026-11-23", items)).toBe(
      "# Chat with Rada Gast, 2026-11-23\n\n**You** · 2026-11-23 10:00 UTC\n\n\n",
    );
  });

  it("passes Markdown the owner already wrote through unchanged", () => {
    const body = "## Plan\n\n- one\n- two\n\n```js\nconst a = 1;\n```";
    const text = chatMarkdown("Rada Gast", "2026-11-23", [msg("m1", "owner", body, "2026-11-23T10:00:00.000Z")]);
    expect(text).toContain(`**You** · 2026-11-23 10:00 UTC\n\n${body}\n`);
    expect(text).toContain("## Plan");
    expect(text).toContain("```js\nconst a = 1;\n```");
  });

  it("keeps line breaks inside a message", () => {
    const text = chatMarkdown("Rada Gast", "2026-11-23", [msg("m1", "assistant", "line one\nline two", "2026-11-23T10:00:00.000Z")]);
    expect(text).toContain("**Rada Gast** · 2026-11-23 10:00 UTC\n\nline one\nline two\n");
  });
});
