// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Rules } from "../src/pages/Rules";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const rule = (id: string, name: string, commandPattern: string) => ({ id, companyId: "c1", name, match: { commandPattern }, outcome: "allow", position: 0 });
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("Rules Download CSV", () => {
  it("saves a header and only the rules the filter shows, in screen order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        if (u.startsWith("/api/policy-rules/usage")) return json({ rules: {} });
        if (u.startsWith("/api/policy-rules/most-asked")) return json({ cards: [] });
        return json({ company: [rule("r1", "Docker one", 'a,"b"'), rule("r2", "Other", "x"), rule("r3", "Docker two", "line\nbreak")], global: [], defaults: [] });
      }),
    );
    const saved: Blob[] = [];
    URL.createObjectURL = ((b: Blob) => (saved.push(b), "blob:x")) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
    fireEvent.change(await screen.findByLabelText("Filter rules"), { target: { value: "docker" } });
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const lines = (await saved[0]!.text()).split("\r\n");
    expect(lines).toHaveLength(4); // header, 2 rows, trailing empty
    expect(lines[1]).toBe('Docker one,"a,""b""",,allow,everyone,,,0,0,');
    expect(lines[2]).toBe('Docker two,"line\nbreak",,allow,everyone,,,0,0,');
  });
});
