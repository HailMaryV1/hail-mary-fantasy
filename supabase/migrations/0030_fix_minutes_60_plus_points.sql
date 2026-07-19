-- FanTeam's real scoring matrix (migration 0021) recorded
-- minutes_60_plus at 3 points - wrong. Confirmed against FanTeam's own
-- rules by the user: appearing at all is worth 1 point, and completing
-- 60+ minutes is worth a further 1 point (2 total for a nailed-on
-- starter), not 1 + 3 = 4. That extra 2 points was silently inflating
-- every single player's score regardless of form or fixture, since
-- involvement_rate for an established player is close to 1.0 - caught
-- because it was visibly propping up a backup keeper's projection.

update game_scoring_rules
set points = 1
where stat = 'minutes_60_plus'
  and game_id = (select id from fantasy_games where slug = 'fanteam');
