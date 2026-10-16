import { useState, type FormEvent } from "react";
import { api, ApiError } from "../api";
import { art } from "../brand";

/** First run creates the one owner account; after that it's a login. */
export function Auth({ firstRun, onDone }: { firstRun: boolean; onDone: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ username: string }>(firstRun ? "/api/setup" : "/api/login", { method: "POST", body: { username, password } });
      onDone(res.username);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      setError(
        status === 401
          ? "Wrong username or password."
          : status === 429
            ? (err as ApiError).message
            : status === 400
              ? "The password needs at least 12 characters."
              : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <form onSubmit={submit}>
        <img className="logo" src={art.logo} alt="Boss Man, the AI agent manager" />
        {firstRun && <p className="muted">Create the owner account. There's only one, and it controls every company on this server.</p>}
        <div className="field">
          <label htmlFor="username">Username</label>
          <input id="username" autoComplete="username" required value={username} onChange={(e) => setUsername(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" autoComplete={firstRun ? "new-password" : "current-password"} required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn primary" type="submit" disabled={busy}>
          {firstRun ? "Create owner account" : "Log in"}
        </button>
      </form>
    </main>
  );
}
