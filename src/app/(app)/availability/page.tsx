import { AvailabilityChecker } from "@/components/availability-checker";
import { requireSession } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function AvailabilityPage() {
  await requireSession();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Availability check</h1>
        <p className="hint mt-1">
          Paste a list of websites and check each against your whole workspace —
          deals, contacts, the prospecting queue, discovery results and
          publishers. &ldquo;Available&rdquo; means the domain is nowhere in your
          pipeline yet, so it&apos;s fresh to work; anything already touched shows
          where and its current state (e.g. replied, open deal, suppressed).
        </p>
      </div>

      <AvailabilityChecker />
    </div>
  );
}
