-- import_nfl_historical_stats.py already fetches each player's games-played
-- count from ESPN (needed to turn a season total into a per-game rate for
-- projections) but had nowhere to store it. Backfilled by the next importer
-- run, not by this migration.
alter table nfl_game_player_stats add column games_played int;
