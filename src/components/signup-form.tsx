"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * Signup form. Posts to the server route /api/auth/signup, which enforces the
 * registration flags and creates the account as `pending` (unless approval is
 * turned off). No session is returned, so on success we show what happens next
 * rather than routing into the app a pending user cannot use.
 */
export function SignupForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<null | { requiresApproval: boolean }>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, workspaceName: workspaceName.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(json.error ?? "Could not create the account.");
        return;
      }
      setDone({ requiresApproval: Boolean(json.requiresApproval) });
    } catch {
      setError("Network error — try again.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card card-pad w-full max-w-sm space-y-3">
        <h1 className="text-xl font-semibold">Account created</h1>
        <p className="text-sm text-[var(--color-muted)]">
          {done.requiresApproval
            ? "Your account is waiting for an administrator to approve it. You'll be able to sign in once it's approved."
            : "Your account is ready. You can sign in now."}
        </p>
        <Link className="btn-secondary w-full" href="/login">
          Go to sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="card card-pad w-full max-w-sm space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Create your account</h1>
        <p className="hint mt-1">Outreach CRM · new accounts need approval</p>
      </div>

      <div>
        <label className="label" htmlFor="workspace">
          Workspace name
        </label>
        <input
          id="workspace"
          className="input"
          placeholder="Link building"
          value={workspaceName}
          onChange={(e) => setWorkspaceName(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="email">
          Email
        </label>
        <input
          id="email"
          className="input"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div>
        <label className="label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="input"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="hint mt-1">At least 8 characters.</p>
      </div>

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}

      <button className="btn-primary w-full" type="submit" disabled={busy}>
        {busy ? "Creating…" : "Create account"}
      </button>

      <p className="hint">
        Already have an account?{" "}
        <Link className="text-[var(--color-brand)] hover:underline" href="/login">
          Sign in
        </Link>
      </p>
    </form>
  );
}
