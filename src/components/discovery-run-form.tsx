"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { expandFootprints } from "@/discovery/footprints";
import { geoOptions } from "@/discovery/geo";

/**
 * New discovery run: a niche, a geo, and the synonym toggle. The generated
 * query list is previewed and editable before the run starts (product quality
 * bar — the operator can trim or add footprints), then handed to the worker.
 */
export function DiscoveryRunForm() {
  const router = useRouter();
  const options = useMemo(() => geoOptions(), []);

  const [niche, setNiche] = useState("");
  const [geo, setGeo] = useState("WORLDWIDE");
  const [includeSynonyms, setIncludeSynonyms] = useState(true);
  const [edited, setEdited] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generated = useMemo(
    () => (niche.trim() ? expandFootprints(niche, { includeSynonyms }) : []),
    [niche, includeSynonyms],
  );

  // The list actually sent: the operator's edits if they touched it, else generated.
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
      const response = await fetch("/api/discovery/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ niche, geo, includeSynonyms, queries }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Failed to start run.");
      router.push(`/discovery/${payload.runId}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="card card-pad space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="niche">
            Niche / keyword
          </label>
          <input
            id="niche"
            className="input"
            placeholder="e.g. tech, personal finance, home improvement"
            value={niche}
            onChange={(e) => {
              setNiche(e.target.value);
              setEdited(null);
            }}
          />
          <p className="hint mt-1">
            Synonyms are folded in automatically (tech → technology, gadgets, software…).
          </p>
        </div>

        <div>
          <label className="label" htmlFor="geo">
            Target region
          </label>
          <select
            id="geo"
            className="input"
            value={geo}
            onChange={(e) => setGeo(e.target.value)}
          >
            {options.map((o) => (
              <option key={o.code} value={o.code}>
                {o.name}
              </option>
            ))}
          </select>
          <p className="hint mt-1">Worldwide casts the widest net.</p>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={includeSynonyms}
          onChange={(e) => {
            setIncludeSynonyms(e.target.checked);
            setEdited(null);
          }}
        />
        Expand niche into synonyms
      </label>

      {niche.trim() && (
        <details className="rounded-md border border-[var(--color-border)] p-3">
          <summary className="cursor-pointer text-sm font-medium">
            {queries.length} search {queries.length === 1 ? "query" : "queries"} —
            review &amp; edit
          </summary>
          <textarea
            className="input mt-2 min-h-40 font-mono text-xs"
            value={edited ?? generated.join("\n")}
            onChange={(e) => setEdited(e.target.value)}
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() => setEdited(null)}
            >
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
          disabled={busy || !niche.trim() || queries.length === 0}
        >
          {busy ? "Searching… (up to a minute)" : "Start discovery run"}
        </button>
        <span className="hint">
          Runs process in the background — keep the local worker running for speed.
        </span>
      </div>

      {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
    </form>
  );
}
