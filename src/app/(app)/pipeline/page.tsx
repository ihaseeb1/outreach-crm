import { PipelineBoard, type BoardCard, type BoardStage } from "@/components/pipeline-board";
import { PipelineEditor, type EditableStage } from "@/components/pipeline-editor";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireSession } from "@/lib/workspace";
import type { PipelineStage } from "@/types/db";

export const dynamic = "force-dynamic";

const BOARD_LIMIT = 400;

export default async function PipelinePage() {
  const session = await requireSession();
  const supabase = await createSupabaseServerClient();

  const { data: stageRows } = await supabase
    .from("pipeline_stages")
    .select("*")
    .eq("workspace_id", session.workspace.id)
    .order("position", { ascending: true });

  const stages = (stageRows ?? []) as PipelineStage[];

  const { data: contactRows } = await supabase
    .from("contacts")
    .select("id, email, domain, first_name, last_name, pipeline_stage")
    .eq("workspace_id", session.workspace.id)
    .order("updated_at", { ascending: false })
    .limit(BOARD_LIMIT);

  const contacts = (contactRows ?? []) as {
    id: string;
    email: string;
    domain: string | null;
    first_name: string | null;
    last_name: string | null;
    pipeline_stage: string;
  }[];

  const contactIds = contacts.map((contact) => contact.id);

  const [{ data: conversationRows }, { data: dealRows }] = await Promise.all([
    contactIds.length
      ? supabase
          .from("conversations")
          .select("contact_id, last_message_at")
          .in("contact_id", contactIds)
      : Promise.resolve({ data: [] }),
    contactIds.length
      ? supabase.from("deals").select("contact_id").in("contact_id", contactIds)
      : Promise.resolve({ data: [] }),
  ]);

  const lastMessage = new Map(
    ((conversationRows ?? []) as { contact_id: string; last_message_at: string }[]).map(
      (row) => [row.contact_id, row.last_message_at],
    ),
  );
  const withDeals = new Set(
    ((dealRows ?? []) as { contact_id: string | null }[])
      .map((row) => row.contact_id)
      .filter((id): id is string => Boolean(id)),
  );

  const boardStages: BoardStage[] = stages.map((stage) => ({
    key: stage.key,
    label: stage.label,
    color: stage.color,
  }));

  const firstStage = boardStages[0]?.key ?? "new";
  const knownStages = new Set(boardStages.map((stage) => stage.key));

  const cards: BoardCard[] = contacts.map((contact) => ({
    id: contact.id,
    email: contact.email,
    domain: contact.domain,
    name: [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null,
    // A contact whose stage no longer exists still has to be visible somewhere.
    pipeline_stage: knownStages.has(contact.pipeline_stage)
      ? contact.pipeline_stage
      : firstStage,
    last_message_at: lastMessage.get(contact.id) ?? null,
    has_deal: withDeals.has(contact.id),
  }));

  // The automatic transitions target these stage keys specifically (see
  // campaigns/run.ts and mail/inbound.ts), so label them from the live config
  // rather than hardcoding "New" / "Contacted" in the copy below.
  const labelFor = (key: string, fallback: string) =>
    stages.find((stage) => stage.key === key)?.label ?? fallback;
  const firstLabel = labelFor("new", "New");
  const contactedLabel = labelFor("contacted", "Contacted");
  const repliedLabel = labelFor("replied", "Replied");
  const wonLabels = stages.filter((stage) => stage.is_won).map((stage) => stage.label);
  const lostLabels = stages.filter((stage) => stage.is_lost).map((stage) => stage.label);

  const editable: EditableStage[] = stages.map((stage) => ({
    key: stage.key,
    label: stage.label,
    color: stage.color,
    is_won: stage.is_won,
    is_lost: stage.is_lost,
  }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Pipeline</h1>
          <p className="hint mt-1">
            Drag a contact between stages. Showing the {BOARD_LIMIT} most recently
            updated.
          </p>
        </div>
        <PipelineEditor initial={editable} />
      </div>

      <div className="card card-pad space-y-2 text-sm">
        <h2 className="text-sm font-semibold">What moves on its own</h2>
        <ul className="ml-4 list-disc space-y-1 text-[var(--color-muted)]">
          <li>
            <strong className="text-[var(--color-ink)]">{firstLabel} → {contactedLabel}</strong>{" "}
            the moment the first campaign email is sent to that contact.
          </li>
          <li>
            <strong className="text-[var(--color-ink)]">{contactedLabel} → {repliedLabel}</strong>{" "}
            the moment a genuine reply is received. Out-of-office autoresponders
            and bounces do not count and do not move the card.
          </li>
          <li>
            Everything after that is yours to set by hand — the app cannot tell
            negotiating from agreed by reading an email.
          </li>
        </ul>
        {(wonLabels.length > 0 || lostLabels.length > 0) && (
          <p className="rounded-md bg-[var(--color-canvas)] px-3 py-2 text-xs">
            Dropping a card into{" "}
            {[...wonLabels, ...lostLabels].map((label, index, all) => (
              <span key={label}>
                <strong>{label}</strong>
                {index < all.length - 2 ? ", " : index === all.length - 2 ? " or " : ""}
              </span>
            ))}{" "}
            stops every follow-up already queued for that contact.
            {lostLabels.length > 0 && (
              <>
                {" "}
                A{" "}
                {lostLabels.map((label) => (
                  <strong key={label}>{label}</strong>
                ))}{" "}
                move also suppresses the address, so no future campaign can
                re-pitch them.
              </>
            )}
          </p>
        )}
      </div>

      {boardStages.length === 0 ? (
        <p className="card card-pad text-sm text-[var(--color-muted)]">
          No pipeline stages configured.
        </p>
      ) : (
        <PipelineBoard stages={boardStages} cards={cards} />
      )}
    </div>
  );
}
