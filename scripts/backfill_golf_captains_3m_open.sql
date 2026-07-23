-- One-off data backfill, run directly against production on 2026-07-23 -
-- not part of the regular pipeline, kept here purely as a git-tracked
-- record of what was changed and why.
--
-- All 6 of the user's saved teams for The 3M Open (golf_tournament_id=2)
-- were saved before migration 0052 added golf_captain_game_player_id, so
-- they had no real captain stored - /golf/live was falling back to
-- "auto-detect whoever currently has the highest LIVE score," which
-- drifts as the tournament plays rather than reflecting the captain the
-- user actually locked in on FanTeam's real site. Confirmed against the
-- user's real FanTeam entries: 5 of 6 teams' auto-detected captain
-- already happened to match (Scottie Scheffler, still the highest
-- projected/live scorer in every one of those five squads) - only
-- "Fade the Favourite" had drifted (auto-detect had picked A.J. Ewart,
-- whose live score had temporarily overtaken Hideki Matsuyama's; the
-- user confirmed Matsuyama is the real captain).
--
-- Underdog needed no equivalent backfill - it's always the cheapest
-- pick, a real automatic FanTeam mechanic (not a user choice), so it's
-- correctly recomputed fresh every render with no stored state at all.

update squads set golf_captain_game_player_id = 2707 where id in (8, 9, 10, 11, 12); -- Scottie Scheffler: Highest Projected, Safest, Highest Ceiling, Best Value, Balanced
update squads set golf_captain_game_player_id = 2721 where id = 14; -- Hideki Matsuyama: Fade the Favourite
