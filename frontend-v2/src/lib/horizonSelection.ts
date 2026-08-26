// The 4 horizons a player can be judged over (2026-08-23 user request) -
// 1 keeps using the EXISTING Hail Mary Rating as its ranking signal (see
// get_top_target_score_players' own docstring); 2/3/5 rank by the new
// Target Score composite instead.
export const HORIZONS = [1, 2, 3, 5];

// "Live Gameweek" - a 5th, separate tab (2026-08-26 user request: "just
// for info purposes on what mary predicted the best players where and
// whats actually happening") - not a real horizon value in target_scores
// (still uses horizon=1's own data), just a different ANCHOR (the live
// gameweek itself, never browsable) plus a real actual-result overlay.
export type HorizonSelection = number | "live";

export function parseHorizon(param: string | undefined): HorizonSelection {
  if (param === "live") return "live";
  const n = Number(param);
  return HORIZONS.includes(n) ? n : 1;
}
