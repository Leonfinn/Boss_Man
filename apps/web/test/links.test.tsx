// The one link builder and the screens that show it (BOS-358). One row per link kind and one
// column per surface, and every column draws the real screen (chat's linked(), the Markdown
// component, the ticket activity feed, TicketOutputs), so a screen that went back to its own
// pattern fails. Each surface declares the kinds it can really place, because a screen only
// links what it has the context for (the wiki page and skills know a company but no tickets;
// the activity feed knows this ticket only). Includes the owner's exact link from BOS-356.
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { linkMarkdown, linkPieces, ticketHref, wikiHref, type LinkContext } from "../src/links";
import { linked } from "../src/pages/Chat";
import { Markdown } from "../src/components/Markdown";
import { TicketActivity } from "../src/components/TicketActivity";
import { TicketOutputs } from "../src/components/TicketOutputs";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COMPANY = "8c7f803d-8266-4cae-b17b-79e289142018";
const OWNER_PAGE = "runbooks/move-boss-man-to-a-new-host";
// The owner's message from BOS-356, verbatim: a Markdown link and a bare route, both full wiki addresses.
const OWNER_TEXT = `Cause: see [#/wiki/${COMPANY}/${OWNER_PAGE}](#/wiki/${COMPANY}/${OWNER_PAGE}) and #/wiki/${COMPANY}/${OWNER_PAGE}.`;
const OWNER_HREF = `#/wiki/${COMPANY}/${OWNER_PAGE}`;

const ctx: LinkContext = {
  companyId: "c1",
  prefix: "BOS",
  selfId: "t358",
  tickets: [
    { id: "t356", number: 356, prefix: "BOS" },
    { id: "t358", number: 358, prefix: "BOS" },
  ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("the shared link builder (BOS-358)", () => {
  it("builds a wiki page, its section, a ticket reference and a route", () => {
    expect(wikiHref("research/landscape", "c1")).toBe("#/wiki/c1/research/landscape");
    expect(wikiHref("deploy#Rollback", "c1")).toBe("#/wiki/c1/deploy#Rollback");
    expect(wikiHref(`${COMPANY}/${OWNER_PAGE}`, COMPANY)).toBe(OWNER_HREF);
    expect(ticketHref("BOS-356", ctx)).toBe("#/tickets/t356");
    expect(ticketHref("HOL-356", ctx)).toBeNull();
    expect(ticketHref("BOS-999", ctx)).toBeNull();
  });

  it("leaves another company's page, and any page with no company, as plain text", () => {
    const theirs = "11111111-2222-3333-4444-555555555555";
    expect(linkPieces(`See [[${theirs}/their-page]].`, { companyId: "c1" })).toEqual([{ kind: "text", text: `See [[${theirs}/their-page]].` }]);
    expect(linkPieces("See [[deploy]].", {})).toEqual([{ kind: "text", text: "See [[deploy]]." }]);
  });

  it("does not link a ticket reference the screen can't place", () => {
    expect(linkPieces("Done in BOS-356.", { companyId: "c1" })).toEqual([{ kind: "text", text: "Done in BOS-356." }]);
  });

  it("leaves an empty [x]() with no link to an empty address", () => {
    const links = linkPieces("See [x]() here.", ctx);
    expect(links.filter((p) => p.kind === "link")).toHaveLength(0);
    expect(links.map((p) => ("text" in p ? p.text : "")).join("")).toBe("See [x]() here.");
  });

  // Rex's review: text inside code and an existing Markdown link is left alone, and a route
  // inside the middle of a URL or word is not mistaken for one.
  it("leaves code, existing Markdown links and mid-URL routes alone", () => {
    expect(linkPieces(`Use \`[[deploy]]\` here.`, ctx)).toEqual([{ kind: "text", text: "Use `[[deploy]]` here." }]);
    expect(linkPieces("```\nBOS-356\n```", ctx)).toEqual([{ kind: "text", text: "```\nBOS-356\n```" }]);
    // An external Markdown link stays exactly as written: the #/ inside its address is not an in-app route.
    expect(linkPieces("[read this](https://example.com/a#/wiki/c1/deploy)", ctx)).toEqual([
      { kind: "text", text: "[read this](https://example.com/a#/wiki/c1/deploy)" },
    ]);
    expect(linkPieces("https://example.com/x#/wiki/c1/deploy", ctx)).toEqual([{ kind: "text", text: "https://example.com/x#/wiki/c1/deploy" }]);
  });
});

const ID = "11111111-2222-3333-4444-555555555555";

// One row per link kind; each surface below must show it as a link to `href` with that label.
const KINDS: Array<{ name: string; text: string; href: string; label: string }> = [
  { name: "page name", text: "Go to [[deploy]].", href: "#/wiki/c1/deploy", label: "deploy" },
  { name: "page name with a section", text: "Go to [[deploy#Rollback]].", href: "#/wiki/c1/deploy#Rollback", label: "deploy" + "#Rollback" },
  { name: "page name with the company id in front", text: `Go to [[c1/${OWNER_PAGE}]].`, href: OWNER_HREF.replace(COMPANY, "c1"), label: OWNER_PAGE },
  { name: "ticket reference", text: "Done in BOS-356.", href: "#/tickets/t356", label: "BOS-356" },
  { name: "ticket reference to this ticket", text: "This one, BOS-358, is it.", href: "#/tickets/t358", label: "BOS-358" },
  { name: "bare route", text: "Open #/decisions now.", href: "#/decisions", label: "decisions" },
  { name: "route written as a Markdown link", text: "Open [the task](#/tickets/t356).", href: "#/tickets/t356", label: "the task" },
  { name: "pasted image", text: `Look: ![bug.png](/api/ticket-images/${ID})`, href: `/api/ticket-images/${ID}`, label: "bug.png" },
];

const PAGE_KINDS = new Set(["page name", "page name with a section", "page name with the company id in front"]);

// Each surface is a real screen, drawn with the link text, then asked for its links. `can` lists
// the kinds that screen's real context lets it place; anything else must stay plain text there.
const SURFACES: Array<{ name: string; can: (kind: string) => boolean; draw: (text: string) => Promise<void> }> = [
  {
    name: "chat",
    can: () => true,
    draw: async (text) => {
      render(<p>{linked(text, "c1", { prefix: "BOS", selfId: "t358", tickets: ctx.tickets })}</p>);
    },
  },
  {
    name: "ticket activity",
    can: (kind) => kind !== "ticket reference", // knows this ticket only, not a list of others
    draw: async (text) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("/messages")) return json({ live: null, items: [{ id: "m1", author: "agent", agent: "Engineer", runId: null, text, delivery: null, createdAt: "2026-10-19T10:00:00Z" }] });
          return json([]);
        }),
      );
      render(<TicketActivity ticketId="t358" companyId="c1" assignee="Engineer" ticketNumber={358} prefix="BOS" />);
      await screen.findByText((_, el) => Boolean(el?.classList.contains("chat-msg")));
    },
  },
  {
    name: "Markdown",
    can: () => true,
    draw: async (text) => {
      render(<Markdown text={text} linkContext={ctx} />);
    },
  },
  {
    name: "wiki page",
    can: (kind) => PAGE_KINDS.has(kind) || kind === "bare route" || kind === "route written as a Markdown link" || kind === "pasted image",
    draw: async (text) => {
      render(<Markdown text={text} linkContext={{ companyId: "c1" }} />);
    },
  },
  {
    name: "skills",
    can: (kind) => PAGE_KINDS.has(kind) || kind === "bare route" || kind === "route written as a Markdown link" || kind === "pasted image",
    draw: async (text) => {
      render(<Markdown text={text} linkContext={{ companyId: "c1" }} />);
    },
  },
];

