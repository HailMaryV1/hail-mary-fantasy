-- Makes Bookmaker Intelligence the real, dominant driver of the modular
-- goal/assist/clean_sheet_60min/shot_on_target blend, for every position
-- in every game. Direct user request (2026-08-17), after the Dream Team
-- scoring-inflation fix: "leave all the cleverness out of it... THE
-- BOOKIES SAY THIS - THESE ARE THE SCORING MATRIX - this is what we
-- expect". Explicitly chosen over the safer "separate explanatory lens"
-- alternative - the user wants the literal bookmaker-market breakdown
-- shown in the Player Info panel to BE the real Projected Points number,
-- not a second number that disagrees with it.
--
-- Previously bookmaker_intelligence sat at 0.25-0.45 per position/game -
-- roughly on par with historical_performance, nowhere near dominant.
-- blend_module_rates (scripts/compute_projections.py) renormalizes
-- automatically among whichever modules have real (non-None) data for a
-- given player/fixture/stat, so raising bookmaker's configured weight
-- here needs no code change: when real market data exists it now
-- provides ~85% of the blend; when it doesn't (market not yet offered,
-- or a game/competition with thin bookmaker coverage - see EFL Fantasy's
-- Championship/League One/League Two caveat), weight redistributes to
-- historical_performance/fixture_model/recent_form exactly as it always
-- has, just from a smaller combined base (0.15 instead of ~0.65-0.75).
--
-- fantasy_influence is untouched (stays 0 everywhere - still gated on
-- Performance Lab evidence, migration 0076/0097). The 0.15 remaining
-- across the other three modules is a uniform starting split, not
-- individually re-tuned per position - flagged as adjustable via
-- Performance Lab once real 2026/27 results exist, same discipline
-- already applied to every other module weight in this table.
update projection_module_weights
set weight = v.weight, updated_at = now()
from (
  values
    ('bookmaker_intelligence', 0.85),
    ('historical_performance', 0.08),
    ('fixture_model', 0.04),
    ('recent_form', 0.03)
) as v(module, weight)
where projection_module_weights.module = v.module;
