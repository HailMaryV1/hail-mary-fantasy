import type { createAuthServerClient } from "./supabaseServerClient";

type Supabase = Awaited<ReturnType<typeof createAuthServerClient>>;

export type RotationRiskLevel = "nailed" | "some_risk" | "high_risk";

export type RotationRiskInfo = {
  level: RotationRiskLevel;
  ownProbability: number;
  contenderName: string | null;
  contenderProbability: number | null;
};

export type RotationRiskBadgeInfo = { code: string; label: string; tone: "green" | "amber" | "red" | "gray" };

/**
 * "nailed" deliberately renders no badge at all (same convention as
 * playerStatus.ts's resolveStatusBadge returning null for a fully healthy,
 * fully expected starter) - the badge exists to flag risk, not to
 * decorate every player with a permanently-green pill.
 */
export function resolveRotationRiskBadge(risk: RotationRiskInfo | null | undefined): RotationRiskBadgeInfo | null {
  if (!risk || risk.level === "nailed") return null;
  const contender = risk.contenderName ? ` (competing with ${risk.contenderName}, ${risk.contenderProbability}%)` : "";
  if (risk.level === "high_risk") {
    return { code: "ROT", label: `Rotation risk - ${risk.ownProbability}% to start${contender}`, tone: "red" };
  }
  return { code: "ROT", label: `Some rotation risk - ${risk.ownProbability}% to start${contender}`, tone: "amber" };
}

/**
 * Batch fetch from player_rotation_risk (migration 0111) for a squad's
 * worth of player_ids - one query per page load rather than one per
 * player. Players with no lineup-probability data at all (not covered by
 * this week's screenshot batch yet) simply have no entry in the returned
 * map, which resolveRotationRiskBadge above treats the same as "nailed"
 * (no badge) - absence of data is never treated as risk.
 */
export async function fetchRotationRiskByPlayerIds(supabase: Supabase, playerIds: number[]): Promise<Map<number, RotationRiskInfo>> {
  const map = new Map<number, RotationRiskInfo>();
  const ids = [...new Set(playerIds)];
  if (ids.length === 0) return map;
  const { data } = await supabase
    .from("player_rotation_risk")
    .select("player_id, start_probability, contender_name, contender_probability, risk_level")
    .in("player_id", ids);
  for (const row of data ?? []) {
    map.set(row.player_id as number, {
      level: row.risk_level as RotationRiskLevel,
      ownProbability: Number(row.start_probability),
      contenderName: (row.contender_name as string | null) ?? null,
      contenderProbability: row.contender_probability != null ? Number(row.contender_probability) : null,
    });
  }
  return map;
}