describe("every link kind on every surface (BOS-358)", () => {
  for (const kind of KINDS) {
    for (const surface of SURFACES) {
      it(`${kind.name}: ${surface.name}`, async () => {
        await surface.draw(kind.text);
        if (!surface.can(kind.name)) {
          // A screen without the context keeps the text exactly as it was written.
          expect(screen.queryByRole("link", { name: kind.label })).toBeNull();
          return;
        }
        if (kind.name === "pasted image") {
          const img = screen.getByRole("img", { name: kind.label });
          const anchor = img.closest("a");
          expect(anchor?.getAttribute("href") ?? img.getAttribute("src")).toBe(kind.href);
          return;
        }
        const link = screen.getByRole("link", { name: kind.label });
        expect(link.getAttribute("href")).toBe(kind.href);
      });
    }
  }

  it("ticket outputs links a page by the name it was written under", async () => {
    // The ticket outputs list shows a page's title as the label and its slug as the address,
    // both through the one shared builder.
    for (const slug of ["deploy", "deploy", `${COMPANY}/${OWNER_PAGE}`]) {
      const href = wikiHref(slug, COMPANY);
      render(<TicketOutputs items={[{ id: "a1", kind: "wiki_page", title: "the page", slug, path: null, ref: null, url: null, agent: "Gandalf", runId: null, createdAt: "2026-10-19T10:00:00Z" }]} companyId={COMPANY} onChanged={() => {}} />);
      expect(screen.getByRole("link", { name: "the page" }).getAttribute("href")).toBe(href);
      cleanup();
    }
  });

  it("every surface: the owner's exact BOS-356 link, on each that shows chat text", async () => {
    for (const surface of SURFACES) {
      await surface.draw(OWNER_TEXT);
      const links = screen.getAllByRole("link");
      expect(links.length, surface.name).toBe(2);
      for (const l of links) expect(l.getAttribute("href"), surface.name).toBe(OWNER_HREF);
      cleanup();
    }
  });

  it("every surface: a section link keeps its section, the case where the old chat code differed", async () => {
    const text = "See [[runbooks/move-boss-man-to-a-new-host#Step2]].";
    const href = "#/wiki/c1/runbooks/move-boss-man-to-a-new-host#Step2";
    for (const surface of SURFACES) {
      await surface.draw(text);
      expect(screen.getByRole("link", { name: "runbooks/move-boss-man-to-a-new-host" + "#Step2" }).getAttribute("href"), surface.name).toBe(href);
      cleanup();
    }
  });

  it("keeps the builder's plain-text and Markdown output in step", () => {
    for (const kind of KINDS) {
      if (kind.name === "pasted image") continue;
      expect(linkPieces(kind.text, ctx)).toContainEqual({ kind: "link", text: kind.label, href: kind.href });
      expect(linkMarkdown(kind.text, ctx)).toContain(`[${kind.label}](${kind.href})`);
    }
  });
});
