// A failed first load: say so in words and offer Retry, so a blank page is never read as "it is gone".
export function LoadError({ what, message, onRetry }: { what: string; message: string; onRetry: () => void }) {
  return (
    <p className="error" role="alert">
      Couldn't load {what}: {message}{" "}
      <button type="button" className="btn" onClick={onRetry}>
        Retry
      </button>
    </p>
  );
}
