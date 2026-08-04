-- Cloud Fantasy Football's real "Bonus Points System" - the save/tackle/
-- pass/shot-on-target tiers migration 0073 deliberately left unpriced,
-- reasoning that this project's historical data is season-aggregate only
-- and a per-match tier ladder couldn't be applied to it correctly.
--
-- That reasoning no longer applies: Cloud FF's own real getPlayerStats
-- endpoint (see scraper_cloudff.py) already returns these as pre-tiered
-- point TOTALS (TotalSavesPts/TotalTacklePts/TotalAccuratePassPts/
-- TotalOnTargetScoringAttPts - confirmed live, matching cloud-ff.co.uk
-- /stats' own SavePts/TklPts/PassPts/SOTPts columns exactly), not raw
-- per-match counts needing our own tier ladder. So these are summed
-- straight through at 1 point per unit - Cloud FF's backend has already
-- done the tiering - the same convention FanTeam's own "save" rule and
-- Dream Team's "tackle" rule already use for a pre-scaled per-unit value.
insert into game_scoring_rules (game_id, applies_to, stat, points, notes)
select id, applies_to, stat, points, notes from (
    values
    ('all', 'save_pts', 1.00, 'Cloud FF pre-tiered save-points total (TotalSavesPts), summed through as-is'),
    ('all', 'tackle_pts', 1.00, 'Cloud FF pre-tiered tackle-points total (TotalTacklePts), summed through as-is'),
    ('all', 'pass_pts', 1.00, 'Cloud FF pre-tiered pass-points total (TotalAccuratePassPts), summed through as-is'),
    ('all', 'sot_pts', 1.00, 'Cloud FF pre-tiered shot-on-target-points total (TotalOnTargetScoringAttPts), summed through as-is')
) as rules(applies_to, stat, points, notes)
cross join (select id from fantasy_games where slug = 'cloudff') as g;
