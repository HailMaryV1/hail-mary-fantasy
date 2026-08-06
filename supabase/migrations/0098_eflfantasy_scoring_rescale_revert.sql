-- Reverts migration 0093's flat 2x point-value rescale.
--
-- Real bug caught live 2026-08-06: after fixing import_eflfantasy.py's
-- missing PT60/PT90 keys (see that commit), squads started projecting
-- ~90pts for a 9-pick lineup - "the scores have gone silly high again".
--
-- Root cause: 0093's 2x rescale was calibrated on 2026-08-05 by comparing
-- projected GW1 scores against real season-total averagePoints/38, and
-- measured every position at ~46-53% of real (a "1.9-2.1x gap"). That
-- measurement was taken while the PT60/PT90 bug was still live - every
-- player's expected-minutes fraction was collapsed toward ~30-40% of a
-- full match regardless of real playing time, which alone accounts for
-- almost exactly that gap. 0093 attributed the shortfall to undervalued
-- point-value placeholders and doubled them; the real cause was
-- suppressed minutes, now fixed at the source.
--
-- Confirmed live post-minutes-fix, pool-wide average projected GW1 score
-- vs real season total_points/38, by position (with 0093's 2x still
-- applied): DEF 2.10x, GK 1.87x, FWD 1.74x, MID 1.59x - almost the exact
-- same gap 0093 found, just inverted, because both fixes were correcting
-- the same underlying shortfall. Reverting 0093 here (dividing back by 2)
-- brings the ratios back to ~0.8-1.05x, i.e. genuine parity with real
-- historical scoring, without a second undocumented adjustment stacked on
-- top of a now-corrected minutes model.
--
-- The placeholder point-value structure (GK goals worth more than FWD
-- goals, etc.) inherited from FanTeam's matrix is still unconfirmed
-- against EFL Fantasy's own real per-rule point values - that remains the
-- honest next step, same caveat 0093 already flagged.
update game_scoring_rules gsr
set points = points / 2,
    notes = 'reverted 2026-08-05 x2 rescale (2026-08-06 - see migration 0098): that rescale was compensating for the PT60/PT90 minutes bug, now fixed at the source - not yet confirmed against real per-rule point values'
from fantasy_games fg
where gsr.game_id = fg.id and fg.slug = 'eflfantasy'
  and gsr.notes = 'placeholder x2 (2026-08-05 recalibration - see migration 0093) - not yet confirmed against real point values';
