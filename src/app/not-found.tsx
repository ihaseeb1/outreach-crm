import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="card card-pad max-w-md space-y-3 text-center">
        <h1 className="text-xl font-semibold">Not found</h1>
        <p className="text-sm text-[var(--color-muted)]">
          That page, contact, or campaign doesn&apos;t exist — or it belongs to a
          different workspace.
        </p>
        <Link className="btn-secondary" href="/dashboard">
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}
