import Link from "next/link";

import { SideNav, type NavItem } from "@/components/nav";
import { requireSession } from "@/lib/workspace";

// Items marked `soon` light up as their phase lands.
const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/reports", label: "Reports" },
  { href: "/discovery", label: "Discovery" },
  { href: "/publishers", label: "Publishers" },
  { href: "/leads", label: "Find clients" },
  { href: "/prospecting", label: "Prospecting" },
  { href: "/availability", label: "Availability" },
  { href: "/contacts", label: "Contacts" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/tasks", label: "Tasks" },
  { href: "/mailboxes", label: "Mailboxes" },
  { href: "/deliverability", label: "Deliverability" },
  { href: "/compose", label: "Compose" },
  { href: "/campaigns", label: "Campaigns" },
  { href: "/inbox", label: "Inbox" },
  { href: "/deals", label: "Deals" },
  { href: "/suppressions", label: "Suppressions" },
  { href: "/settings", label: "Settings" },
];

const ADMIN_NAV: NavItem = { href: "/admin/approvals", label: "Approvals" };

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();

  const nav =
    session.appRole === "super_admin" || session.appRole === "admin"
      ? [...NAV, ADMIN_NAV]
      : NAV;

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-60 shrink-0 border-r border-[var(--color-line)] bg-[var(--color-surface)] p-4 md:block">
        <Link href="/dashboard" className="mb-6 block">
          <span className="text-sm font-semibold">Outreach CRM</span>
          <span className="hint block truncate">{session.workspace.name}</span>
        </Link>

        <SideNav items={nav} />

        <form action="/auth/signout" method="post" className="mt-6">
          <button className="btn-secondary w-full" type="submit">
            Sign out
          </button>
        </form>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="border-b border-[var(--color-line)] bg-[var(--color-surface)] px-6 py-3 md:hidden">
          <Link href="/dashboard" className="text-sm font-semibold">
            Outreach CRM
          </Link>
        </header>
        <main className="mx-auto max-w-6xl p-6">{children}</main>
      </div>
    </div>
  );
}
