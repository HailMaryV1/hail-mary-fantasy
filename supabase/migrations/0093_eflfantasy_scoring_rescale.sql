-- First-pass calibration of migration 0090's placeholder point values.
-- Confirmed live: comparing our v2-decomposed engine's average projected
-- GW1 score against real 2025/26 season-total averagePoints/38 (the same
-- historical baseline import_eflfantasy.py already imports), every
-- position was landing at ~46-53% of the real per-gameweek average -
-- GK 0.51 vs real 1.05 (2.05x), DEF 0.88 vs 1.71 (1.93x), MID 0.70 vs 1.50
-- (2.13x), FWD 0.71 vs 1.35 (1.90x). That's a strikingly uniform gap
-- across every position, not noise - the placeholder point values (all
-- loosely modeled on FanTeam's matrix, not EFL Fantasy's own) were simply
-- set about half of what the real scoring rate actually produces.
--
-- A flat 2x on every rule preserves the placeholder author's relative
-- structure (GK goals still worth more than FWD goals, etc.) while fixing
-- the overall magnitude to match real historical scoring - a linear
-- rescale of every points value scales the projected total by the exact
-- same factor, so this is a direct, low-risk correction, not a guess.
-- Still flagged as approximate (not the real per-rule point values,
-- which remain unconfirmed) - a genuine reverse-engineered per-stat
-- regression against real totalPoints is the honest next step, deferred.
update game_scoring_rules gsr
set points = points * 2,
    notes = 'placeholder x2 (2026-08-05 recalibration - see migration 0093) - not yet confirmed against real point values'
from fantasy_games fg
where gsr.game_id = fg.id and fg.slug = 'eflfantasy';
