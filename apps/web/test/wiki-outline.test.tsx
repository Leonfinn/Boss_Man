// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// BOS-2443: a wiki page's "On this page" outline and each heading's "Copy link to this section".

const copyText = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("../src/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

import { Wiki } from "../src/pages/Wiki";
import { Markdown, headingId } from "../src/components/Markdown";
import { OUTLINE_MIN, readOutline, sectionHash, sectionLink } from "../src/wiki-outline";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const BODY = ["# Plan", "Intro.", "## Batch `27`: wiki", "Text.", "### Done so far", "More.", "## Batch 28", "## ✨", "End."].join("\n\n");

// jsdom has no scrollIntoView; the mock records which element it was called on.
const scrolled = vi.fn();
const scrolledTo = () => scrolled.mock.contexts as Element[];
beforeEach(() => {
  copyText.mockReset().mockResolvedValue(true);
  scrolled.mockReset();
  Element.prototype.scrollIntoView = scrolled;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function showWiki(body: string, slug = "plans/backlog", section = "") {
  const page = { id: "p1", slug, folder: "plans", title: "Backlog", body, updatedAt: new Date().toISOString(), updatedBy: "Brian", revisions: [], tickets: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.includes(`/wiki/${slug}`) ? json(page) : json([]))));
  window.history.replaceState(null, "", `#/wiki/c1/${slug}${section}`);
  render(<Wiki companies={[{ id: "c1", name: "App Co", agents: [] } as never]} companyId="c1" slug={`${slug}${section}`} go={() => {}} />);
}

describe("wiki-outline helpers", () => {
  it("reads the rendered headings with the ids the renderer gave them, skipping one with no id", () => {
    const { container } = render(<Markdown text={BODY} />);
    const outline = readOutline(container);
    expect(outline.map((e) => [e.level, e.text])).toEqual([
      [1, "Plan"],
      [2, "Batch 27: wiki"],
      [3, "Done so far"],
      [2, "Batch 28"],
    ]);
    // The ids are the elements' own, and headingId of the words gives the same one, so landing agrees.
    for (const e of outline) expect(container.querySelectorAll("h1, h2, h3, h4, h5, h6")[e.index]!.id).toBe(e.id);
    expect(outline[3]!.id).toBe(headingId("Batch 28"));
    // Words inside inline code count towards the id too.
    expect(outline[1]!.id).toBe("batch-27-wiki");
    expect(headingId(outline[1]!.id)).toBe(outline[1]!.id);
  });

  it("builds the section route and the full address to share", () => {
    expect(sectionHash("c1", "plans/backlog", "batch-28")).toBe("#/wiki/c1/plans/backlog#batch-28");
    expect(sectionLink("c1", "plans/backlog", "batch-28", { origin: "https://example.com", pathname: "/" })).toBe("https://example.com/#/wiki/c1/plans/backlog#batch-28");
  });

  it("a heading action adds no text to the heading", () => {
    const { container } = render(<Markdown text="## Batch 28" headingAction={(id) => <button aria-label={`copy ${id}`} />} />);
    expect(container.querySelector("h2")!.textContent).toBe("Batch 28");
    expect(screen.getByRole("button", { name: "copy batch-28" })).toBeTruthy();
  });
});

describe("On this page (BOS-2443)", () => {
  it("lists the headings indented by level; a click scrolls to that heading and puts its section in the address", async () => {
    showWiki(BODY);
    const fold = (await screen.findByText(/^On this page/)).closest("details")!;
    expect(fold.querySelector("summary")!.textContent).toBe("On this page (4)");
    const links = [...fold.querySelectorAll("a")];
    expect(links.map((a) => a.textContent)).toEqual(["Plan", "Batch 27: wiki", "Done so far", "Batch 28"]);
    expect(links.map((a) => (a.parentElement as HTMLElement).style.paddingLeft)).toEqual(["0px", "16px", "32px", "16px"]);
    expect(links[3]!.getAttribute("href")).toBe("#/wiki/c1/plans/backlog#batch-28");

    const target = document.getElementById("batch-28")!;
    fireEvent.click(links[3]!);
    expect(scrolledTo()).toEqual([target]);
    expect(window.location.hash).toBe("#/wiki/c1/plans/backlog#batch-28");
  });

  it(`is not shown on a page with fewer than ${OUTLINE_MIN} headings, but each heading still has its copy link`, async () => {
    showWiki("## One\n\n## Two\n\ntext");
    await screen.findByRole("button", { name: "Copy link to this section (Two)" });
    expect(screen.queryByText(/^On this page/)).toBeNull();
  });

  it("Copy link to this section copies the full address of that heading, which the landing code finds", async () => {
    showWiki(BODY);
    const btn = await screen.findByRole("button", { name: "Copy link to this section (Done so far)" });
    await act(async () => void fireEvent.click(btn));
    const link = `${window.location.origin}${window.location.pathname}#/wiki/c1/plans/backlog#done-so-far`;
    expect(copyText).toHaveBeenCalledWith(link);
    expect(screen.getAllByRole("status").map((s) => s.textContent)).toContain('Link to "Done so far" copied.');
    // The section in the copied link is the id of the heading it came from.
    expect(document.getElementById(link.split("#").pop()!)!.textContent).toBe("Done so far");
  });

  it("when copying fails, the address is shown beside the heading, selected, to copy by hand", async () => {
    copyText.mockResolvedValue(false);
    showWiki(BODY);
    const btn = await screen.findByRole("button", { name: "Copy link to this section (Batch 28)" });
    await act(async () => void fireEvent.click(btn));
    const field = screen.getByRole("textbox", { name: "Section address" }) as HTMLInputElement;
    expect(field.value).toBe(`${window.location.origin}${window.location.pathname}#/wiki/c1/plans/backlog#batch-28`);
    expect(document.activeElement).toBe(field);
    expect(field.closest("h2")!.id).toBe("batch-28");
  });

  it("a copied link to a heading with spaces and punctuation, opened fresh, lands on that heading", async () => {
    showWiki(BODY);
    const btn = await screen.findByRole("button", { name: "Copy link to this section (Batch 27: wiki)" });
    await act(async () => void fireEvent.click(btn));
    const link = copyText.mock.calls[0]![0];
    expect(link.endsWith("#/wiki/c1/plans/backlog#batch-27-wiki")).toBe(true);
    cleanup();
    scrolled.mockReset();
    // Open it as a new visit: the route after "#/wiki/c1/" is what App passes Wiki as its slug.
    showWiki(BODY, "plans/backlog", `#${link.split("#").pop()!}`);
    await screen.findByText(/^On this page/);
    expect(scrolledTo().map((h) => h.textContent)).toEqual(["Batch 27: wiki"]);
  });

  it("opening a section link lands on that heading", async () => {
    // The route carries slug#section; Wiki splits it into the page and the heading to land on.
    showWiki(BODY, "plans/backlog", "#done-so-far");
    await screen.findByText(/^On this page/);
    expect(scrolledTo()).toEqual([document.getElementById("done-so-far")]);
  });
});
