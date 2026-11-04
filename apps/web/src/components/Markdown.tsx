// Renders Markdown written by the owner or agents. react-markdown builds React elements and
// ignores raw HTML, and its default URL check drops javascript: links, so a page can't run code.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ReactNode } from "react";
import { linkMarkdown, type LinkContext } from "../links";

/** The id a heading gets, so a link like slug#Heading can land on it. */
export function headingId(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

const plain = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number" ? String(node) : Array.isArray(node) ? node.map(plain).join("") : "";

/** Markdown with links built by the one shared builder (BOS-358): page names, ticket references and routes. */
export function Markdown({ text, wikiCompanyId, linkContext }: { text: string; wikiCompanyId?: string; linkContext?: LinkContext }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 id={headingId(plain(children))}>{children}</h1>,
          h2: ({ children }) => <h2 id={headingId(plain(children))}>{children}</h2>,
          h3: ({ children }) => <h3 id={headingId(plain(children))}>{children}</h3>,
          h4: ({ children }) => <h4 id={headingId(plain(children))}>{children}</h4>,
          h5: ({ children }) => <h5 id={headingId(plain(children))}>{children}</h5>,
          h6: ({ children }) => <h6 id={headingId(plain(children))}>{children}</h6>,
          // Links inside Boss Man stay in the tab; anything else opens a new one.
          a: ({ href, children }) =>
            href?.startsWith("#/") ? (
              <a href={href}>{children}</a>
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {linkMarkdown(text, { ...linkContext, companyId: wikiCompanyId ?? linkContext?.companyId })}
      </ReactMarkdown>
    </div>
  );
}
