/**
 * Saved reply snippets for the inbox.
 *
 * Stored on `workspaces.settings.reply_templates` — a jsonb column that already
 * exists — so there is no migration to run by hand. Kept small and plain: a
 * name and a body. Merge fields are not expanded here; a reply is edited before
 * it is sent, so a template is a starting point, not a mail merge.
 */

export interface ReplyTemplate {
  id: string;
  name: string;
  body: string;
}

const MAX_TEMPLATES = 50;
const MAX_NAME = 80;
const MAX_BODY = 8000;

/** Reads and validates the templates out of a workspace `settings` object. */
export function readReplyTemplates(
  settings: Record<string, unknown> | null | undefined,
): ReplyTemplate[] {
  const raw = (settings as { reply_templates?: unknown } | null | undefined)
    ?.reply_templates;
  if (!Array.isArray(raw)) return [];

  const out: ReplyTemplate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const name = typeof row.name === "string" ? row.name.slice(0, MAX_NAME) : "";
    const body = typeof row.body === "string" ? row.body.slice(0, MAX_BODY) : "";
    if (!id || !name || !body) continue;
    out.push({ id, name, body });
    if (out.length >= MAX_TEMPLATES) break;
  }
  return out;
}

export const REPLY_TEMPLATE_LIMITS = { MAX_TEMPLATES, MAX_NAME, MAX_BODY };
