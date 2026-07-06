export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

const tones: Record<StatusTone, string> = {
  success: "bg-emerald-50 text-success border-success/40",
  warning: "bg-amber-50 text-warning border-warning/40",
  danger: "bg-red-50 text-danger border-danger/40",
  info: "bg-cyan-50 text-link border-link/40",
  neutral: "bg-gray-100 text-gray-700 border-gray-300",
};

export default function StatusBadge({
  tone,
  label,
}: {
  tone: StatusTone;
  label: string;
}) {
  return (
    <span
      className={
        "inline-flex items-center rounded-sm border px-2 py-0.5 text-xs font-medium " +
        tones[tone]
      }
    >
      {label}
    </span>
  );
}
