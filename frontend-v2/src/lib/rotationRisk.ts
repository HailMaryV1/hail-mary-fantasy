import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

export type RotationRiskLevel = "nailed" | "some_risk" | "high_risk";

export type RotationRiskInfo = {
  level: RotationRiskLevel;
  ownProbability: number;
  contenderName: string | null;
  contenderProbability: number | null;
  contenderPlayerId: number | null;
};

export type RotationRiskBadgeInfo = { code: string; label: string; tone: "green" | "amber" | "red" | "gray" };

/**
 * "nailed" deliberately renders no badge at all (same convention as
 * playerStatus.ts's resolveStatusBadge returning null for a fully healthy,
 * fully expected starter) - the badge exists to flag risk, not to
 * decorate every player with a permanently-green pill.
 *
 * SUB (2026-08-19 user request) is a step up from ROT, specifically for a
 * player who has actually LOST their head-to-head - their own probability
 * is lower than the teammate they're contesting the slot with, i.e. this
 * project's own data says they're not in the predicted XI right now, not
 * just "at risk of" losing it. Real example that prompted this: Noni
 * Madueke (13%) vs Bukayo Saka (84%) - "high_risk" alone doesn't convey
 * that Madueke is the clear second choice, not a coin-flip.
 */
export function resolveRotationRiskBadge(risk: RotationRiskInfo | null | undefined): RotationRiskBadgeInfo | null {
  if (!risk || risk.level === "nailed") return null;
  const contender = risk.contenderName ? ` (competing with ${risk.contenderName}, ${risk.contenderProbability}%)` : "";
  if (risk.contenderProbability != null && risk.contenderProbability > risk.ownProbability) {
    return {
      code: "SUB",
      label: `Not in the predicted XI - ${risk.contenderName ?? "a teammate"} favoured to start (${risk.contenderProbability}% vs ${risk.ownProbability}%)`,
      tone: "red",
    };
  }
  if (risk.level === "high_risk") {
    return { code: "ROT", label: `Rotation risk - ${risk.ownProbability}% to start${contender}`, tone: "red" };
  }
  return { code: "ROT", label: `Some rotation risk - ${risk.ownProbability}% to start${contender}`, tone: "amber" };
}

// Mirrors compute_projections.py's ROTATION_RISK_STALENESS_DAYS and
// migration 0124's identical freshness gate on game_player_pool - all
// three read the same one-off hand-transcribed screenshot batch, so all
// three time-box it the same way. Kept in sync manually (no shared config
// across the Python/SQL/TS boundary) - if one changes, change all three.
const ROTATION_RISK_STALENESS_DAYS = 30;

/**
 * Batch fetch from player_rotation_risk (migration 0111) for a squad's
 * worth of player_ids - one query per page load rather than one per
 * player. Players with no lineup-probability data at all (not covered by
 * this week's screenshot batch yet, or the whole batch has gone stale -
 * see ROTATION_RISK_STALENESS_DAYS above) simply have no entry in the
 * returned map, which resolveRotationRiskBadge above treats the same as
 * "nailed" (no badge) - absence of data is never treated as risk.
 *
 * Previously short-circuited to an empty map once the real season kicked
 * off, on the assumption that FanTeam/EFL Fantasy's own live lineup feeds
 * would take over as the authoritative "will this player start" signal.
 * That assumption doesn't hold for Dream Team/Cloud FF, which have never
 * had a live feed of their own - and this data covers a DIFFERENT axis
 * (tactical/positional selection among fit players) to FFScout's fitness-
 * only doubt/out/banned, so it stays relevant even after kickoff. Real
 * user confirmation 2026-08-19: "that data is still fresh for the first
 * few gameweeks" - replaced the hard seasonStarted cutoff with the
 * rolling staleness window above instead.
 */
export async function fetchRotationRiskByPlayerIds(supabase: Supabase, playerIds: number[]): Promise<Map<number, RotationRiskInfo>> {
  const map = new Map<number, RotationRiskInfo>();
  const ids = [...new Set(playerIds)];
  if (ids.length === 0) return map;
  const { data: latestSnapshot } = await supabase
    .from("player_lineup_probability_latest")
    .select("snapshot_date")
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!latestSnapshot) return map;
  const staleBefore = new Date(Date.now() - ROTATION_RISK_STALENESS_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (latestSnapshot.snapshot_date < staleBefore) return map;
  const { data } = await supabase
    .from("player_rotation_risk")
    .select("player_id, start_probability, contender_name, contender_probability, risk_level, contender_player_id")
    .in("player_id", ids);
  for (const row of data ?? []) {
    map.set(row.player_id as number, {
      level: row.risk_level as RotationRiskLevel,
      ownProbability: Number(row.start_probability),
      contenderName: (row.contender_name as string | null) ?? null,
      contenderProbability: row.contender_probability != null ? Number(row.contender_probability) : null,
      contenderPlayerId: (row.contender_player_id as number | null) ?? null,
    });
  }
  return map;
}

/**
 * Turns the player_id-keyed risk map above into a game_player_id-keyed
 * "who else can't be bought/kept alongside this player" map, scoped to one
 * game's pool - Ask Mary's transfer search only ever deals in
 * game_player_id, never the game-independent players.id. Only real
 * contests (risk_level !== 'nailed') produce an entry; a player with no
 * lineup-probability coverage or a comfortably-ahead starter is never
 * flagged, same "absence of data is never risk" rule as the badge.
 */
export function buildContestedGamePlayerPairs(
  pool: { game_player_id: number; player_id: number }[],
  riskByPlayerId: Map<number, RotationRiskInfo>
): Map<number, number> {
  const gamePlayerIdByPlayerId = new Map(pool.map((p) => [p.player_id, p.game_player_id]));
  const pairs = new Map<number, number>();
  for (const p of pool) {
    const risk = riskByPlayerId.get(p.player_id);
    if (!risk || risk.level === "nailed" || risk.contenderPlayerId == null) continue;
    const contenderGamePlayerId = gamePlayerIdByPlayerId.get(risk.contenderPlayerId);
    if (contenderGamePlayerId != null) pairs.set(p.game_player_id, contenderGamePlayerId);
  }
  return pairs;
}

/**
 * game_player_ids Mary should never BUY, regardless of whether the squad
 * already owns their specific contender - a player genuinely unlikely to
 * start (risk_level 'high_risk', e.g. Gusto at 20% to start behind Hato's
 * 65%) shouldn't be a fresh recommendation even in isolation (2026-08-09
 * user report: Mary kept holding/wasn't excluding a 20%-to-start player).
 * 'some_risk' is deliberately left buyable - that tier is a real but
 * lesser contest, not "won't play."
 */
export function buildHighRiskGamePlayerIds(pool: { game_player_id: number; player_id: number }[], riskByPlayerId: Map<number, RotationRiskInfo>): Set<number> {
  const ids = new Set<number>();
  for (const p of pool) {
    if (riskByPlayerId.get(p.player_id)?.level === "high_risk") ids.add(p.game_player_id);
  }
  return ids;
}
