// The one link builder and its surfaces (BOS-358). One row per link kind, one column per screen,
// so a pattern that drifts on one screen fails here. Includes the owner's exact link from BOS-356.
import { describe, expect, it } from "vitest";
import { linkMarkdown, linkPieces, routeHref, ticketHref, wikiHref, type LinkContext } from "../src/links";

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

describe("the shared link builder (BOS-358)", () => {
  it("builds a wiki page, its section, a ticket reference and a route", () => {
    expect(wikiHref("research/landscape", "c1")).toBe("#/wiki/c1/research/landscape");
    expect(wikiHref("deploy#Rollback", "c1")).toBe("#/wiki/c1/deploy#Rollback");
    expect(wikiHref(`${COMPANY}/${OWNER_PAGE}`, COMPANY)).toBe(OWNER_HREF);
    expect(ticketHref("BOS-356", ctx)).toBe("#/tickets/t356");
    expect(ticketHref("HOL-356", ctx)).toBeNull();
    expect(ticketHref("BOS-999", ctx)).toBeNull();
  });

  it("keeps the owner's exact BOS-356 link whole, both ways it was written", () => {
    const links = linkPieces(OWNER_TEXT, { companyId: COMPANY }).filter((p) => p.kind === "link");
    expect(links).toHaveLength(2);
    for (const l of links) expect(l.kind === "link" && l.href).toBe(OWNER_HREF);
    expect(linkMarkdown(OWNER_TEXT, { companyId: COMPANY })).toContain(`](${OWNER_HREF})`);
  });

  it("links a ticket reference when the screen knows that ticket, and leaves it plain otherwise", () => {
    expect(linkPieces("Done in BOS-356.", ctx)).toContainEqual({ kind: "link", text: "BOS-356", href: "#/tickets/t356" });
    expect(linkPieces("Done in BOS-356.", { companyId: "c1" })).toEqual([{ kind: "text", text: "Done in BOS-356." }]);
  });

  it("leaves another company's page, and any page with no company, as plain text", () => {
    const theirs = "11111111-2222-3333-4444-555555555555";
    expect(linkPieces(`See [[${theirs}/their-page]].`, { companyId: "c1" })).toEqual([{ kind: "text", text: `See [[${theirs}/their-page]].` }]);
    expect(linkPieces("See [[deploy]].", {})).toEqual([{ kind: "text", text: "See [[deploy]]." }]);
  });

  it("shows images and files pasted into a message", () => {
    const ID = "11111111-2222-3333-4444-555555555555";
    expect(linkPieces(`![bug.png](/api/ticket-images/${ID})`, ctx)).toContainEqual({ kind: "image", alt: "bug.png", src: `/api/ticket-images/${ID}` });
    expect(linkPieces(`[📎 spec.pdf](/api/ticket-images/${ID})`, ctx)).toContainEqual({ kind: "file", text: "📎 spec.pdf", href: `/api/ticket-images/${ID}` });
  });

  it("leaves an empty [x]() with no link to an empty address", () => {
    const links = linkPieces("See [x]() here.", ctx);
    expect(links.filter((p) => p.kind === "link")).toHaveLength(0);
    expect(links.map((p) => ("text" in p ? p.text : "")).join("")).toBe("See [x]() here.");
  });
});

// Every link kind on every surface. Chat and ticket activity show plain text, so they go through
// linkPieces; Markdown, wiki and skills go through linkMarkdown. Both must agree on the address.
const KINDS: Array<{ name: string; text: string; href: string; label: string }> = [
  { name: "page name", text: "Go to [[deploy]].", href: "#/wiki/c1/deploy", label: "deploy" },
  { name: "page name with a section", text: "Go to [[deploy#Rollback]].", href: "#/wiki/c1/deploy#Rollback", label: "deploy#Rollback" },
  { name: "page name with the company id in front", text: `Go to [[c1/${OWNER_PAGE}]].`, href: OWNER_HREF.replace(COMPANY, "c1"), label: OWNER_PAGE },
  { name: "ticket reference", text: "Done in BOS-356.", href: "#/tickets/t356", label: "BOS-356" },
  { name: "ticket reference to this ticket", text: "This one, BOS-358, is it.", href: "#/tickets/t358", label: "BOS-358" },
  { name: "bare route", text: "Open #/decisions now.", href: "#/decisions", label: "decisions" },
  { name: "bare ticket route", text: "Open #/tickets/t356 now.", href: "#/tickets/t356", label: "task" },
  { name: "route written as a Markdown link", text: "Open [the task](#/tickets/t356).", href: "#/tickets/t356", label: "the task" },
];

