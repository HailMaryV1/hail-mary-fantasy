-- "There is no marker to say these are TRUE REAL LIVE BOOKMAKER ODDS"
-- (2026-08-23 user request) - is_rating_eligible (migration from earlier
-- today) already decides WHY a player earned a rating (real bookmaker
-- odds, real Recent Form, or - EFL Fantasy only - model coverage alone),
-- but that reason was never persisted or surfaced. This column stores
-- it alongside the rating so the frontend can show a real, honest badge
-- instead of leaving the user to guess.
alter table projections add column hail_mary_rating_basis text
    check (hail_mary_rating_basis is null or hail_mary_rating_basis in ('real_odds', 'recent_form', 'coverage_only'));
