import { describe, expect, it } from "vitest";
import { allowUmamiInHeaders, trackLinks } from "../scripts/build.mjs";
import { escapeHtml } from "../scripts/markdown.mjs";

// Made-up values only: this is a direct test of the site's link and header helpers.
const installHref = "/guides/install";
const repo = "https://github.com/example/repo";
const portal = "https://roadmap.example.com";
const opts = { installHref, repo, portal };

describe("trackLinks", () => {
  it("marks install links, also with a query, a hash or a trailing slash", () => {
    for (const href of [installHref, `${installHref}?from=home`, `${installHref}#top`, `${installHref}/`]) {
      expect(trackLinks(`<a href="${href}">Install</a>`, opts), href).toContain('data-umami-event="install-click"');
    }
  });

  it("marks repository links and roadmap portal links", () => {
    expect(trackLinks(`<a href="${repo}">GitHub</a>`, opts)).toContain('data-umami-event="github-click"');
    expect(trackLinks(`<a href="${repo}/">GitHub</a>`, opts)).toContain('data-umami-event="github-click"');
    expect(trackLinks(`<a href="${portal}/board">Roadmap</a>`, opts)).toContain('data-umami-event="roadmap-click"');
  });

  it("marks nothing portal-like when there is no portal", () => {
    expect(trackLinks(`<a href="${portal}/board">Roadmap</a>`, { installHref, repo })).not.toContain("data-umami-event");
  });

  it("leaves an already-marked tag, a link with no href and any other link alone", () => {
    const marked = `<a href="${installHref}" data-umami-event="custom">Install</a>`;
    expect(trackLinks(marked, opts)).toBe(marked);
    const noHref = '<a name="top">Top</a>';
    expect(trackLinks(noHref, opts)).toBe(noHref);
    const elsewhere = '<a href="https://example.com/elsewhere">Elsewhere</a>';
    expect(trackLinks(elsewhere, opts)).toBe(elsewhere);
  });

  it("keeps the tag's other attributes when it adds the event", () => {
    expect(trackLinks('<a class="btn" href="/guides/install">Install</a>', opts)).toBe(
      '<a class="btn" href="/guides/install" data-umami-event="install-click">Install</a>',
    );
  });
});

describe("allowUmamiInHeaders", () => {
  const origin = "https://stats.example.com";
  const csp = "Content-Security-Policy: default-src 'self'; script-src 'self'; base-uri 'self'";

  it("adds the origin to script-src and puts connect-src before base-uri", () => {
    expect(allowUmamiInHeaders(csp, origin)).toBe(
      "Content-Security-Policy: default-src 'self'; script-src 'self' https://stats.example.com; connect-src https://stats.example.com; base-uri 'self'",
    );
  });

  it("returns headers without those parts unchanged", () => {
    const plain = "Content-Security-Policy: default-src 'self'";
    expect(allowUmamiInHeaders(plain, origin)).toBe(plain);
  });
});

describe("escapeHtml", () => {
  it("escapes &, <, > and the double quote, with & first", () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("returns a plain string unchanged", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
  });
});
