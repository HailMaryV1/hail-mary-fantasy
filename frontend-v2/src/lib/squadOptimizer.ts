export type Formation = { code: string; gk_count: number; def_count: number; mid_count: number; fwd_count: number };

/**
 * Best starting XI for one set of scores: since every slot within a
 * position is interchangeable, taking the top `quota[pos]` scorers per
 * position is provably optimal for a fixed formation - no search needed.
 * Comparing the summed total across every formation (there are only a
 * handful) then finds the best formation too.
 */
export function suggestBestXI(
  players: { game_player_id: number; position: "GK" | "DEF" | "MID" | "FWD"; score: number }[],
  formations: Formation[]
): { formationCode: string; startingGamePlayerIds: number[]; total: number } | null {
  const byPosition: Record<string, typeof players> = { GK: [], DEF: [], MID: [], FWD: [] };
  players.forEach((p) => byPosition[p.position].push(p));
  Object.values(byPosition).forEach((list) => list.sort((a, b) => b.score - a.score));

  let best: { formationCode: string; startingGamePlayerIds: number[]; total: number } | null = null;
  for (const f of formations) {
    const quota = { GK: f.gk_count, DEF: f.def_count, MID: f.mid_count, FWD: f.fwd_count };
    const picks: number[] = [];
    let total = 0;
    let feasible = true;
    for (const pos of ["GK", "DEF", "MID", "FWD"] as const) {
      const need = quota[pos];
      const available = byPosition[pos];
      if (available.length < need) {
        feasible = false;
        break;
      }
      for (let i = 0; i < need; i++) {
        picks.push(available[i].game_player_id);
        total += available[i].score;
      }
    }
    if (feasible && (best === null || total > best.total)) {
      best = { formationCode: f.code, startingGamePlayerIds: picks, total };
    }
  }
  return best;
}
