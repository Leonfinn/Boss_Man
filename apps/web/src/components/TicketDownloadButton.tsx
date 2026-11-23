import { useEffect, useRef, useState } from "react";
import { api, type ScoredFeatures, type TicketDetail } from "../api";
import { download } from "../csv";
import { fetchAllMessages, ticketFileName, ticketMarkdown } from "../ticket-markdown";

/**
 * "Download" in the ticket header (BOS-2314): the ticket as a Markdown file, with its whole conversation.
 * It says "Preparing" while it fetches every page of messages; a failure is said under the button.
 */
export function TicketDownloadButton({ t }: { t: TicketDetail }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      // The ticket carries only the feature's id; its name comes from the company's feature list.
      const feature = t.featureId
        ? await api<ScoredFeatures>(`/api/companies/${t.companyId}/features`).then(
            (f) => f.features.find((x) => x.id === t.featureId)?.title ?? "unknown",
            () => "unknown",
          )
        : null;
      const messages = await fetchAllMessages(t.id);
      if (!mounted.current) return;
      download(ticketFileName(t.ref, t.title), ticketMarkdown(t, messages, feature), "text/markdown;charset=utf-8");
    } catch (err) {
      if (mounted.current) setError(`Couldn't prepare the download: ${(err as Error).message}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
      <button type="button" className="btn small" disabled={busy} onClick={() => void run()}>
        {busy ? "Preparing" : "Download"}
      </button>
      {error && (
        <small role="alert" style={{ color: "var(--red-ink)" }}>
          {error}
        </small>
      )}
    </div>
  );
}
