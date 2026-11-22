// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Wiki } from "../src/pages/Wiki";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const BODY = "# Spec\n\n![shot](/api/ticket-images/abc)\n\n- one\n";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(slug: string) {
  const page = { id: "p1", slug, folder: "eng", title: "Spec", body: BODY, updatedAt: new Date().toISOString(), updatedBy: "Brian", revisions: [], tickets: [] };
  vi.stubGlobal("fetch", vi.fn((url: string) => Promise.resolve(url.includes(`/wiki/${slug}`) ? json(page) : json([]))));
  const blobs: Blob[] = [];
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => (blobs.push(b), "blob:x");
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  const names: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    names.push(this.download);
  });
  render(<Wiki companies={[{ id: "c1", name: "App Co", agents: [] } as never]} companyId="c1" slug={slug} go={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Download" }));
  return { blobs, names };
}

describe("wiki page download (BOS-2252)", () => {
  it("saves the stored Markdown as text/markdown", async () => {
    const { blobs } = await open("spec");
    expect(blobs).toHaveLength(1);
    expect(blobs[0]!.type).toMatch(/^text\/markdown/);
    expect(await blobs[0]!.text()).toBe(BODY);
  });

  it("names the file after the slug, slashes as dashes, ending .md", async () => {
    const { names } = await open("eng/release-notes");
    expect(names).toEqual(["eng-release-notes.md"]);
  });
});
