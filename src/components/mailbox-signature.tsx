"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";

import {
  SOCIAL_PROFILES,
  signatureCarriesAddress,
  type SocialKey,
} from "@/mail/signature";

/**
 * Same-origin path to an icon, so next/image serves it locally rather than
 * proxying an absolute URL. The email uses the absolute form — see iconUrl in
 * mail/signature.ts — but a preview inside the app does not need it.
 */
const localIcon = (key: SocialKey) => `/signature/${key}.png`;

/**
 * Which social icons ride in the footer of this mailbox's outbound mail, and an
 * optional personal sign-off above it.
 *
 * The preview is the point of this panel. The icons go in the closing block with
 * the postal address from Settings — not under the sign-off — and the only way to
 * make that obvious was to render the block exactly as it will be sent. It shares
 * `signatureCarriesAddress` with the send path, so what it says about a sign-off
 * being skipped is what will actually happen.
 */
export function MailboxSignature({
  id,
  email,
  signature,
  socials,
  postalAddress,
}: {
  id: string;
  email: string;
  signature: string | null;
  socials: SocialKey[];
  /** `workspaces.sending_postal_address` — what the footer prints. */
  postalAddress: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(signature ?? "");
  const [selected, setSelected] = useState<SocialKey[]>(socials);
  const [applyToAll, setApplyToAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const chosen = SOCIAL_PROFILES.filter((profile) =>
    selected.includes(profile.key),
  );
  const duplicated = signatureCarriesAddress(text, postalAddress);

  function toggle(key: SocialKey) {
    setMessage(null);
    setSelected((current) =>
      current.includes(key)
        ? current.filter((item) => item !== key)
        : [...current, key],
    );
  }

  async function save() {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/mailboxes", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id,
          signature: text.trim() ? text : null,
          socials: selected,
          apply_to_all: applyToAll,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save.");
      const updated = Number(payload.updated ?? 1);
      setMessage(updated > 1 ? `Saved to ${updated} mailboxes.` : "Saved.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        className="text-xs text-[var(--color-brand)] hover:underline"
        type="button"
        onClick={() => setOpen(true)}
      >
        Email footer: {socials.length} icon{socials.length === 1 ? "" : "s"}
        {signature ? ", sign-off set" : ""} — edit
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-[var(--color-line)] p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">Email footer</p>
        <button
          className="hint hover:underline"
          type="button"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>

      <fieldset>
        <legend className="label text-xs">Social icons</legend>
        <div className="flex flex-wrap gap-3">
          {SOCIAL_PROFILES.map((profile) => (
            <label
              key={profile.key}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-[var(--color-line)] px-2 py-1.5 text-xs"
            >
              <input
                type="checkbox"
                checked={selected.includes(profile.key)}
                onChange={() => toggle(profile.key)}
              />
              <Image
                src={localIcon(profile.key)}
                alt=""
                width={16}
                height={16}
                unoptimized
              />
              {profile.label}
            </label>
          ))}
        </div>
        <p className="hint mt-1.5">
          These sit in the footer of every campaign email — under your postal
          address from Settings, above the unsubscribe line. Orankly&apos;s own
          profiles: WhatsApp <span className="font-mono">wa.me/12819694177</span>,
          LinkedIn <span className="font-mono">/company/orankly</span>, Facebook
          and Instagram <span className="font-mono">webwarner</span>. The same
          links as the footer of orankly.com.
        </p>
      </fieldset>

      <div>
        <label className="label text-xs" htmlFor={`signature-${id}`}>
          Sign-off above it (optional)
        </label>
        <textarea
          id={`signature-${id}`}
          className="input min-h-16 font-mono text-xs"
          maxLength={2000}
          placeholder={"Best,\nHaseeb"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setMessage(null);
          }}
        />
        <p className="hint mt-1">
          A personal line under the message, for when the footer alone is too
          impersonal. Leave it empty and the footer is the whole close — which is
          usually what you want, since the footer already carries the company name,
          both addresses and the phone numbers.
        </p>
        {duplicated && (
          <p className="mt-1.5 rounded-md bg-amber-50 px-2.5 py-1.5 text-xs text-[var(--color-warn)]">
            This repeats your postal address, so it will not be printed — you
            would have seen it twice. Only the footer below will show.
          </p>
        )}
      </div>

      <div>
        <p className="label text-xs">What a publisher receives at the end</p>
        <div className="rounded-md border border-[var(--color-line)] bg-white p-3">
          <p className="text-sm text-[var(--color-muted)]">…your message.</p>

          {text.trim() && !duplicated && (
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed">
              {text}
            </p>
          )}

          <div className="mt-4 border-t border-[var(--color-line)] pt-3 text-xs leading-relaxed text-[var(--color-muted)]">
            {postalAddress ? (
              <p className="whitespace-pre-wrap">{postalAddress}</p>
            ) : (
              <p className="text-[var(--color-warn)]">
                No sending postal address set — add one in Settings, or campaign
                sends stay blocked.
              </p>
            )}

            {chosen.length > 0 && (
              <div className="mt-3 flex gap-2">
                {chosen.map((profile) => (
                  <Image
                    key={profile.key}
                    src={localIcon(profile.key)}
                    alt={profile.label}
                    title={profile.label}
                    width={22}
                    height={22}
                    unoptimized
                  />
                ))}
              </div>
            )}

            <p className="mt-3">
              <span className="underline">Unsubscribe</span> — you will not be
              contacted again.
            </p>
          </div>
        </div>
        <p className="hint mt-1">
          The address and the unsubscribe link are required by CAN-SPAM and cannot
          be turned off. <strong>Every email ends with this block</strong> —
          campaign steps, follow-ups, one-off sends and warmup alike — so the
          mailbox is warmed on the same shape of message it will send for real.
          Following the opt-out link in a warmup message does nothing: one of your
          own mailboxes can never be suppressed.
        </p>
      </div>

      <label className="flex items-start gap-2 text-xs">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={applyToAll}
          onChange={(e) => {
            setApplyToAll(e.target.checked);
            setMessage(null);
          }}
        />
        <span>
          Save to every mailbox, not just {email}. Pacing and the paused flag are
          left alone.
        </span>
      </label>

      <div className="flex items-center gap-3">
        <button
          className="btn-primary px-2.5 py-1.5 text-xs"
          type="button"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {message && <span className="text-xs text-[var(--color-ok)]">{message}</span>}
        {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
      </div>
    </div>
  );
}
