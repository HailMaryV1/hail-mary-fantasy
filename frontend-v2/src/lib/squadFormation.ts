export type SquadPosition = "GK" | "DEF" | "MID" | "FWD";
export type Formation = { GK: number; DEF: number; MID: number; FWD: number };

/** Dream Team's 7 real formations (migration 0106's game_formations,
 * uses_formations=true, no-bench 11-a-side - see game_squad_rules) -
 * every squad member always starts, so these 7 shapes are the only
 * legal DEF/MID/FWD/GK splits for the whole 11, not just a starting XI
 * chosen from a bigger bench. Cloud FF shares this exact same list
 * (confirmed live via game_formations) but isn't wired to it yet. */
export const DREAMTEAM_FORMATIONS: Formation[] = [
  { GK: 1, DEF: 4, MID: 4, FWD: 2 },
  { GK: 1, DEF: 4, MID: 3, FWD: 3 },
  { GK: 1, DEF: 4, MID: 5, FWD: 1 },
  { GK: 1, DEF: 3, MID: 4, FWD: 3 },
  { GK: 1, DEF: 3, MID: 5, FWD: 2 },
  { GK: 1, DEF: 5, MID: 4, FWD: 1 },
  { GK: 1, DEF: 5, MID: 3, FWD: 2 },
];

/**
 * 2026-08-20 user report: selling a MID and a FWD then trying to buy a
 * DEF was blocked outright ("won't let me bring in a 6m player until
 * I've brought a 3m-or-less player first") - the transfer board required
 * every replacement to match its specific outgoing player's OWN position,
 * so cross-position swaps (moving from one legal formation to another,
 * e.g. 4-4-2 -> 3-4-3) were never possible at all, no matter the price.
 * Mirrors eflFormation.ts's isLegalPositionSwap, generalized from a
 * single 1-for-1 swap to N simultaneous pending sales sharing one pot:
 * a candidate is legal for "some currently-open slot" if committing to
 * its position still leaves at least one of `validFormations` reachable
 * once the OTHER still-open slots (whatever positions they end up being)
 * are filled too - not tied to which specific slot it lands in.
 *
 * `keptCounts` - the part of the squad NOT being sold (unaffected by
 * this transfer batch either way). `stagedCounts` - positions of picks
 * already confirmed into this batch's other slots so far. `totalOpenSlots`
 * - how many sold slots have no pick yet, INCLUDING the one this
 * candidate would fill (so it's always >= 1 when this is called).
 */
export function isLegalFormationPick(
  keptCounts: Formation,
  stagedCounts: Formation,
  incomingPosition: SquadPosition,
  totalOpenSlots: number,
  validFormations: Formation[]
): boolean {
  const next: Formation = {
    GK: keptCounts.GK + stagedCounts.GK,
    DEF: keptCounts.DEF + stagedCounts.DEF,
    MID: keptCounts.MID + stagedCounts.MID,
    FWD: keptCounts.FWD + stagedCounts.FWD,
  };
  next[incomingPosition] += 1;
  const remainingAfter = totalOpenSlots - 1;
  return validFormations.some((f) => {
    if (f.GK < next.GK || f.DEF < next.DEF || f.MID < next.MID || f.FWD < next.FWD) return false;
    const gap = f.GK - next.GK + (f.DEF - next.DEF) + (f.MID - next.MID) + (f.FWD - next.FWD);
    return gap === remainingAfter;
  });
}

export function countByPosition(players: { position: SquadPosition | "CLUB" }[]): Formation {
  const counts: Formation = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  for (const p of players) {
    if (p.position === "GK" || p.position === "DEF" || p.position === "MID" || p.position === "FWD") counts[p.position] += 1;
  }
  return counts;
}
