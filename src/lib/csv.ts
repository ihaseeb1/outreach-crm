/**
 * Tiny generic CSV helper for client-side table exports.
 *
 * `toCsv` is pure (RFC-4180 quoting) and unit-tested; `downloadCsv` wraps it in
 * a browser Blob download and is only ever called from a client component.
 */

export type CsvValue = string | number | boolean | null | undefined;

function escape(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  return [
    headers.map(escape).join(","),
    ...rows.map((row) => row.map(escape).join(",")),
  ].join("\r\n");
}

/** Triggers a client-side download of the rows as a CSV file. */
export function downloadCsv(filename: string, headers: string[], rows: CsvValue[][]): void {
  const csv = toCsv(headers, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
