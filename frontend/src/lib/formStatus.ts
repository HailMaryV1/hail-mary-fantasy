import type { FormStatus } from "./hailMaryForm";

export type FormBadge = { code: string; label: string; tone: "very_hot" | "hot" | "cold" | "very_cold"; icon: string };

// Mirrors playerStatus.ts's resolveStatusBadge lookup-table shape exactly.
// "neutral" and no-status-yet both render nothing - only a genuine hot/cold
// signal is worth a badge; a neutral player looks the same as one with too
// little data, which is the point (no false confidence either way).
const FORM_BADGES: Record<Exclude<FormStatus, "neutral">, FormBadge> = {
  very_hot: {
    code: "V.HOT",
    label: "Very hot - consistently well above Mary's expected points recently",
    tone: "very_hot",
    icon: "🔥",
  },
  hot: {
    code: "HOT",
    label: "Hot - scoring above Mary's expected points recently",
    tone: "hot",
    icon: "🔥",
  },
  cold: {
    code: "COLD",
    label: "Cold - scoring below Mary's expected points recently",
    tone: "cold",
    icon: "❄",
  },
  very_cold: {
    code: "V.COLD",
    label: "Very cold - consistently well below Mary's expected points recently",
    tone: "very_cold",
    icon: "❄",
  },
};

export function resolveFormBadge(status: FormStatus | null | undefined): FormBadge | null {
  if (!status || status === "neutral") return null;
  return FORM_BADGES[status];
}
