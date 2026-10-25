// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { linked } from "../src/pages/Chat";
import { TicketOutputs, type Artifact } from "../src/components/TicketOutputs";

afterEach(cleanup);

describe("links to wiki pages from a ticket", () => {
  it("turns [[slug]] in an agent's message into a link to the company's wiki page", () => {
    render(<p>{linked("The full list is on [[backlog-review]], see [[backlog-review#Top 10]].", "c1")}</p>);
    expect(screen.getByRole("link", { name: "backlog-review" }).getAttribute("href")).toBe("#/wiki/c1/backlog-review");
    expect(screen.getByRole("link", { name: "backlog-review#Top 10" }).getAttribute("href")).toBe("#/wiki/c1/backlog-review");
  });

  it("shows a page written on the parent task, says where it came from, and offers no Remove for it", () => {
    vi.stubGlobal("fetch", vi.fn());
    const page = (over: Partial<Artifact>): Artifact => ({ id: "a1", kind: "wiki_page", title: "Backlog review", slug: "backlog-review", path: null, ref: null, url: null, agent: "Gandalf", runId: null, createdAt: new Date().toISOString(), ...over });
    render(<TicketOutputs items={[page({ ticketId: "parent", fromNumber: 540 }), page({ id: "a2", title: "Own notes", slug: "own", ticketId: "t1" })]} companyId="c1" ticketId="t1" prefix="HOL" onChanged={() => {}} />);
    expect(screen.getByRole("link", { name: "Backlog review" }).getAttribute("href")).toBe("#/wiki/c1/backlog-review");
    expect(screen.getByRole("link", { name: "from HOL-540" }).getAttribute("href")).toBe("#/tickets/parent");
    expect(screen.getAllByRole("button", { name: /^Take .* off this task$/ }).map((b) => b.getAttribute("aria-label"))).toEqual(["Take Own notes off this task"]);
  });
});
