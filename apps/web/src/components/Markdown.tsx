// Renders Markdown written by the owner or agents. react-markdown builds React elements and
// ignores raw HTML, and its default URL check drops javascript: links, so a page can't run code.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// [[slug]] and [[slug#Section]] become links to that wiki page when the company is known.
const wikiLinks = (text: string, companyId: string) =>
  text.replace(/\[\[([^\]#|]+?)(#[^\]]*)?\]\]/g, (_, slug: string, sec = "") => `[${slug.trim()}${sec}](#/wiki/${companyId}/${slug.trim()})`);

export function Markdown({ text, wikiCompanyId }: { text: string; wikiCompanyId?: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
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
        {wikiCompanyId ? wikiLinks(text, wikiCompanyId) : text}
      </ReactMarkdown>
    </div>
  );
}
