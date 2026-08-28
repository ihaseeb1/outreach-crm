"use client";

import type { RefObject } from "react";

/**
 * Click-to-insert merge fields.
 *
 * The variables were previously only documented in a paragraph of help text,
 * which meant retyping `{{first_name|there}}` by hand into every step — easy to
 * misspell, and a misspelled variable renders as empty rather than failing
 * loudly, so the mistake reaches the prospect.
 *
 * Inserting at the caret rather than appending matters: these get dropped into
 * the middle of a sentence far more often than at the end.
 */

export interface MergeField {
  token: string;
  label: string;
}

/**
 * first_name carries a fallback by default. A contact scraped from a generic
 * info@ address has no name, and "Hi ," is worse than "Hi there,".
 */
export const MERGE_FIELDS: MergeField[] = [
  { token: "{{first_name|there}}", label: "First name" },
  { token: "{{last_name}}", label: "Last name" },
  { token: "{{full_name}}", label: "Full name" },
  { token: "{{domain}}", label: "Domain" },
  { token: "{{website}}", label: "Website" },
  { token: "{{email}}", label: "Email" },
];

type Field = HTMLInputElement | HTMLTextAreaElement;

export function VariablePicker({
  targetRef,
  onInsert,
  fields = MERGE_FIELDS,
}: {
  targetRef: RefObject<Field | null>;
  /** Receives the whole new value, so the parent keeps owning the state. */
  onInsert: (next: string) => void;
  fields?: MergeField[];
}) {
  function insert(token: string) {
    const el = targetRef.current;
    if (!el) {
      onInsert(token);
      return;
    }

    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    onInsert(el.value.slice(0, start) + token + el.value.slice(end));

    // React re-renders with the new value first; putting the caret back has to
    // wait for that, or it lands at the end of the old string.
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + token.length;
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className="mt-1 flex flex-wrap gap-1">
      <span className="hint mr-1 self-center">Insert:</span>
      {fields.map((field) => (
        <button
          key={field.token}
          type="button"
          title={field.token}
          className="rounded border border-[var(--color-line)] px-1.5 py-0.5 text-xs text-[var(--color-brand)] hover:bg-[var(--color-canvas)]"
          onClick={() => insert(field.token)}
        >
          {field.label}
        </button>
      ))}
      {/* Spintax: each recipient gets one option at random, so no two emails are
          identical — a small, real deliverability win. */}
      <button
        type="button"
        title="Spin text — {option one|option two}. A random option is picked per recipient."
        className="rounded border border-dashed border-[var(--color-line)] px-1.5 py-0.5 text-xs text-[var(--color-muted)] hover:bg-[var(--color-canvas)]"
        onClick={() => insert("{Hi|Hello|Hey}")}
      >
        Spin text
      </button>
    </div>
  );
}
