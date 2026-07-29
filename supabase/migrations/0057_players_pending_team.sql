-- Debounces team_id changes in import_fanteam_live.py. Confirmed live:
-- Boubacar Kamara and Abdoullah Ba's team_id kept flip-flopping between
-- two real clubs on every import (Hull City<->Aston Villa,
-- Newcastle United<->Sunderland) - NOT a name-matching bug (each has
-- exactly one real player, one DB row, one unambiguous match every run)
-- but FanTeam's own live payload genuinely alternating which realTeamId
-- it reports for these two specific players between scrapes (an
-- in-progress/unstable transfer on FanTeam's backend, most likely).
--
-- Since a confident name match is deliberately trusted to correct a
-- stale team_id (see import_fanteam_live.py's own docstring - this is
-- how real transfers get picked up at all), reacting to every single
-- disagreement faithfully mirrors FanTeam's noise straight into
-- players.team_id and the Activity feed. Requiring the SAME new team to
-- be seen on two consecutive imports before committing it filters out a
-- one-scrape blip while still catching genuine transfers (which persist
-- into the next scrape by definition).
alter table players add column pending_team_id bigint references teams(id);
alter table players add column pending_team_seen_at timestamptz;
