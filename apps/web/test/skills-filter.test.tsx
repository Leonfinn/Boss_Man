// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Skills } from "../src/pages/Skills";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const mk = (id: string, name: string, description: string, pack: string | null = null) => ({ id, name, description, source: "written", sourceUrl: null, sourceRef: null, pack, packUrl: null, sizeBytes: 100, fileCount: 1, updatedAt: "2026-10-21T14:26:00Z", agents: [] });
const rows = [mk("a", "web-fetch", "Fetch pages."), mk("b", "pdf-read", "Read PDF files.", "docs"), mk("c", "docx-write", "Write Word files.", "docs"), mk("d", "chart", "Draw plots.", "viz")];

describe("skills filter", () => {
  it("narrows by name or description, packs by name or skill, and says when nothing matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/skills") ? json(rows) : json([]))));
    render(<Skills company={company} />);
    const box = (await screen.findByLabelText("Filter")) as HTMLInputElement;
    await screen.findByText("web-fetch", { selector: "a span" });

    fireEvent.change(box, { target: { value: "FETCH" } });
    expect(screen.queryByText("pdf-read", { selector: "a span" })).toBeNull();
    expect(screen.getByText("web-fetch", { selector: "a span" })).toBeTruthy();
    expect(screen.queryByText("docs")).toBeNull();

    fireEvent.change(box, { target: { value: "pdf files" } });
    expect(screen.getByText("pdf-read", { selector: "a span" })).toBeTruthy();
    expect(screen.queryByText("docx-write", { selector: "a span" })).toBeNull();
    expect(screen.getByText("(1)")).toBeTruthy();

    fireEvent.change(box, { target: { value: "docs" } });
    expect(screen.getByText("docx-write", { selector: "a span" })).toBeTruthy();
    expect(screen.getByText("(2)")).toBeTruthy();

    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("No skills match.")).toBeTruthy();
  });
});
