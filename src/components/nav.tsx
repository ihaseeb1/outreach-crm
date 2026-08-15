"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface NavItem {
  href: string;
  label: string;
  /** Phases that are not built yet render as disabled with a note. */
  soon?: boolean;
}

export function SideNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav className="space-y-0.5">
      {items.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(`${item.href}/`);

        if (item.soon) {
          return (
            <span
              key={item.href}
              className="flex cursor-not-allowed items-center justify-between rounded-md px-3 py-2 text-sm text-[var(--color-muted)] opacity-60"
            >
              {item.label}
              <span className="hint">soon</span>
            </span>
          );
        }

        return (
          <Link
            key={item.href}
            href={item.href}
            className={`block rounded-md px-3 py-2 text-sm transition-colors ${
              active
                ? "bg-blue-50 font-medium text-[var(--color-brand)]"
                : "text-[var(--color-ink)] hover:bg-[var(--color-canvas)]"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
