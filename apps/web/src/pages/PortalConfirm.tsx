// The page an emailed confirmation link opens (confirm.html#<token>), BOS-1388. The token stays after the "#", so it
// never reaches a server log or a Referer header; this page sends it in the body of one request. It is shown once:
// a second visit (a mail scanner, a double click, an old email) gets the same plain "already used or run out" answer.
import { useEffect, useRef, useState } from "react";

export type ConfirmState = "working" | "done" | "failed" | "incomplete";

export const CONFIRM_WORDS: Record<ConfirmState, { heading: string; body: string }> = {
  working: { heading: "Confirming…", body: "One moment." },
  done: { heading: "Thank you, that's confirmed", body: "Your feedback now counts. This browser will remember you for a while, so you won't need to confirm again. You can close this page." },
  failed: { heading: "This link doesn't work any more", body: "It has already been used, or it has run out. Go back to the feedback page and send it again, and we'll email you a new link." },
  incomplete: { heading: "This link is incomplete", body: "Open the link from your email again, and make sure the whole link is used." },
};

export async function confirmToken(token: string, fetcher: typeof fetch = fetch): Promise<ConfirmState> {
  if (!token) return "incomplete";
  try {
    const res = await fetcher("/api/portal/confirm", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
    return res.ok ? "done" : "failed";
  } catch {
    return "failed";
  }
}

export function ConfirmPage() {
  const [state, setState] = useState<ConfirmState>("working");
  const started = useRef(false);
  useEffect(() => {
    // Strict mode runs effects twice in development; the link works once, so only the first run may use it.
    if (started.current) return;
    started.current = true;
    const token = decodeURIComponent(window.location.hash.replace(/^#/, ""));
    // The token leaves the address bar and the history, so it can't be copied from there by accident.
    window.history.replaceState(null, "", window.location.pathname);
    void confirmToken(token).then(setState);
  }, []);
  const words = CONFIRM_WORDS[state];
  return (
    <main className="portal">
      <h1>{words.heading}</h1>
      <p role={state === "failed" || state === "incomplete" ? "alert" : "status"}>{words.body}</p>
    </main>
  );
}
