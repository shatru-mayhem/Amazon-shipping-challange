import type { PipelineStage } from "@/lib/mock-data";
import StatusBadge, { type StatusTone } from "@/components/StatusBadge";

const stateMeta: Record<
  PipelineStage["state"],
  { tone: StatusTone; label: string }
> = {
  complete: { tone: "success", label: "Complete" },
  active: { tone: "info", label: "In progress" },
  approval: { tone: "warning", label: "Approval required" },
  issue: { tone: "danger", label: "Issue flagged" },
  pending: { tone: "neutral", label: "Pending" },
};

export default function PipelineView({ stages }: { stages: PipelineStage[] }) {
  return (
    <ol className="space-y-2">
      {stages.map((s, i) => {
        const meta = stateMeta[s.state];
        return (
          <li
            key={s.id}
            className="flex items-start gap-3 rounded-sm border border-border bg-surface p-3"
          >
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-navy text-xs font-bold text-white">
              {i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{s.label}</span>
                <StatusBadge tone={meta.tone} label={meta.label} />
              </div>
              {s.note ? (
                <p className="mt-1 text-xs text-gray-600">{s.note}</p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
