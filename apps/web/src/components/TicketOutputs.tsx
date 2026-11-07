// What a ticket produced (R69): wiki pages, repo files and links its agents attached.
import { ticketRef } from "@boss-man/shared";
import { api } from "../api";
import { wikiHref } from "../links";
import { when } from "../pages/Runs";

export type Artifact = { ticketId?: string; fromTitle?: string; fromNumber?: number | null; id: string; kind: "wiki_page" | "repo_file" | "url"; title: string; slug: string | null; path: string | null; ref: string | null; url: string | null; agent: string | null; runId: string | null; createdAt: string };

export function TicketOutputs({ items, companyId, onChanged, code, ticketId, prefix }: { items: Artifact[]; companyId: string; onChanged: () => void; code?: { merged: string } | { branch: string } | null; ticketId?: string; prefix?: string | null }) {
  const remove = async (a: Artifact) => {
    if (!window.confirm(`Take "${a.title}" off this task? ${a.kind === "wiki_page" ? "The wiki page itself stays." : ""}`)) return;
    await api(`/api/artifacts/${a.id}`, { method: "DELETE" });
    onChanged();
  };
  const codeLine = code && (
    <p className="muted">
      {"merged" in code ? (
        <>
          Its code was merged as <span className="mono">{code.merged.slice(0, 7)}</span>.
        </>
      ) : (
        <>
          Its code is on the branch <span className="mono">{code.branch}</span>.
        </>
      )}{" "}
      See Changes below.
    </p>
  );
  if (!items.length) return codeLine || <p className="muted">Nothing yet. Documents agents write for this task appear here.</p>;
  return (
    <>
    {codeLine}
    <ul className="link-list">
      {items.map((a) => (
        <li key={a.id}>
          <span className="tag">{a.kind === "wiki_page" ? "wiki" : a.kind === "repo_file" ? "repo file" : "link"}</span>
          {a.kind === "wiki_page" ? (
            // The one shared wiki address builder (BOS-358), so a page opens the same from here and chat.
            <a href={wikiHref(a.slug ?? "", companyId)}>{a.title}</a>
          ) : a.kind === "url" ? (
            <a href={a.url!} target="_blank" rel="noopener noreferrer">
              {a.title}
            </a>
          ) : (
            <span>
              {a.title !== a.path && <>{a.title} · </>}
              <span className="mono">{a.path}</span>
              {a.ref && <span className="muted"> on {a.ref}</span>}
            </span>
          )}
          {/* Written on the parent task or a sub-task, shown here too so the owner needn't go looking. */}
          {ticketId && a.ticketId && a.ticketId !== ticketId && (
            <a className="muted" href={`#/tickets/${a.ticketId}`} style={{ fontSize: 13 }}>
              from {a.fromNumber ? ticketRef(prefix, a.fromNumber) : `"${a.fromTitle}"`}
            </a>
          )}
          <small className="muted">
            {a.agent ?? "You"} · {when(a.createdAt)}
            {a.runId && (
              <>
                {" · "}
                <a href={`#/runs/${a.runId}`}>run</a>
              </>
            )}
          </small>
          {(!ticketId || !a.ticketId || a.ticketId === ticketId) && (
            <button type="button" className="link" onClick={() => void remove(a)} aria-label={`Take ${a.title} off this task`}>
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
    </>
  );
}
