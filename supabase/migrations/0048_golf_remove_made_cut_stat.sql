-- The real FanTeam golf scoring rules (migration 0047) confirmed there is
-- no discrete "made the cut" point award - the cut's effect on scoring is
-- entirely implicit (missing it just means fewer rounds played, so fewer
-- per-hole points accumulated; making it is a precondition for the
-- finish-position bonuses, not a bonus itself). migration 0045's
-- placeholder 'made_cut' game_scoring_rules row would otherwise sit at 0
-- forever looking like still-pending data rather than a confirmed
-- non-stat - remove it. The make-cut RATE itself remains a real and
-- useful algorithm input (golf_tournament_entries.made_cut_rate,
-- migration 0045/0046) - only the (non-existent) points-per-stat row
-- goes.

delete from game_scoring_rules
where stat = 'made_cut' and game_id = (select id from fantasy_games where slug = 'fanteam-golf');
