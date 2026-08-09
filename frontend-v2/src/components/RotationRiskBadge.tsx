import { resolveRotationRiskBadge } from "@/lib/rotationRisk";
import type { RotationRiskInfo } from "@/lib/rotationRisk";

const TONE_CLASSES = {
  green: "bg-emerald-950 text-emerald-400",
  amber: "bg-amber-950 text-amber-400",
  red: "bg-red-950 text-red-400",
  gray: "bg-navy-800 text-navy-400",
} as const;

export default function RotationRiskBadge({ risk }: { risk?: RotationRiskInfo | null }) {
  const badge = resolveRotationRiskBadge(risk);
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
