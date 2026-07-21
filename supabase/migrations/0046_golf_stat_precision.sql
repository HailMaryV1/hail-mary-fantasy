-- Fix a real bug found while verifying import_fanteam_golf.py: several
-- golf_tournament_entries columns (migration 0045) were bounded to 2
-- decimal places, but FanTeam's real avgStats values carry more (e.g.
-- form 50.16667, score 264.4375, birdie 18.0625 - confirmed live against
-- "The 3M Open"). Storing a rounded value meant every re-import of the
-- SAME unchanged tournament data spuriously looked like a real
-- price/stat change on the next comparison (old = the rounded DB value,
-- new = the raw unrounded JSON value), flooding activity_log with false
-- "score_changed" noise on every refresh, forever. fanteam_player_status
-- (migration 0029)'s own `form` column already uses bare unbounded
-- `numeric` for exactly this reason - matching that precedent here
-- instead of re-inventing a bound that doesn't fit the real data.

alter table golf_tournament_entries alter column form type numeric;
alter table golf_tournament_entries alter column made_cut_rate type numeric;
alter table golf_tournament_entries alter column birdie_rate type numeric;
alter table golf_tournament_entries alter column bogey_rate type numeric;
alter table golf_tournament_entries alter column eagle_rate type numeric;
alter table golf_tournament_entries alter column double_bogey_rate type numeric;
alter table golf_tournament_entries alter column bounce_back_rate type numeric;
alter table golf_tournament_entries alter column score_avg type numeric;
alter table golf_tournament_entries alter column total_score_avg type numeric;
