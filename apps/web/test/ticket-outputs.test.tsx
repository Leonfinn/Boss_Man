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

  it("keeps the page name on a full #/wiki/<company>/<slug> link, the way the wiki tool writes it (BOS-356)", () => {
    render(
      <p>
        {linked(
          "Cause: see [#/wiki/8c7f803d-8266-4cae-b17b-79e289142018/runbooks/move-boss-man-to-a-new-host](#/wiki/8c7f803d-8266-4cae-b17b-79e289142018/runbooks/move-boss-man-to-a-new-host) and #/wiki/8c7f803d-8266-4cae-b17b-79e289142018/runbooks/move-boss-man-to-a-new-host.",
          "c1",
        )}
      </p>,
    );
    const href = "#/wiki/8c7f803d-8266-4cae-b17b-79e289142018/runbooks/move-boss-man-to-a-new-host";
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);
    for (const link of links) expect(link.getAttribute("href")).toBe(href);
  });

  it("keeps the section on a wiki link, and does not stretch a link across a space (BOS-356)", () => {
    render(<p>{linked("See #/wiki/c1/runbooks/move-boss-man-to-a-new-host#Step2, then the rest.", "c1")}</p>);
    expect(screen.getByRole("link").getAttribute("href")).toBe("#/wiki/c1/runbooks/move-boss-man-to-a-new-host#Step2");
    expect(screen.getByText(/then the rest\./)).toBeTruthy();
  });

  it("takes this company's id in front of a short page name, and leaves another company's unlinked (BOS-356)", () => {
    const mine = "c1";
    const theirs = "8c7f803d-8266-4cae-b17b-79e289142018";
    render(<p>{linked(`See [[${mine}/backlog-review]] and [[${theirs}/their-page]].`, mine)}</p>);
    expect(screen.getByRole("link", { name: "backlog-review" }).getAttribute("href")).toBe("#/wiki/c1/backlog-review");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText(new RegExp(`\\[\\[${theirs}/their-page\\]\\]`))).toBeTruthy();
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
