/**
 * foulModelStore.ts
 * ---------------------------------------------------------------------------
 * Reads player_foul_stats (migration 0142) and turns it into the model's
 * inputs: a per-player rate for everyone in the two starting elevens, plus a
 * squad-level foul profile for each side to drive the opponent adjustment.
 *
 * Server-side only. Uses the anon key on a table with no row-level security -
 * it is pipeline-written reference data, the same shape as every other
 * reference table here, and nothing about a player's foul record is private.
 *
 * Row counts are deliberately small: 22 players across at most three seasons is
 * well under PostgREST's 1,000-row ceiling, and the squad query is bounded by
 * two teams. That ceiling has bitten this project before on unbounded selects,
 * so both queries below are explicitly scoped rather than relying on the
 * default page being big enough.
 */

import { createClient } from "@supabase/supabase-js";
import {
  computePlayerRate,
  type PlayerFoulHistory,
  type PlayerFoulRate,
  type SeasonFoulRow,
  type TeamFoulProfile,
} from "./foulModel";

type Row = {
  sportmonks_player_id: number;
  sportmonks_team_id: number;
  season_id: number;
  league_id: number;
  season_name: string | null;
  player_name: string;
  position_id: number | null;
  minutes: number;
  appearances: number;
  lineups: number;
  fouls: number;
  fouls_drawn: number;
};

function client() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { persistSession: false } },
  );
}

export type FoulModelData = {
  rates: Map<number, PlayerFoulRate>;
  teamProfiles: Map<number, TeamFoulProfile>;
  /** Season ids treated as "current" for recency weighting. */
  currentSeasonIds: number[];
  /** How many of the requested players had any history at all. */
  covered: number;
  requested: number;
};

export async function loadFoulModel(
  playerIds: number[],
  teamIds: number[],
): Promise<FoulModelData> {
  const supabase = client();

  const [playerRes, teamRes, seasonRes] = await Promise.all([
    playerIds.length
      ? supabase
          .from("player_foul_stats")
          .select(
            "sportmonks_player_id,sportmonks_team_id,season_id,league_id,season_name,player_name,position_id,minutes,appearances,lineups,fouls,fouls_drawn",
          )
          .in("sportmonks_player_id", playerIds)
      : Promise.resolve({ data: [] as Row[], error: null }),
    teamIds.length
      ? supabase
          .from("player_foul_stats")
          .select("sportmonks_team_id,minutes,fouls,fouls_drawn,season_id")
          .in("sportmonks_team_id", teamIds)
      : Promise.resolve({ data: [] as Row[], error: null }),
    // Newest season name in the table, so recency weighting does not need a
    // hardcoded season id that goes stale every August.
    supabase
      .from("player_foul_stats")
      .select("season_id,season_name")
      .order("season_name", { ascending: false })
      .limit(200),
  ]);

  if (playerRes.error) throw new Error(`player_foul_stats: ${playerRes.error.message}`);

  const playerRows = (playerRes.data ?? []) as Row[];
  const teamRows = (teamRes.data ?? []) as Pick<
    Row,
    "sportmonks_team_id" | "minutes" | "fouls" | "fouls_drawn" | "season_id"
  >[];
  const seasonRows = (seasonRes.data ?? []) as { season_id: number; season_name: string | null }[];

  const newestName = seasonRows[0]?.season_name ?? null;
  const currentSeasonIds = new Set(
    seasonRows.filter((s) => s.season_name === newestName).map((s) => s.season_id),
  );

  // --- per-player rates -------------------------------------------------
  const byPlayer = new Map<number, PlayerFoulHistory>();
  for (const r of playerRows) {
    let entry = byPlayer.get(r.sportmonks_player_id);
    if (!entry) {
      entry = {
        playerId: r.sportmonks_player_id,
        playerName: r.player_name,
        positionId: r.position_id,
        seasons: [],
      };
      byPlayer.set(r.sportmonks_player_id, entry);
    }
    // A mid-season transfer produces two rows for one season; both are real
    // and both belong in the same player's history.
    const season: SeasonFoulRow = {
      seasonId: r.season_id,
      seasonName: r.season_name,
      leagueId: r.league_id,
      minutes: r.minutes,
      appearances: r.appearances,
      lineups: r.lineups,
      fouls: r.fouls,
      foulsDrawn: r.fouls_drawn,
    };
    entry.seasons.push(season);
    if (entry.positionId == null && r.position_id != null) entry.positionId = r.position_id;
  }

  const rates = new Map<number, PlayerFoulRate>();
  for (const [id, history] of byPlayer) {
    rates.set(id, computePlayerRate(history, currentSeasonIds));
  }

  // --- squad profiles ---------------------------------------------------
  const teamAgg = new Map<number, { minutes: number; fouls: number; drawn: number }>();
  for (const r of teamRows) {
    const cur = teamAgg.get(r.sportmonks_team_id) ?? { minutes: 0, fouls: 0, drawn: 0 };
    cur.minutes += r.minutes;
    cur.fouls += r.fouls;
    cur.drawn += r.fouls_drawn;
    teamAgg.set(r.sportmonks_team_id, cur);
  }

  const teamProfiles = new Map<number, TeamFoulProfile>();
  for (const [teamId, agg] of teamAgg) {
    const ninetys = agg.minutes / 90;
    if (ninetys <= 0) continue;
    teamProfiles.set(teamId, {
      teamId,
      committedPer90: agg.fouls / ninetys,
      drawnPer90: agg.drawn / ninetys,
      ninetys,
    });
  }

  return {
    rates,
    teamProfiles,
    currentSeasonIds: [...currentSeasonIds],
    covered: rates.size,
    requested: playerIds.length,
  };
}
