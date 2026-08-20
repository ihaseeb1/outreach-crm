"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { SOCIAL_PROFILES, type SocialKey } from "@/mail/signature";

/**
 * Same-origin path to an icon, so next/image serves it locally rather than
 * proxying an absolute URL. The email uses the absolute form — see iconUrl in
 * mail/signature.ts — but a preview inside the app does not need it.
 */
const localIcon = (key: SocialKey) => `/signature/${key}.png`;

/**
 * The sign-off every email from this mailbox carries, and which of Orankly's
 * social profiles ride underneath it.
 *
 * The profiles themselves are fixed (see mail/signature.ts) — the choice here is
 * only which ones appear, because the four URLs are the company's, not this
 * mailbox's. "Save to every mailbox" is the common case: one company, one
 * sign-off, seven addresses.
 */
export function MailboxSignature({
  id,
  email,
  signature,
  socials,
}: {
  id: string;
  email: string;
  signature: string | null;
  socials: SocialKey[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(signature ?? "");
  const [selected, setSelected] = useState<SocialKey[]>(socials);
  const [applyToAll, setApplyToAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
      setMessage(
        updated > 1 ? `Saved to ${updated} mailboxes.` : "Saved.",
      );
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    const summary = signature
      ? `${socials.length} icon${socials.length === 1 ? "" : "s"}`
      : "none set";
    return (
      <button
        className="text-xs text-[var(--color-brand)] hover:underline"
        type="button"
        onClick={() => setOpen(true)}
      >
        Signature: {summary} — edit
      </button>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-[var(--color-line)] p-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">Signature</p>
        <button
          className="hint hover:underline"
          type="button"
          onClick={() => setOpen(false)}
        >
          Close
        </button>
      </div>

      <div>
        <label className="label text-xs" htmlFor={`signature-${id}`}>
          Sign-off
        </label>
        <textarea
          id={`signature-${id}`}
          className="input min-h-24 font-mono text-xs"
          maxLength={2000}
          placeholder={"Haseeb Butt\nFounder, Orankly\n+1 281 969 4177\nhttps://orankly.com"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setMessage(null);
          }}
        />
        <p className="hint mt-1">
          Plain text. Line breaks are kept and any URL becomes a link.
        </p>
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
          Linking to Orankly&apos;s own profiles — WhatsApp{" "}
          <span className="font-mono">wa.me/12819694177</span>, LinkedIn{" "}
          <span className="font-mono">/company/orankly</span>, Facebook and
          Instagram <span className="font-mono">webwarner</span>. Same links as
          the footer of orankly.com.
        </p>
      </fieldset>

      {text.trim() && (
        <div>
          <p className="label text-xs">Preview</p>
          <div className="rounded-md border border-[var(--color-line)] bg-white p-3">
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{text}</p>
            {selected.length > 0 && (
              <div className="mt-3 flex gap-2">
                {SOCIAL_PROFILES.filter((profile) =>
                  selected.includes(profile.key),
                ).map((profile) => (
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
          </div>
        </div>
      )}

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

      <p className="hint">
        The icons are hosted images, so a recipient with images switched off sees
        the network names as text instead. Nothing here tracks anything — there
        is no pixel, and the URLs are the public profiles.
      </p>

      <div className="flex items-center gap-3">
        <button
          className="btn-primary px-2.5 py-1.5 text-xs"
          type="button"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save signature"}
        </button>
        {message && <span className="text-xs text-[var(--color-ok)]">{message}</span>}
        {error && <span className="text-xs text-[var(--color-danger)]">{error}</span>}
      </div>
    </div>
  );
}
