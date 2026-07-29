-- Phase A of the FanTeam strategic-planning audit: fixes a real
-- inconsistency confirmed live - three separate call sites ran Ask
-- Mary's engine with three different, independently hardcoded
-- strategy/horizon defaults (squads/[id]/page.tsx's MaryRecommendationsPanel
-- and squads/actions.ts's saveTeamForGameweek both hardcoded
-- "balanced"/1-gameweek; /ask-mary's own UI default is "balanced"/5-gameweek).
-- The archived prediction history (used to grade Mary in Performance Lab)
-- could therefore reflect a horizon the user was never actually looking
-- at. These two columns are the one persisted per-squad preference all
-- three call sites now read from instead.
--
-- Default captain horizon is 5 (not 1) to match /ask-mary's existing
-- pre-preference-system default (CAPTAIN_HORIZONS[2]) - so squads that
-- have never explicitly chosen a horizon see no behavior change on
-- /ask-mary itself; only the two call sites that were silently
-- disagreeing (1-gameweek) move to match.
alter table squads add column preferred_strategy text not null default 'balanced'
  check (preferred_strategy in ('balanced', 'safe', 'aggressive', 'differential', 'longterm'));
alter table squads add column preferred_captain_horizon int not null default 5
  check (preferred_captain_horizon in (1, 3, 5));
