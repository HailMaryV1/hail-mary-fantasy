// NFL FanTeam's squad has no bench and no formation choice (always exactly
// 1 QB / 2 RB / 4 WR / 1 TE / 1 DST, every rostered player a starter - see
// game_squad_rules for the nfl-fanteam row) - so unlike squadOptimizer.ts
// there's no separate "pick a starting XI from within a bigger squad" step,
// just one auto-fill. Same budget/club-limit greedy-swap approach as
// autoFillBestSquad, adapted to NFL's five position groups.

export type NflOptimizerPlayer = {
  gamePlayerId: number;
  position: "QB" | "RB" | "WR" | "TE" | "DST";
  teamId: number;
  price: number;
  score: number;
};

export type NflOptimizerQuota = { QB: number; RB: number; WR: number; TE: number; DST: number };

const POSITIONS = ["QB", "RB", "WR", "TE", "DST"] as const;

export function autoFillNflSquad(
  pool: NflOptimizerPlayer[],
  quota: NflOptimizerQuota,
  budget: number,
  maxPerClub: number | null
): number[] {
  const byPosition: Record<(typeof POSITIONS)[number], NflOptimizerPlayer[]> = {
    QB: [], RB: [], WR: [], TE: [], DST: [],
  };
  for (const p of pool) byPosition[p.position].push(p);
  for (const pos of POSITIONS) byPosition[pos].sort((a, b) => b.score - a.score);

  let selected: NflOptimizerPlayer[] = [];
  for (const pos of POSITIONS) {
    selected.push(...byPosition[pos].slice(0, quota[pos]));
  }

  function clubCounts(list: NflOptimizerPlayer[]) {
    const m = new Map<number, number>();
    for (const p of list) m.set(p.teamId, (m.get(p.teamId) ?? 0) + 1);
    return m;
  }

  function totalPrice(list: NflOptimizerPlayer[]) {
    return list.reduce((s, p) => s + p.price, 0);
  }

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
      if (!replacement) break;
      selected = withoutWorst.concat(replacement);
    }
  }

  let guard = 0;
  while (totalPrice(selected) > budget && guard++ < 400) {
    const ids = new Set(selected.map((p) => p.gamePlayerId));
    let bestSwap: { out: NflOptimizerPlayer; in: NflOptimizerPlayer; ratio: number } | null = null;

    for (const out of selected) {
      const countsWithoutOut = clubCounts(selected.filter((p) => p.gamePlayerId !== out.gamePlayerId));
      for (const cand of byPosition[out.position]) {
        if (ids.has(cand.gamePlayerId)) continue;
        if (cand.price >= out.price) continue;
        if (maxPerClub && (countsWithoutOut.get(cand.teamId) ?? 0) >= maxPerClub) continue;
        const priceSaved = out.price - cand.price;
        const scoreLost = out.score - cand.score;
        const ratio = scoreLost / priceSaved;
        if (!bestSwap || ratio < bestSwap.ratio) bestSwap = { out, in: cand, ratio };
      }
    }

    if (!bestSwap) break;
    selected = selected.filter((p) => p.gamePlayerId !== bestSwap!.out.gamePlayerId).concat(bestSwap.in);
  }

  return selected.map((p) => p.gamePlayerId);
}
