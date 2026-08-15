"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const supabase = createSupabaseBrowserClient();
    // The handle_new_user() trigger creates the profile, workspace and
    // owner membership from this metadata.
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { workspace_name: workspaceName.trim() } },
    });

    if (signUpError) {
      setError(signUpError.message);
      setBusy(false);
      return;
    }

    if (data.session) {
      router.push("/dashboard");
      router.refresh();
      return;
    }

    // Project has email confirmation enabled.
    setConfirmSent(true);
    setBusy(false);
  }

  if (confirmSent) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="card card-pad w-full max-w-sm space-y-3">
          <h1 className="text-xl font-semibold">Confirm your email</h1>
          <p className="text-sm text-[var(--color-muted)]">
            We sent a confirmation link to <strong>{email}</strong>. Click it, then
            sign in.
          </p>
          <p className="hint">
            Running this just for yourself? Turn off <em>Confirm email</em> in
            Supabase → Authentication → Providers → Email to skip this step.
          </p>
          <Link className="btn-secondary w-full" href="/login">
            Go to sign in
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={onSubmit} className="card card-pad w-full max-w-sm space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Create your workspace</h1>
          <p className="hint mt-1">Outreach CRM</p>
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
    </main>
  );
}
