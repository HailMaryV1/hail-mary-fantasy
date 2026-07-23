-- Live golf, "how far off the lead am I" - FanTeam's own
-- /fantasy_teams/current?round=X&tournament_id=Y endpoint, called
-- anonymously (same static "Bearer fanteam" token as the live player
-- scores, see scripts/poll_golf_live_scores.py), reliably returns
-- whichever real entry currently holds totalRank=1 for that tournament -
-- confirmed live ("Gingers", rank 1, totalScore 168). One row per
-- tournament is the right cardinality here (there's only ever one
-- current leader), so this is two nullable columns on golf_tournaments
-- rather than a new table - populated once the tournament goes live,
-- null before then.
alter table golf_tournaments add column leaderboard_leader_name text;
alter table golf_tournaments add column leaderboard_leader_score numeric(8, 2);
