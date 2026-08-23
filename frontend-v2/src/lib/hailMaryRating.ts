// Hail Mary Rating - the 1-10 within-position/gameweek/game percentile
// rating computed by scripts/compute_projections.py (see assign_ratings/
// write_ratings), stored as projections.hail_mary_rating and threaded
// through game_player_pool/player_projection_summary/search_game_player_
// pool (migration 0135). This is the ONLY place a player's projected
// quality should be shown to a user going forward - raw hail_mary_score
// stays a backend-only value (still drives this rating and can still
// break ties, but is never displayed again). Same shape/tone convention
// as formStatus.ts's FormBadge - a 5-band qualitative label layered on
// top of the raw number, tone classes matching confidenceTone/
// dataSourceTone's existing bg-{color}-950 text-{color}-400 pattern.

export type RatingTier = { label: string; toneClass: string };

const TIER_BY_MIN_RATING: { min: number; label: string; toneClass: string }[] = [
  { min: 10, label: "Nailed On", toneClass: "bg-emerald-950 text-emerald-400" },
  { min: 8, label: "Strong Pick", toneClass: "bg-teal-950 text-teal-400" },
  { min: 6, label: "Solid Option", toneClass: "bg-sky-950 text-sky-400" },
  { min: 4, label: "Fringe Pick", toneClass: "bg-amber-950 text-amber-400" },
  { min: 1, label: "Longshot", toneClass: "bg-red-950 text-red-400" },
];

export function formatRating(rating: number | null | undefined): string {
  if (rating == null) return "—";
  return String(Math.round(rating));
}

export function ratingTier(rating: number | null | undefined): RatingTier | null {
  if (rating == null) return null;
  const tier = TIER_BY_MIN_RATING.find((t) => rating >= t.min);
  return tier ? { label: tier.label, toneClass: tier.toneClass } : null;
}
