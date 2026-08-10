export type OutfieldPosition = "DEF" | "MID" | "FWD";
export type SquadPosition = "GK" | OutfieldPosition;

/** The 3 real formations fantasy.efl.com's own team-builder offers for the
 * 6 outfield (non-GK, non-CLUB) picks - confirmed live 2026-08-08 via a
 * screenshot of their real UI, which contradicted migration 0089's original
 * "formation is fixed at 2-2-2" assumption (see EFLFantasyBoard.tsx's
 * squadShapeLabel comment). GK stays exactly 1 and CLUB stays exactly 2 in
 * every formation - neither is part of this. */
export const VALID_FORMATIONS: Record<OutfieldPosition, number>[] = [
  { DEF: 2, MID: 2, FWD: 2 },
  { DEF: 2, MID: 3, FWD: 1 },
  { DEF: 3, MID: 2, FWD: 1 },
];

export function isValidOutfieldCounts(counts: Partial<Record<OutfieldPosition, number>>): boolean {
  return VALID_FORMATIONS.some((f) => f.DEF === (counts.DEF ?? 0) && f.MID === (counts.MID ?? 0) && f.FWD === (counts.FWD ?? 0));
}

/**
 * Whether swapping a player out of `fromPos` for one at `toPos` keeps the
 * squad on one of the 3 real formations. Same position is always legal
 * (formation unchanged); GK can only swap for GK (it isn't part of
 * formation at all); a different outfield position is legal only when the
 * resulting DEF/MID/FWD split still matches one of the 3 real shapes.
 * Every pair of the 3 real formations turns out to be exactly one swap
 * apart (2-2-2 <-> 3-2-1 is FWD-out/DEF-in, 2-2-2 <-> 2-3-1 is
 * FWD-out/MID-in, 3-2-1 <-> 2-3-1 is DEF-out/MID-in), so a single transfer
 * is always enough to change formation - no multi-leg reasoning needed.
 */
export function isLegalPositionSwap(fromPos: SquadPosition, toPos: SquadPosition, currentCounts: Partial<Record<OutfieldPosition, number>>): boolean {
  if (fromPos === "GK" || toPos === "GK") return fromPos === toPos;
  if (fromPos === toPos) return true;
  const next = { ...currentCounts };
  next[fromPos] = (next[fromPos] ?? 0) - 1;
  next[toPos] = (next[toPos] ?? 0) + 1;
  return isValidOutfieldCounts(next);
}
