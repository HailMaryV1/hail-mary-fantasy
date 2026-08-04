// Standalone here (not imported from a hailMaryForm.ts module) since
// frontend-v2 doesn't have a Hail Mary Form capture pipeline page yet -
// this is just the badge-rendering shape, same 5-value union as the
// original frontend's hailMaryForm.ts.
export type FormStatus = "very_hot" | "hot" | "neutral" | "cold" | "very_cold";

export type FormBadge = { code: string; label: string; tone: "very_hot" | "hot" | "cold" | "very_cold"; icon: string };

const FORM_BADGES: Record<Exclude<FormStatus, "neutral">, FormBadge> = {
  very_hot: { code: "V.HOT", label: "Very hot - consistently well above Mary's expected points recently", tone: "very_hot", icon: "🔥" },
  hot: { code: "HOT", label: "Hot - scoring above Mary's expected points recently", tone: "hot", icon: "🔥" },
  cold: { code: "COLD", label: "Cold - scoring below Mary's expected points recently", tone: "cold", icon: "❄" },
  very_cold: { code: "V.COLD", label: "Very cold - consistently well below Mary's expected points recently", tone: "very_cold", icon: "❄" },
};

export function resolveFormBadge(status: FormStatus | null | undefined): FormBadge | null {
  if (!status || status === "neutral") return null;
  return FORM_BADGES[status];
}
