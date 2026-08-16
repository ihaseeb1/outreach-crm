"use client";

import { useEffect, useMemo, useRef } from "react";

/**
 * Timezone picker.
 *
 * This was a free-text box, which is a bad trade for a field that silently
 * changes when your mail goes out: "Europe/london" or "PST" simply fails to
 * resolve, and resolveWindow then falls back to UTC without saying so. A list
 * of real IANA zones removes the failure mode entirely.
 *
 * The list comes from the browser (Intl.supportedValuesOf) so it stays current
 * without shipping a table that rots, with a small fallback for older engines.
 */

const FALLBACK_ZONES = [
  "UTC",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Rome",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Anchorage",
  "America/Toronto",
  "America/Vancouver",
  "America/Mexico_City",
  "America/Bogota",
  "America/Sao_Paulo",
  "America/Argentina/Buenos_Aires",
  "Africa/Casablanca",
  "Africa/Lagos",
  "Africa/Cairo",
  "Africa/Johannesburg",
  "Africa/Nairobi",
  "Asia/Jerusalem",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Jakarta",
  "Asia/Singapore",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Manila",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Australia/Perth",
  "Australia/Brisbane",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
];

/** e.g. "+05:00" — shown so two similar-looking zones can be told apart. */
function offsetLabel(zone: string, now: Date): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }).formatToParts(now);
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "";
    return name.replace("GMT", "UTC") || "UTC";
  } catch {
    return "";
  }
}

export function TimezoneSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
}) {
  const detected = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const zones = useMemo(() => {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
    ).supportedValuesOf;

    let list: string[];
    try {
      list = supported?.("timeZone") ?? FALLBACK_ZONES;
    } catch {
      list = FALLBACK_ZONES;
    }

    // A zone already saved on the campaign must stay selectable even if this
    // browser does not list it, or opening the panel would silently change it.
    const all = new Set<string>([...list, "UTC", detected]);
    if (value) all.add(value);
    return [...all].sort();
  }, [detected, value]);

  const now = useMemo(() => new Date(), []);

  // A campaign saved before this field existed has an empty timezone. The
  // select would then *display* the detected zone while the value still saved
  // as empty — so the panel would claim one sending window and the engine
  // would use another. Committing the fallback keeps shown and saved identical.
  // Guarded with a ref rather than an effect dependency: the parent passes an
  // inline arrow, so its identity changes every render and a dependency on it
  // would re-fire this in a loop.
  const committed = useRef(false);
  useEffect(() => {
    if (committed.current || value || !detected) return;
    committed.current = true;
    onChange(detected);
  }, [value, detected, onChange]);

  return (
    <>
      <select
        id={id}
        className="input"
        value={value || detected}
        onChange={(e) => onChange(e.target.value)}
      >
        {detected && (
          <optgroup label="Detected">
            <option value={detected}>
              {detected.replace(/_/g, " ")} ({offsetLabel(detected, now)}) — yours
            </option>
          </optgroup>
        )}
        <optgroup label="All timezones">
          {zones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace(/_/g, " ")} ({offsetLabel(zone, now)})
            </option>
          ))}
        </optgroup>
      </select>
      <p className="hint mt-1">
        Sending hours are read in this zone, not the server&rsquo;s.
      </p>
    </>
  );
}
