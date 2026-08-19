import { resolveStatusBadge } from "@/lib/playerStatus";

const TONE_CLASSES = {
  green: "bg-emerald-950 text-emerald-400",
  amber: "bg-amber-950 text-amber-400",
  red: "bg-red-950 text-red-400",
  gray: "bg-navy-800 text-navy-400",
} as const;

export default function StatusPill({
  lineup,
  status,
  ffscoutStatus,
  ffscoutStartProbability,
}: {
  lineup?: string | null;
  status?: string | null;
  ffscoutStatus?: string | null;
  ffscoutStartProbability?: number | null;
}) {
  const badge = resolveStatusBadge(lineup ?? null, status ?? null, ffscoutStatus ?? null, ffscoutStartProbability ?? null);
  if (!badge) return null;
  return (
    <span
      title={badge.label}
      className={`ml-1.5 inline-block shrink-0 rounded px-1 py-0.5 text-[9px] font-bold uppercase tracking-wide ${TONE_CLASSES[badge.tone]}`}
    >
      {badge.code}
    </span>
  );
}
