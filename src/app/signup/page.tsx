import Link from "next/link";

import { env } from "@/lib/env";
import { SignupForm } from "@/components/signup-form";

export const dynamic = "force-dynamic";

export default function SignupPage() {
  if (!env.signupsOpen()) {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <div className="card card-pad w-full max-w-sm space-y-3">
          <h1 className="text-xl font-semibold">Registration is closed</h1>
          <p className="text-sm text-[var(--color-muted)]">
            New signups are not being accepted right now.
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
      <SignupForm />
    </main>
  );
}
