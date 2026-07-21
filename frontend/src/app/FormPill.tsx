import { resolveFormBadge } from "@/lib/formStatus";
import type { FormStatus } from "@/lib/hailMaryForm";

// Mirrors StatusPill.tsx exactly - same plain-HTML `title` tooltip
// convention used everywhere else in this app (no tooltip library exists
// or is needed).
const TONE_CLASSES = {
  very_hot: "bg-red-950 text-red-400",
  hot: "bg-amber-950 text-amber-400",
  cold: "bg-sky-950 text-sky-400",
  very_cold: "bg-indigo-950 text-indigo-400",
} as const;

export default function FormPill({ status }: { status?: FormStatus | null }) {
  const badge = resolveFormBadge(status);
  if (!badge) return null;
  return (
    <span
      title={badge.label}
      className={`ml-1.5 inline-block shrink-0 rounded px-1 py-0.5 text-[10px] font-bold ${TONE_CLASSES[badge.tone]}`}
    >
      {badge.icon}
    </span>
  );
}
