import type { Formation } from "@/lib/squadOptimizer";

export type AutoSubPlayer = {
  gamePlayerId: number;
  position: "GK" | "DEF" | "MID" | "FWD";
  score: number;
  // 0-1 chance this player actually features - the same real-world
  // meaning as compute_projections.py's status_multiplier (lineup
  // likelihood x injury/suspension availability), mirrored client-side
  // by lib/playerStatus.ts's LINEUP_SECURITY_SCORES x
  // INJURY_AVAILABILITY_SCORES. Defaults to 1 (nailed on) wherever no
  // real lineup/status signal exists yet (pre-season, or any gameweek
  // other than the currently-editable one - FanTeam only ever exposes
  // live status for that single gameweek).
  survivalProbability: number;
};

function countsFor(players: { position: string }[]): Record<string, number> {
  const counts: Record<string, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
  players.forEach((p) => (counts[p.position] = (counts[p.position] ?? 0) + 1));
  return counts;
}

function isLegalFormation(counts: Record<string, number>, formations: Formation[]): boolean {
  return formations.some(
    (f) => f.gk_count === counts.GK && f.def_count === counts.DEF && f.mid_count === counts.MID && f.fwd_count === counts.FWD
  );
}

/**
 * The realized expected total for a chosen starting XI, accounting for
 * FanTeam's real auto-substitution rule: if a starter doesn't feature,
 * the highest-priority bench player who still leaves a legal formation
 * comes on automatically - if the top reserve doesn't fit, the next one
 * is tried, and so on; if none fit, that slot simply scores 0 (nobody
 * covers them). Blends each starter's own score with their eventual
 * replacement's score, weighted by survivalProbability - a nailed-on
 * starter (p=1) contributes their own score unchanged; one confirmed out
 * (p=0) contributes entirely from whichever bench player covers them.
 *
 * One level deep by design, matching the real rule as described rather
 * than an invented probabilistic chain: only formation legality decides
 * whether reserve 1, 2, or 3 comes on - a substitute's OWN chance of
 * featuring isn't itself factored in (FanTeam doesn't chain subs either).
 * Goalkeepers only ever sub for goalkeepers - the reserve GK is a single
 * fixed slot, never drawn from the outfield bench or vice versa.
 */
export function computeAutoSubAwareTotal(
  starters: AutoSubPlayer[],
  reserveGK: AutoSubPlayer | null,
  outfieldBenchInOrder: AutoSubPlayer[],
  formations: Formation[]
): number {
  let total = 0;
  for (const starter of starters) {
    const baseCounts = countsFor(starters.filter((p) => p.gamePlayerId !== starter.gamePlayerId));

    let subScore = 0;
    if (starter.survivalProbability < 1) {
      const candidates = starter.position === "GK" ? (reserveGK ? [reserveGK] : []) : outfieldBenchInOrder;
      for (const cand of candidates) {
        const counts = { ...baseCounts, [cand.position]: (baseCounts[cand.position] ?? 0) + 1 };
        if (isLegalFormation(counts, formations)) {
          subScore = cand.score;
          break;
        }
      }
    }

    total += starter.survivalProbability * starter.score + (1 - starter.survivalProbability) * subScore;
  }
  return total;
}
