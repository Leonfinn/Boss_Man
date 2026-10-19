// What a ticket produced (R69): wiki pages, repo files and links its agents attached.
import { api } from "../api";
import { when } from "../pages/Runs";

export type Artifact = { id: string; kind: "wiki_page" | "repo_file" | "url"; title: string; slug: string | null; path: string | null; ref: string | null; url: string | null; agent: string | null; runId: string | null; createdAt: string };

export function TicketOutputs({ items, companyId, onChanged }: { items: Artifact[]; companyId: string; onChanged: () => void }) {
  const remove = async (a: Artifact) => {
    if (!window.confirm(`Take "${a.title}" off this task? ${a.kind === "wiki_page" ? "The wiki page itself stays." : ""}`)) return;
    await api(`/api/artifacts/${a.id}`, { method: "DELETE" });
    onChanged();
  };
  if (!items.length) return <p className="muted">Nothing yet. Documents agents write for this task appear here.</p>;
  return (
    <ul className="link-list">
      {items.map((a) => (
        <li key={a.id}>
          <span className="tag">{a.kind === "wiki_page" ? "wiki" : a.kind === "repo_file" ? "repo file" : "link"}</span>
          {a.kind === "wiki_page" ? (
            <a href={`#/wiki/${companyId}/${a.slug}`}>{a.title}</a>
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
          <small className="muted">
            {a.agent ?? "You"} · {when(a.createdAt)}
            {a.runId && (
              <>
                {" · "}
                <a href={`#/runs/${a.runId}`}>run</a>
              </>
            )}
          </small>
          <button type="button" className="link" onClick={() => void remove(a)} aria-label={`Take ${a.title} off this task`}>
            Remove
          </button>
        </li>
      ))}
    </ul>
  );
}
