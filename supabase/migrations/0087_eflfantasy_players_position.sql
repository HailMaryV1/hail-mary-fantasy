-- EFL Fantasy's squad includes 2 "CLUB" picks alongside 7 individual
-- players - whole football clubs that score their own points (win/draw/
-- away win/clean sheet/goals scored), confirmed live via fantasy.efl.com's
-- team-builder UI ("Add CLUB" x2) and /json/fantasy/loco/en.json's
-- "club.scoring" copy. This repo already has a working precedent for a
-- non-human scoring entity that fits the existing position-based squad
-- model rather than inventing a parallel data model: migration 0038 added
-- NFL's 'DST' (defense/special-teams) position for exactly this reason -
-- a synthetic `players` row per real team, scored through the normal
-- game_scoring_rules pipeline via applies_to. 'CLUB' follows the same
-- template (see import_eflfantasy.py for the synthetic-row creation).
alter table players drop constraint players_position_check;
alter table players add constraint players_position_check
  check (position in ('GK', 'DEF', 'MID', 'FWD', 'QB', 'RB', 'WR', 'TE', 'DST', 'CLUB'));
