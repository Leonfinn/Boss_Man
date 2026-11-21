import { useState } from "react";
import { api } from "../../api";
import { Section, useAction } from "./shared";

const MIN_LENGTH = 12;

const devices = (n: number) => (n === 0 ? "No other device was signed in." : `${n} other device${n === 1 ? "" : "s"} signed out.`);

/** The owner's account (BOS-2159): change the password, and sign out every other login. This device stays signed in. */
export function Account() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const change = useAction();
  const others = useAction();
  const mismatch = again !== "" && next !== again;
  const short = next !== "" && next.length < MIN_LENGTH;
  const ready = current !== "" && next.length >= MIN_LENGTH && next === again;

  return (
    <>
      <Section id="change-password-h" title="Change password">
        <p className="muted" style={{ fontSize: 14 }}>
          Use at least {MIN_LENGTH} characters. Changing it signs out every other device; this one stays signed in.
        </p>
        <form
          style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 360 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!ready) return;
            void change.run(async () => {
              const r = await api<{ signedOut: number }>("/api/account/password", { method: "POST", body: { currentPassword: current, newPassword: next } });
              setCurrent("");
              setNext("");
              setAgain("");
              return `Password changed. ${devices(r.signedOut)}`;
            });
          }}
        >
          <label htmlFor="acct-current">Current password</label>
          <input id="acct-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          <label htmlFor="acct-new">New password</label>
          <input id="acct-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          {short && <p className="error" style={{ fontSize: 14 }}>Too short: use at least {MIN_LENGTH} characters.</p>}
          <label htmlFor="acct-again">New password again</label>
          <input id="acct-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          {mismatch && <p className="error" style={{ fontSize: 14 }}>The two new passwords are not the same.</p>}
          <div>
            <button type="submit" className="btn" disabled={!ready || change.busy}>
              Change password
            </button>
          </div>
        </form>
        {change.view}
      </Section>
      <Section id="sign-out-others-h" title="Sign out other devices">
        <p className="muted" style={{ fontSize: 14 }}>
          Ends every other login (a phone, another browser, anyone holding a stolen login). You stay signed in here.
        </p>
        <div>
          <button type="button" className="btn" disabled={others.busy} onClick={() => void others.run(async () => devices((await api<{ signedOut: number }>("/api/account/sign-out-others", { method: "POST" })).signedOut))}>
            Sign out other devices
          </button>
        </div>
        {others.view}
      </Section>
    </>
  );
}
