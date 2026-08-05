-- Real bug caught live 2026-08-06 via the Player Info panel: EFL Fantasy
-- was NEVER given a projection_module_weights row for any position -
-- unlike every other game (FanTeam/Cloud FF/Dream Team all got real,
-- tuned weights during Fantasy Influence's rollout, migration 0076 +
-- Player Role's earlier retirement). With no configured row at all, the
-- engine's per-stat blend fell through to an equal-split-among-
-- available-modules fallback - which handed fantasy_influence a full
-- 1/3 share it was never validated to have (every other game keeps it
-- explicitly pinned to 0.0, per the "Calibration layer discipline"
-- convention: new/unvetted modules stay off until evidence justifies
-- turning them on).
--
-- Confirmed live: Lynden Gooch (DEF, 24 expected minutes) was showing
-- 2.27 projected assists per match, driven almost entirely by
-- fantasy_influence's raw_rate of 14.5 for that stat - wildly out of
-- line with fixture_model (0.088) and historical_performance (0.247)
-- for the exact same player/fixture. An unconfigured module is not the
-- same as a deliberately zero-weighted one, and this game fell through
-- that gap since its build predates this weight table by weeks.
--
-- Fix: seed EFL Fantasy with FanTeam's exact real, already-validated
-- per-position scheme (same GK/DEF/MID/FWD shape, same module set) -
-- fantasy_influence=0.0 everywhere, matching every other live game.
-- Weights intentionally don't sum to 1.0 per position (0.80-1.00) -
-- that's FanTeam's own real, tuned scheme, copied verbatim rather than
-- re-normalized, since the remaining share is exactly how much
-- fixture-model/bookmaker uncertainty this scheme already prices in for
-- FanTeam and there's no evidence yet to tune EFL Fantasy differently.
insert into projection_module_weights (game_id, position, module, weight)
select fg.id, v.position, v.module, v.weight
from fantasy_games fg, (values
    ('GK', 'bookmaker_intelligence', 0.35),
    ('GK', 'fixture_model', 0.20),
    ('GK', 'historical_performance', 0.35),
    ('GK', 'recent_form', 0.10),
    ('GK', 'fantasy_influence', 0.0),
    ('DEF', 'bookmaker_intelligence', 0.30),
    ('DEF', 'fixture_model', 0.20),
    ('DEF', 'historical_performance', 0.30),
    ('DEF', 'recent_form', 0.10),
    ('DEF', 'fantasy_influence', 0.0),
    ('MID', 'bookmaker_intelligence', 0.25),
    ('MID', 'fixture_model', 0.15),
    ('MID', 'historical_performance', 0.30),
    ('MID', 'recent_form', 0.15),
    ('MID', 'fantasy_influence', 0.0),
    ('FWD', 'bookmaker_intelligence', 0.30),
    ('FWD', 'fixture_model', 0.10),
    ('FWD', 'historical_performance', 0.25),
    ('FWD', 'recent_form', 0.15),
    ('FWD', 'fantasy_influence', 0.0)
) as v(position, module, weight)
where fg.slug = 'eflfantasy'
on conflict (game_id, position, module) do update set weight = excluded.weight;
