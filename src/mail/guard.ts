import type { SupabaseClient } from "@supabase/supabase-js";
import validator from "validator";

import { normalizeEmail } from "@/lib/email";
import { isDisposableDomain } from "@/validation/disposable";

/**
 * THE send guard.
 *
 * Section 4 of the spec is enforced here and nowhere else: every outbound
 * message — campaign step, one-off send, warmup peer mail — must pass through
 * canSend() before a transport is opened. Adding a new send path means calling
 * this function; there is no second implementation of these rules.
 */

export type SendKind = "campaign" | "warmup" | "manual";

export type BlockCode =
  | "empty"
  | "invalid_syntax"
  | "disposable"
  | "suppressed"
  | "bounced"
  | "missing_postal_address"
  | "mailbox_inactive"
  | "mailbox_unhealthy"
  | "daily_limit_reached";

export type SendDecision =
  | { allowed: true; email: string }
  | { allowed: false; email: string; code: BlockCode; reason: string };

export interface CanSendOptions {
  /** Campaign mail must carry a postal address; warmup peer mail need not. */
  kind?: SendKind;
  /** Pre-fetched to avoid a query per recipient inside batch jobs. */
  postalAddress?: string | null;
  /** Pre-fetched suppression set for batch sends. */
  suppressed?: Set<string>;
}

function block(email: string, code: BlockCode, reason: string): SendDecision {
  return { allowed: false, email, code, reason };
}

export async function canSend(
  supabase: SupabaseClient,
  workspaceId: string,
  rawEmail: string,
  options: CanSendOptions = {},
): Promise<SendDecision> {
  const kind = options.kind ?? "campaign";
  const email = normalizeEmail(rawEmail);

  if (!email) return block(email, "empty", "No recipient address.");

  if (!validator.isEmail(email)) {
    return block(email, "invalid_syntax", "Address failed syntax validation.");
  }

  if (isDisposableDomain(email)) {
    return block(email, "disposable", "Address is on a disposable-domain list.");
  }

  // Suppression list — the hard stop. Never emailed again, in any campaign,
  // including warmup.
  if (options.suppressed) {
    if (options.suppressed.has(email)) {
      return block(email, "suppressed", "Address is on the suppression list.");
    }
  } else {
    const { data } = await supabase
      .from("suppressions")
      .select("reason")
      .eq("workspace_id", workspaceId)
      .eq("email", email)
      .limit(1)
      .maybeSingle();
    if (data) {
      const reason = (data as { reason: string }).reason;
      return block(
        email,
        reason === "hard_bounce" ? "bounced" : "suppressed",
        `Address is suppressed (${reason}).`,
      );
    }
  }

  // CAN-SPAM: a campaign email without a postal address must never leave.
  if (kind === "campaign") {
    let postal = options.postalAddress;
    if (postal === undefined) {
      const { data } = await supabase
        .from("workspaces")
        .select("sending_postal_address")
        .eq("id", workspaceId)
        .single();
      postal = (data as { sending_postal_address: string | null } | null)
        ?.sending_postal_address ?? null;
    }
    if (!postal || postal.trim().length === 0) {
      return block(
        email,
        "missing_postal_address",
        "Set a sending postal address in Settings before sending campaigns (CAN-SPAM).",
      );
    }
  }

  return { allowed: true, email };
}

/** Throwing variant for call sites where a block is a programming error. */
export async function assertCanSend(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string,
  options: CanSendOptions = {},
): Promise<string> {
  const decision = await canSend(supabase, workspaceId, email, options);
  if (!decision.allowed) {
    throw new Error(`Send blocked (${decision.code}): ${decision.reason}`);
  }
  return decision.email;
}
