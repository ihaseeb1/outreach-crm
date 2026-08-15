"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Message only — never log an error object that might carry credentials.
    console.error("[ui] render failed:", error.message);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card card-pad max-w-md space-y-3">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="text-sm text-[var(--color-muted)]">
          The page failed to load. Background jobs are unaffected — nothing is
          sent or lost because of a UI error.
        </p>
        {error.digest && <p className="hint">Reference: {error.digest}</p>}
        <button className="btn-primary" type="button" onClick={reset}>
          Try again
        </button>
      </div>
    </main>
  );
}
