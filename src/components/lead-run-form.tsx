"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { expandLeadQueries } from "@/leads/footprints";
import { geoOptions } from "@/discovery/geo";

/**
 * New lead-sourcing run: an industry, a location, a region. Generates the
 * business-finding query list (previewable + editable), then hands it to the
 * worker, which queues the found business domains into Prospecting for scraping.
 */
export function LeadRunForm() {
  const router = useRouter();
  const options = useMemo(() => geoOptions(), []);

  const [industry, setIndustry] = useState("");
  const [location, setLocation] = useState("");
  const [geo, setGeo] = useState("WORLDWIDE");
  const [edited, setEdited] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generated = useMemo(
    () => (industry.trim() ? expandLeadQueries(industry, location) : []),
    [industry, location],
  );

  const queries = useMemo(() => {
    if (edited === null) return generated;
    return edited
      .split("\n")
      .map((q) => q.trim())
      .filter(Boolean);
  }, [edited, generated]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/leads/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ industry, location, geo, queries }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to start run.");
      setIndustry("");
      setLocation("");
      setEdited(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card card-pad space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="industry">
            Industry / business type
          </label>
          <input
            id="industry"
            className="input"
            placeholder="e.g. dentists, plumbers, law firms"
            value={industry}
            onChange={(e) => {
              setIndustry(e.target.value);
              setEdited(null);
            }}
          />
        </div>

        <div>
          <label className="label" htmlFor="location">
            Location
          </label>
          <input
            id="location"
            className="input"
            placeholder="e.g. Texas, London, California"
            value={location}
            onChange={(e) => {
              setLocation(e.target.value);
              setEdited(null);
            }}
          />
          <p className="hint mt-1">Leave blank to search the industry with no place.</p>
        </div>

        <div>
          <label className="label" htmlFor="geo">
            Search region
          </label>
          <select id="geo" className="input" value={geo} onChange={(e) => setGeo(e.target.value)}>
            {options.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {industry.trim() && (
        <details className="rounded-md border border-[var(--color-border)] p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {queries.length} search {queries.length === 1 ? "query" : "queries"} — review &amp; edit
          </summary>
          <textarea
            className="input mt-2 min-h-40 font-mono text-xs"
            value={edited ?? generated.join("\n")}
            onChange={(e) => setEdited(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-3">
            <button type="button" className="btn-ghost text-xs" onClick={() => setEdited(null)}>
              Reset to generated
            </button>
            <span className="hint">One query per line.</span>
          </div>
        </details>
      )}

      <div className="flex items-center gap-3">
        <button
          className="btn-primary"
          type="submit"
          disabled={busy || !industry.trim() || queries.length === 0}
        >
          {busy ? "Starting…" : "Find leads"}
        </button>
        <span className="hint">
          Found businesses are queued into Prospecting and scraped for emails — keep the local worker
          running for speed.
        </span>
      </div>

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
    </form>
  );
}
