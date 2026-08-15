"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface EditableStep {
  delay_days: number;
  subject_template: string;
  body_template: string;
  reply_to_thread: boolean;
}

const BLANK_STEP: EditableStep = {
  delay_days: 3,
  subject_template: "",
  body_template: "Hi {{first_name|there}},\n\n\n\nThanks,\n",
  reply_to_thread: true,
};

/**
 * Edits the whole sequence at once and saves it in one request.
 * Step 1 always goes out immediately and always starts a new thread.
 */
export function SequenceEditor({
  campaignId,
  initialSteps,
}: {
  campaignId: string;
  initialSteps: EditableStep[];
}) {
  const router = useRouter();
  const [steps, setSteps] = useState<EditableStep[]>(
    initialSteps.length > 0 ? initialSteps : [{ ...BLANK_STEP, delay_days: 0 }],
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function update(index: number, patch: Partial<EditableStep>) {
    setSteps((current) =>
      current.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    );
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/campaigns/steps", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ campaign_id: campaignId, steps }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save.");
      setSaved(true);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card card-pad space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Sequence</h2>
        <span className="hint">{steps.length} step(s)</span>
      </div>

      {steps.map((step, index) => (
        <div
          key={index}
          className="space-y-3 rounded-md border border-[var(--color-line)] p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Step {index + 1}</h3>
            <div className="flex items-center gap-3">
              {index > 0 && (
                <>
                  <label className="hint flex items-center gap-1.5">
                    Wait
                    <input
                      className="input w-16 px-2 py-1"
                      type="number"
                      min={0}
                      max={365}
                      value={step.delay_days}
                      onChange={(e) =>
                        update(index, { delay_days: Number(e.target.value) })
                      }
                    />
                    days
                  </label>
                  <label className="hint flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={step.reply_to_thread}
                      onChange={(e) =>
                        update(index, { reply_to_thread: e.target.checked })
                      }
                    />
                    Reply in thread
                  </label>
                </>
              )}
              {steps.length > 1 && (
                <button
                  className="hint text-[var(--color-danger)] hover:underline"
                  type="button"
                  onClick={() => {
                    setSteps((current) => current.filter((_, i) => i !== index));
                    setSaved(false);
                  }}
                >
                  Remove
                </button>
              )}
            </div>
          </div>

          {(index === 0 || !step.reply_to_thread) && (
            <div>
              <label className="label" htmlFor={`subject-${index}`}>
                Subject
              </label>
              <input
                id={`subject-${index}`}
                className="input"
                value={step.subject_template}
                onChange={(e) =>
                  update(index, { subject_template: e.target.value })
                }
              />
            </div>
          )}

          {index > 0 && step.reply_to_thread && (
            <p className="hint">
              Threads under step 1 as <code>Re: …</code>, so no subject needed.
            </p>
          )}

          <div>
            <label className="label" htmlFor={`body-${index}`}>
              Body
            </label>
            <textarea
              id={`body-${index}`}
              className="input min-h-40"
              value={step.body_template}
              onChange={(e) => update(index, { body_template: e.target.value })}
            />
          </div>
        </div>
      ))}

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="btn-secondary"
          type="button"
          disabled={steps.length >= 10}
          onClick={() => {
            setSteps((current) => [...current, { ...BLANK_STEP }]);
            setSaved(false);
          }}
        >
          Add step
        </button>
        <button className="btn-primary" type="button" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save sequence"}
        </button>
        {saved && <span className="hint text-[var(--color-ok)]">Saved.</span>}
        {error && <span className="text-sm text-[var(--color-danger)]">{error}</span>}
      </div>

      <p className="hint">
        Variables: {"{{first_name}}"}, {"{{last_name}}"}, {"{{full_name}}"},{" "}
        {"{{domain}}"}, {"{{website}}"}, {"{{email}}"}. Fallbacks with a pipe:{" "}
        <code>{"{{first_name|there}}"}</code>. Your postal address and an
        unsubscribe link are appended automatically.
      </p>
    </section>
  );
}
