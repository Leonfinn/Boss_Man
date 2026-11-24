// Renders Markdown written by the owner or agents. react-markdown builds React elements and
// ignores raw HTML, and its default URL check drops javascript: links, so a page can't run code.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createContext, isValidElement, useContext, type ReactNode } from "react";
import { linkMarkdown, type LinkContext } from "../links";
import { EnlargeableImage } from "./Lightbox";

/** The id a heading gets, so a link like slug#Heading can land on it. */
export function headingId(text: string) {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

// A heading's words, including those inside `code`, **bold** or a link, so "## Batch `27`" gets the id
// "batch-27" (it was "batch-", BOS-2443) and agrees with the heading's text the landing code also matches.
const plain = (node: ReactNode): string =>
  typeof node === "string" || typeof node === "number"
    ? String(node)
    : Array.isArray(node)
      ? node.map(plain).join("")
      : isValidElement<{ children?: ReactNode }>(node)
        ? plain(node.props.children)
        : "";

// True while rendering a link's contents, so a picture inside a link stays a plain image: a button can't
// sit inside an anchor, and the link already goes somewhere on click (BOS-330 review).
const InLink = createContext(false);

// A Markdown picture: plain inside a link (a button cannot sit in an anchor), otherwise enlargeable.
function MarkdownImage({ src, alt }: { src?: string | URL; alt?: string }) {
  const url = typeof src === "string" ? src : undefined;
  return useContext(InLink) ? (
    <img src={url} alt={alt ?? ""} />
  ) : (
    <EnlargeableImage src={url} alt={typeof alt === "string" ? alt : undefined} />
  );
}

// Something to show inside each heading after its words (the wiki's "Copy link to this section", BOS-2443).
// It comes through context so the heading components below stay the same functions on every render: a new
// component per render would remount every heading, and a pressed button in one would lose focus.
const HeadingAction = createContext<((id: string, title: string) => ReactNode) | undefined>(undefined);

// The action must add no text of its own (an icon with an aria-label): the wiki outline and the landing code
// read a heading's textContent as its words.
function heading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return function MarkdownHeading({ children }: { children?: ReactNode }) {
    const action = useContext(HeadingAction);
    const title = plain(children);
    const id = headingId(title);
    return (
      <Tag id={id}>
        {children}
        {id && action ? action(id, title) : null}
      </Tag>
    );
  };
}
const [H1, H2, H3, H4, H5, H6] = (["h1", "h2", "h3", "h4", "h5", "h6"] as const).map(heading);

/** Markdown with links built by the one shared builder (BOS-358): page names, ticket references and routes. */
export function Markdown({ text, wikiCompanyId, linkContext, headingAction }: { text: string; wikiCompanyId?: string; linkContext?: LinkContext; headingAction?: (id: string, title: string) => ReactNode }) {
  return (
    <div className="md">
      <HeadingAction.Provider value={headingAction}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: H1,
          h2: H2,
          h3: H3,
          h4: H4,
          h5: H5,
          h6: H6,
          // Links inside Boss Man stay in the tab; anything else opens a new one.
          a: ({ href, children }) =>
            href?.startsWith("#/") ? (
              <a href={href}>
                <InLink.Provider value={true}>{children}</InLink.Provider>
              </a>
            ) : (
              <a href={href} target="_blank" rel="noopener noreferrer">
                <InLink.Provider value={true}>{children}</InLink.Provider>
              </a>
            ),
          // A picture opens enlarged over the page rather than in a new window (BOS-330).
          img: MarkdownImage,
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {linkMarkdown(text, { ...linkContext, companyId: wikiCompanyId ?? linkContext?.companyId })}
      </ReactMarkdown>
      </HeadingAction.Provider>
    </div>
  );
}
