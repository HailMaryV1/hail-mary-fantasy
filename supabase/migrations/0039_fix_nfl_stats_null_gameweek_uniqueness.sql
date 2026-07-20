-- nfl_game_player_stats' unique(game_player_id, season, gameweek) constraint
-- silently didn't dedupe season-total rows (gameweek = null), since
-- Postgres treats every NULL as distinct for uniqueness/ON CONFLICT
-- purposes - re-running import_nfl_historical_stats.py created duplicate
-- rows instead of updating them. Fix: dedupe the rows that already
-- duplicated (keep the newest per group), then add a partial unique index
-- that actually enforces one row per (game_player_id, season) when
-- gameweek is null, alongside the existing constraint which still covers
-- real per-gameweek rows once those exist.

delete from nfl_game_player_stats a
using nfl_game_player_stats b
where a.game_player_id = b.game_player_id
  and a.season = b.season
  and a.gameweek is null
  and b.gameweek is null
  and a.id < b.id;

create unique index nfl_game_player_stats_season_total_key
  on nfl_game_player_stats (game_player_id, season)
  where gameweek is null;