describe("every link kind on every surface (BOS-358)", () => {
  for (const kind of KINDS) {
    it(`${kind.name}: chat and ticket activity (plain text)`, () => {
      expect(linkPieces(kind.text, ctx)).toContainEqual({ kind: "link", text: kind.label, href: kind.href });
    });
    it(`${kind.name}: Markdown, wiki pages and skills`, () => {
      expect(linkMarkdown(kind.text, ctx)).toContain(`[${kind.label}](${kind.href})`);
    });
  }

  it("every surface: the owner's exact BOS-356 link, on each", () => {
    for (const surface of ["chat", "ticket activity", "Markdown", "wiki", "skills", "ticket outputs"]) {
      const hrefs = surface === "chat" || surface === "ticket activity" ? linkPieces(OWNER_TEXT, { companyId: COMPANY }) : linkPieces(linkMarkdown(OWNER_TEXT, { companyId: COMPANY }), { companyId: COMPANY });
      const links = hrefs.filter((p) => p.kind === "link");
      expect(links.length, surface).toBe(2);
      for (const l of links) expect(l.kind === "link" && l.href, surface).toBe(OWNER_HREF);
    }
  });
});

// routeHref is the single check for "is this an in-app route?": a route starts "#/" and is passed
// through unchanged, so an id or page name already encoded stays encoded. Anything else is not
// a route the screen can open, and the caller shows it as plain text.
describe("routeHref: the in-app routes it builds (BOS-358)", () => {
  it("returns every kind of in-app route exactly as written", () => {
    const routes = [
      "#/decisions",
      "#/tickets/t356",
      "#/tickets/8c7f803d-8266-4cae-b17b-79e289142018",
      "#/wiki/c1/research/landscape",
      "#/wiki/c1/deploy#Rollback",
      "#/wiki/c1/runbooks/move-boss-man-to-a-new-host#Step2",
    ];
    for (const route of routes) expect(routeHref(route)).toBe(route);
  });

  it("leaves an id that needs encoding alone instead of encoding it twice", () => {
    // A wiki page can hold a space, a plus or a slash; the address is built already encoded.
    for (const route of ["#/wiki/c1/a%20page", "#/wiki/c1/c%2B%2B", "#/tickets/abc%2Fdef", "#/wiki/c1/caf%C3%A9"]) {
      expect(routeHref(route)).toBe(route);
    }
  });

  it("keeps a route's section and query string whole", () => {
    expect(routeHref("#/wiki/c1/deploy#Rollback?from=chat")).toBe("#/wiki/c1/deploy#Rollback?from=chat");
    expect(routeHref("#/tickets/t356?tab=activity")).toBe("#/tickets/t356?tab=activity");
  });

  it("treats the empty route as a route, so the caller can drop it", () => {
    // linkPieces also refuses "#/" on its own; routeHref reports what was written, not what renders.
    expect(routeHref("#/")).toBe("#/");
  });

  it("returns null for anything that is not an in-app route", () => {
    const notRoutes = [
      "",
      "decisions",
      "/decisions",
      "tickets/t356",
      "BOS-356",
      "https://example.com/#/wiki/c1/deploy",
      "http://example.com",
      " #/decisions",
      "#decisions",
      "##/decisions",
      "/wiki/c1/deploy",
    ];
    for (const value of notRoutes) expect(routeHref(value), value).toBeNull();
  });
});
