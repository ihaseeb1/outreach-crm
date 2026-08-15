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
