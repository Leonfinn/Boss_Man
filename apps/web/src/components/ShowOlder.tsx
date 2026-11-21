/** The "Show older" button under a paged list (useOlder, BOS-2165), and why loading failed if it did. */
export function ShowOlder({ older }: { older: { canMore: boolean; more: () => Promise<void>; busy: boolean; error: string | null } }) {
  return (
    <>
      {older.canMore && (
        <div>
          <button type="button" className="btn" disabled={older.busy} onClick={() => void older.more()}>
            {older.busy ? "Loading…" : "Show older"}
          </button>
        </div>
      )}
      {older.error && (
        <p role="alert" className="error">
          {older.error}
        </p>
      )}
    </>
  );
}
