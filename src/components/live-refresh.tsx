"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Polls the server component back into life while a job is in flight — the
 * zero-cost stand-in for a websocket. Mounted only while `active`, it calls
 * router.refresh() on an interval so the run's progress counters and new
 * results stream in without the operator reloading.
 */
export function LiveRefresh({
  active,
  intervalMs = 4000,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, router]);

  return null;
}
