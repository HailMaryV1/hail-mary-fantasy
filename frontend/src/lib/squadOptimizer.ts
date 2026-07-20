export type Formation = { code: string; gk_count: number; def_count: number; mid_count: number; fwd_count: number };

/**
 * Best starting XI for one set of scores: since every slot within a
 * position is interchangeable, taking the top `quota[pos]` scorers per
 * position is provably optimal for a fixed formation - no search needed.
 * Comparing the summed total across every formation (there are only a
 * handful) then finds the best formation too. Shared between the lineup
 * page's "Auto-fill optimal XI" button and squad creation/editing (which
 * needs SOME starting/bench split to save, not just a legal 15).
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

export type OptimizerPlayer = {
  gamePlayerId: number;
  position: "GK" | "DEF" | "MID" | "FWD";
  teamId: number;
  price: number;
  score: number;
};

export type OptimizerQuota = { GK: number; DEF: number; MID: number; FWD: number };

const POSITIONS = ["GK", "DEF", "MID", "FWD"] as const;

/**
 * Budget/club-limit-feasible squad builder that maximizes total score.
 * Not a proven-optimal solve (true optimal is a multi-dimensional
 * knapsack - budget + fixed per-position quota + per-club cap - which
 * doesn't decompose cleanly enough for a small hand-rolled solver) but a
 * strong, fast, explainable greedy: start from the single best scorer
 * for every quota slot ignoring cost, then repeatedly downgrade whichever
 * player loses the LEAST score per pound freed until the squad actually
 * fits the budget and club limit.
 */
export function autoFillBestSquad(
  pool: OptimizerPlayer[],
  quota: OptimizerQuota,
  budget: number,
  maxPerClub: number | null
): number[] {
  const byPosition: Record<(typeof POSITIONS)[number], OptimizerPlayer[]> = { GK: [], DEF: [], MID: [], FWD: [] };
  for (const p of pool) byPosition[p.position].push(p);
  for (const pos of POSITIONS) byPosition[pos].sort((a, b) => b.score - a.score);

  let selected: OptimizerPlayer[] = [];
  for (const pos of POSITIONS) {
    selected.push(...byPosition[pos].slice(0, quota[pos]));
  }

  function clubCounts(list: OptimizerPlayer[]) {
    const m = new Map<number, number>();
    for (const p of list) m.set(p.teamId, (m.get(p.teamId) ?? 0) + 1);
    return m;
  }

  function totalPrice(list: OptimizerPlayer[]) {
    return list.reduce((s, p) => s + p.price, 0);
  }

  // Club-limit violations first - swap the weakest offending player for
  // the best available same-position alternative from a club with room.
  if (maxPerClub) {
    let guard = 0;
    while (guard++ < 200) {
      const counts = clubCounts(selected);
      const violating = Array.from(counts.entries()).find(([, c]) => c > maxPerClub);
      if (!violating) break;
      const [clubId] = violating;
      const offenders = selected.filter((p) => p.teamId === clubId).sort((a, b) => a.score - b.score);
      const worst = offenders[0];
      const ids = new Set(selected.map((p) => p.gamePlayerId));
      const withoutWorst = selected.filter((p) => p.gamePlayerId !== worst.gamePlayerId);
      const countsWithoutWorst = clubCounts(withoutWorst);
      const replacement = byPosition[worst.position].find(
        (cand) => !ids.has(cand.gamePlayerId) && (countsWithoutWorst.get(cand.teamId) ?? 0) < maxPerClub
      );
      if (!replacement) break; // no legal replacement available - leave as-is rather than loop forever
      selected = withoutWorst.concat(replacement);
    }
  }

  // Then budget - repeatedly downgrade whichever single swap loses the
  // least score per pound saved, until affordable.
  let guard = 0;
  while (totalPrice(selected) > budget && guard++ < 400) {
    const ids = new Set(selected.map((p) => p.gamePlayerId));
    let bestSwap: { out: OptimizerPlayer; in: OptimizerPlayer; ratio: number } | null = null;

    for (const out of selected) {
      const countsWithoutOut = clubCounts(selected.filter((p) => p.gamePlayerId !== out.gamePlayerId));
      for (const cand of byPosition[out.position]) {
        if (ids.has(cand.gamePlayerId)) continue;
        if (cand.price >= out.price) continue;
        if (maxPerClub && (countsWithoutOut.get(cand.teamId) ?? 0) >= maxPerClub) continue;
        const priceSaved = out.price - cand.price;
        const scoreLost = out.score - cand.score;
        const ratio = scoreLost / priceSaved; // lower is better
        if (!bestSwap || ratio < bestSwap.ratio) bestSwap = { out, in: cand, ratio };
      }
    }

    if (!bestSwap) break; // budget infeasible with this pool - stop rather than loop forever
    selected = selected.filter((p) => p.gamePlayerId !== bestSwap!.out.gamePlayerId).concat(bestSwap.in);
  }

  return selected.map((p) => p.gamePlayerId);
}
