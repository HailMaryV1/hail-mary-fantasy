-- Real FanTeam golf scoring rules, from the user's own screenshot of
-- FanTeam's in-app "Golf scoring" modal (Main Event tab - the 4-round
-- tournament totals this app cares about; there's also a "Single Round"
-- tab with the same per-hole/per-round stats minus the tournament-level
-- bonuses, for single-round-only contests this app doesn't build yet).
-- Replaces every placeholder 0/UNCONFIRMED row migration 0045 seeded.
--
-- Two corrections against migration 0045's guesses, confirmed wrong by
-- the real rules screenshot: there is no 'top25' tier (real tiers are
-- top10/20/30/40/50/60), and 'par' (every hole finished at par scores
-- 0.5, not zero) and 'all_four_sub_70' (5pt bonus for all 4 rounds under
-- 70) weren't in the original placeholder list at all - added here.
-- finish_1st/2nd/3rd are also new - the real rules break out the top 3
-- overall positions individually before the top10/20/... tiers start.
--
-- Also confirmed live (from the same rules screen, "Rules" tab) but NOT
-- stat->points rows - two whole-squad mechanics with no home in
-- game_scoring_rules' per-stat shape, documented here so Phase 2/3 build
-- them in rather than missing them:
--   - Captain: your chosen captain scores x1.25 (not x2 like football).
--   - Underdog: your CHEAPEST picked golfer is automatically assigned
--     x1.25 too, with zero action needed - a free multiplier on
--     whichever golfer ends up cheapest, so team construction should
--     weigh "is my cheapest pick actually good" more than it otherwise
--     would.
--   - Safety-net: if one of your 6 picks doesn't start, FanTeam
--     automatically substitutes them with an ACTIVE golfer of the same
--     price or cheaper (closest price preferred) - not a blunt zero.
--     This caps the real downside of a withdrawal-risk pick and should
--     soften the algorithm's risk penalty for that scenario accordingly.

insert into game_scoring_rules (game_id, applies_to, stat, points, notes)
select fg.id, 'all', v.stat, v.points, v.notes
from fantasy_games fg, (values
    ('hole_in_one', 10, 'Confirmed via FanTeam''s own in-app scoring rules screen - "Better than Eagle" (hole-in-one or albatross)'),
    ('eagle', 8, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('birdie', 3, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('par', 0.5, 'Confirmed via FanTeam''s own in-app scoring rules screen - per hole finished at par'),
    ('bogey', -0.5, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('double_bogey', -1, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('triple_bogey_or_worse', -2, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('no_bogeys', 3, 'Confirmed via FanTeam''s own in-app scoring rules screen - bonus for a bogey-free round'),
    ('three_consecutive_birdies', 3, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('round_of_64', 3, 'Confirmed via FanTeam''s own in-app scoring rules screen - "64 or better"'),
    ('all_four_sub_70', 5, 'Confirmed via FanTeam''s own in-app scoring rules screen - one-time bonus, all 4 rounds under 70'),
    ('bounce_back', 0.25, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('finish_1st', 25, 'Confirmed via FanTeam''s own in-app scoring rules screen - overall tournament position'),
    ('finish_2nd', 20, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('finish_3rd', 15, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('top10', 10, 'Confirmed via FanTeam''s own in-app scoring rules screen - overall position tier'),
    ('top20', 5, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('top30', 4, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('top40', 3, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('top50', 2, 'Confirmed via FanTeam''s own in-app scoring rules screen'),
    ('top60', 1, 'Confirmed via FanTeam''s own in-app scoring rules screen')
) as v(stat, points, notes)
where fg.slug = 'fanteam-golf'
on conflict (game_id, applies_to, stat) do update set points = excluded.points, notes = excluded.notes;

-- The old placeholder 'top25' row doesn't correspond to any real FanTeam
-- tier - remove it rather than leave a dead/wrong row behind.
delete from game_scoring_rules
where stat = 'top25' and game_id = (select id from fantasy_games where slug = 'fanteam-golf');
