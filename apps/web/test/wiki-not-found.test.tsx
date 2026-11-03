// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Wiki } from "../src/pages/Wiki";

const company: Company = { id: "8c7f803d-8266-4cae-b17b-79e289142018", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const pages = [{ id: "w1", slug: "runbooks/move-boss-man-to-a-new-host", folder: "runbooks", title: "Move Boss Man to a new host", ticketId: null, updatedAt: new Date().toISOString(), updatedBy: "Ada" }];

// A page detail for the one page that exists, and a 404 for any other slug.
const setup = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const detail = /\/wiki\/([^?]+)$/.exec(url);
      if (detail && !url.includes("/wiki-semantic") && !url.endsWith("/wiki")) {
        return detail[1] === "runbooks/move-boss-man-to-a-new-host"
          ? new Response(JSON.stringify({ id: "w1", slug: detail[1], folder: "runbooks", title: "Move Boss Man to a new host", body: "Steps.", updatedAt: new Date().toISOString(), updatedBy: "Ada", revisions: [], tickets: [] }), { status: 200 })
          : new Response(JSON.stringify({ message: "not found" }), { status: 404 });
      }
      if (url.includes("/wiki?q=")) return new Response(JSON.stringify(url.includes("nope") ? [] : pages), { status: 200 });
      if (url.includes("/wiki-semantic")) return new Response(JSON.stringify({ enabled: false, baseUrl: "", model: "", dims: 768, secretId: null }), { status: 200 });
      if (url.includes("/api/secrets")) return new Response("[]", { status: 200 });
      if (url.endsWith("/wiki")) return new Response(JSON.stringify(pages), { status: 200 });
      return new Response("[]", { status: 200 });
    }),
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a wiki link to a page (BOS-356)", () => {
  it("opens the page when the link carries the company's id in front, the way the chat now writes it", async () => {
    setup();
    const go = vi.fn();
    // The route has already stripped the company id; this is the slug that reaches Wiki.
    render(<Wiki companies={[company]} companyId={company.id} slug="runbooks/move-boss-man-to-a-new-host" go={go} />);
    expect(await screen.findByRole("heading", { name: "Move Boss Man to a new host" })).toBeTruthy();
  });

  it("says page not found with a search box when the slug doesn't exist, instead of an empty list", async () => {
    setup();
    render(<Wiki companies={[company]} companyId={company.id} slug="runbooks/no-such-page" go={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(screen.getByText(/runbooks\/no-such-page/)).toBeTruthy();
    const box = screen.getByLabelText("Search the wiki");
    fireEvent.change(box, { target: { value: "move" } });
    expect(await screen.findByRole("link", { name: "Move Boss Man to a new host" })).toBeTruthy();

    fireEvent.change(box, { target: { value: "nope" } });
    await waitFor(() => expect(screen.getByText(/No page matches/)).toBeTruthy());
  });
});
