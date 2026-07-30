-- Player Role V1 audit (scripts/audit_player_role.py) found the module is
-- mathematically consistent but not measuring the intended concept: across
-- the full FanTeam + Dream Team pool, its marginal effect is one-directional
-- (near-zero-to-negative for everyone, meaningfully positive for no one) and
-- concentrates its largest cuts on elite attackers - a structural property
-- of team_share x team_per90 being capped at the team average, not noise or
-- a few outliers. See the audit report for the full evidence.
--
-- This sets Player Role's CONFIGURED weight to 0 for every outfield
-- position it was live for (GK was already 0). blend_module_rates()
-- (compute_projections.py) renormalizes among "available" modules by their
-- CONFIGURED weight, so a 0 here means player_role contributes weight
-- 0/total_weight = 0 to every blend, while the other modules' weights
-- renormalize among themselves exactly as if player_role had never been
-- configured with a non-zero weight - no code change needed for that part,
-- only this data change. Player Role's raw_rate keeps being computed and
-- stored in module_detail (never removed), so it stays fully visible on the
-- Engine Validation page and available to Performance Lab as a dormant
-- comparison signal - see frontend/src/lib/engineExplainability.ts for the
-- "Experimental / production disabled" status now shown alongside it.
update projection_module_weights
set weight = 0
where module = 'player_role'
  and game_id in (select id from fantasy_games where slug in ('fanteam', 'dreamteam'));
