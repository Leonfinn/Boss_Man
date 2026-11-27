// What a chat message shows: links as before, and a fenced block as its own command box with a Copy
// button (BOS-2853). The fences are read by the shared step parser (packages/shared/src/step-text.ts),
// the same reading decision cards use, so a chat reply and a card show a command the same way.
import { Fragment, type ReactNode } from "react";
import { parseStep, type StepPiece } from "@boss-man/shared";
import { linkPieces, type LinkContext } from "../links";
import { CommandBlock } from "./CommandBlock";

/** Plain text with in-app links made clickable (BOS-358): one shared builder, see links.ts. */
export function linked(text: string, wikiCompanyId?: string, ctx: LinkContext = {}, mark: (words: string) => ReactNode = (w) => w): ReactNode {
  return linkPieces(text, { ...ctx, companyId: wikiCompanyId ?? ctx.companyId }).map((p, i) =>
    p.kind === "text" ? (
      <Fragment key={i}>{mark(p.text)}</Fragment>
    ) : p.kind === "image" ? (
      <a key={i} href={p.src} target="_blank" rel="noreferrer" className="msg-img">
        <img src={p.src} alt={p.alt} loading="lazy" />
      </a>
    ) : p.kind === "file" ? (
      <a key={i} href={p.href} download className="file-chip">
        {p.text}
      </a>
    ) : (
      <a key={i} href={p.href}>
        {mark(p.text)}
      </a>
    ),
  );
}

/** A message's pieces: the shared parser only when there is a fence to read, so ordinary text is untouched. */
const piecesOf = (text: string): StepPiece[] => (text.includes("```") ? parseStep(text) : [{ type: "text", text }]);

/** A message with its fenced blocks drawn as command boxes. Text outside a fence keeps its links and find marks. */
export function MessageText({ text, wikiCompanyId, ctx = {}, mark = (w) => w }: { text: string; wikiCompanyId?: string; ctx?: LinkContext; mark?: (words: string) => ReactNode }) {
  const pieces = piecesOf(text);
  return (
    <>
      {pieces.map((p, i) =>
        p.type === "command" ? (
          <CommandBlock key={i} command={p.text} code={mark(p.text)} />
        ) : (
          <span key={i} style={{ display: "block", whiteSpace: "pre-wrap" }}>
            {linked(p.text, wikiCompanyId, ctx, mark)}
          </span>
        ),
      )}
    </>
  );
}

/** What a message shows as words (plain text, link text and command text), for the find box: never the markup or an image. */
export const visibleParts = (text: string) => piecesOf(text).flatMap((p) => linkPieces(p.text, {}).flatMap((x) => (x.kind === "text" || x.kind === "link" ? [x.text] : [])));

/** One line for a thread list's preview: a fenced block reads as its command, never its ``` or language tag. */
export const previewText = (text: string) => piecesOf(text).map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();

/** The same text for a feed preview, keeping its lines: fences become their command instead of raw ``` lines. */
export const plainText = (text: string) => piecesOf(text).map((p) => p.text).join("\n").trim();
