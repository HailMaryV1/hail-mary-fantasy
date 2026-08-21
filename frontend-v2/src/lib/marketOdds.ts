"use server";

import { createAuthServerClient } from "./supabaseServerClient";

export type EflCompetition = "efl_championship" | "efl_league_one" | "efl_league_two";
export type MarketOddsCompetition = EflCompetition | "soccer_epl";

export type MarketOddsTeamSide = {
  teamId: number;
  teamName: string;
  winPct: number;
  winPctDelta: number;
  cleanSheetPct: number;
  cleanSheetPctDelta: number;
  /** Poisson-calibrated from the real 1X2 market (see compute_expected_
   * goals.py) - null only if the real odds this derives from haven't
   * arrived yet for this fixture. No delta - it's a derived estimate,
   * not a raw market snapshot with its own history. */
  expectedGoals: number | null;
};

export type MarketOddsFixture = {
  fixtureId: number;
  competition: MarketOddsCompetition;
  kickoffAt: string;
  home: MarketOddsTeamSide;
  away: MarketOddsTeamSide;
};

export type MarketOddsTeamRow = MarketOddsTeamSide & {
  fixtureId: number;
  competition: MarketOddsCompetition;
  kickoffAt: string;
  opponentName: string;
  isHome: boolean;
};

export type MarketOddsResult = {
  fixtures: MarketOddsFixture[];
  top5Winners: MarketOddsTeamRow[];
  top5Goals: MarketOddsTeamRow[];
  top5CleanSheets: MarketOddsTeamRow[];
};

type RpcRow = {
  fixture_id: number;
  competition: MarketOddsCompetition;
  kickoff_at: string;
  team_id: number;
  team_name: string;
  opponent_team_id: number;
  opponent_name: string;
  is_home: boolean;
  win_prob: number | string;
  win_prob_opening: number | string | null;
  clean_sheet_pct: number | string;
  clean_sheet_pct_opening: number | string | null;
  expected_goals: number | string | null;
};

/**
 * Real per-team market data (win %, clean sheet %, Poisson-derived
 * expected goals - see migration 0125/0133's own docstrings) for one
 * game's gameweek of fixtures - originally built 2026-08-20 for EFL
 * Fantasy's "Market Odds" page (Championship/League One/League Two),
 * widened 2026-08-21 to also serve Dream Team/FanTeam/Cloud FF's real
 * Premier League fixtures. The scope guarantee moved from a hardcoded
 * 'eflfantasy' literal inside the RPC to the caller-supplied gameSlug -
 * get_market_odds(p_game_slug, p_gameweek) only ever returns fixtures
 * from that game's own game_fixture_gameweeks calendar, so a single-
 * competition game (fanteam/cloudff, Premier League only) never needs
 * competitionFilter at all and can just leave it at "ALL".
 */
export async function fetchMarketOdds(
  gameSlug: string,
  gameweek: number,
  competitionFilter: MarketOddsCompetition | "ALL" = "ALL"
): Promise<MarketOddsResult> {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { fixtures: [], top5Winners: [], top5Goals: [], top5CleanSheets: [] };

  const { data, error } = await supabase.rpc("get_market_odds", { p_game_slug: gameSlug, p_gameweek: gameweek });
  if (error || !data) return { fixtures: [], top5Winners: [], top5Goals: [], top5CleanSheets: [] };

  const rows = (data as RpcRow[]).filter((r) => competitionFilter === "ALL" || r.competition === competitionFilter);

  const toSide = (r: RpcRow): MarketOddsTeamSide => ({
    teamId: r.team_id,
    teamName: r.team_name,
    winPct: Number(r.win_prob),
    winPctDelta: r.win_prob_opening != null ? Number(r.win_prob) - Number(r.win_prob_opening) : 0,
    cleanSheetPct: Number(r.clean_sheet_pct),
    cleanSheetPctDelta: r.clean_sheet_pct_opening != null ? Number(r.clean_sheet_pct) - Number(r.clean_sheet_pct_opening) : 0,
    expectedGoals: r.expected_goals != null ? Number(r.expected_goals) : null,
  });

  // Pair up home/away rows into one fixture entry each - the RPC returns
  // one row per (fixture, team), ordered home-first per fixture (see its
  // own `order by ... is_home desc`).
  const fixturesByid = new Map<number, MarketOddsFixture>();
  for (const r of rows) {
    const existing = fixturesByid.get(r.fixture_id);
    if (!existing) {
      fixturesByid.set(r.fixture_id, {
        fixtureId: r.fixture_id,
        competition: r.competition,
        kickoffAt: r.kickoff_at,
        home: r.is_home ? toSide(r) : ({} as MarketOddsTeamSide),
        away: r.is_home ? ({} as MarketOddsTeamSide) : toSide(r),
      });
    } else if (r.is_home) {
      existing.home = toSide(r);
    } else {
      existing.away = toSide(r);
    }
  }
  const fixtures = Array.from(fixturesByid.values()).sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));

  const teamRows: MarketOddsTeamRow[] = rows.map((r) => ({
    ...toSide(r),
    fixtureId: r.fixture_id,
    competition: r.competition,
    kickoffAt: r.kickoff_at,
    opponentName: r.opponent_name,
    isHome: r.is_home,
  }));

  const top5Winners = [...teamRows].sort((a, b) => b.winPct - a.winPct).slice(0, 5);
  const top5Goals = [...teamRows]
    .filter((r) => r.expectedGoals != null)
    .sort((a, b) => (b.expectedGoals as number) - (a.expectedGoals as number))
    .slice(0, 5);
  const top5CleanSheets = [...teamRows].sort((a, b) => b.cleanSheetPct - a.cleanSheetPct).slice(0, 5);

  return { fixtures, top5Winners, top5Goals, top5CleanSheets };
}
