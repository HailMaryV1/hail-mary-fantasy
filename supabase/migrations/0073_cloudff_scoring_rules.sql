-- Cloud Fantasy Football's real, published scoring rules (cloud-ff.co.uk
-- /help "Scoring Rules" section, read live 2026-07-31 - not guessed or
-- reverse-engineered from aggregate stats).
--
-- Deliberately NOT seeded here: the "Bonus Points System" (GK saves,
-- tackles, completed passes, shots on target - each its own 3-tier
-- per-MATCH threshold, e.g. "3 tackles = 1pt, 4 = 2pts, 5+ = 3pts").
-- This project's historical data is season-aggregate only (one row per
-- player per season, see game_player_stats' gameweek=0 convention) -
-- applying a per-match tier ladder to a season-average rate would
-- silently misrepresent it (the same documented tension already exists
-- for Dream Team's own PPM bonus tiers, see compute_bonus_points()'s
-- docstring). Left unpriced (contributes 0) rather than guessed - revisit
-- once real per-gameweek Cloud FF data exists.
--
-- "appearance"/"minutes_60_plus" approximate Cloud FF's real "Starting XI
-- +2 / Substitution Appearance +1" split by reusing the existing
-- appearance-probability signal this project already computes (the
-- Opportunity Model predicts P(appears at all) and P(reaches 60+ mins),
-- not P(started) specifically) - a player projected to reach 60+ minutes
-- is a strong proxy for having started, so appearance(+1) + minutes_60_
-- plus(+1) approximates a starter's real +2 and a sub's real +1.
insert into game_scoring_rules (game_id, applies_to, stat, points, notes)
select id, applies_to, stat, points, notes from (
    values
    ('all', 'appearance', 1.00, 'Approximates "Substitution Appearance +1" - see migration docstring'),
    ('all', 'minutes_60_plus', 1.00, 'Approximates the extra point a Starting XI player earns over a sub - see migration docstring'),
    ('all', 'assist', 3.00, null),
    ('all', 'penalty_miss', -2.00, null),
    ('all', 'own_goal', -2.00, null),
    ('all', 'yellow_card', -1.00, null),
    ('all', 'red_card', -3.00, null),
    ('GK', 'goal', 7.00, null),
    ('GK', 'clean_sheet_60min', 7.00, null),
    ('GK', 'goals_conceded_per_2', -1.00, 'Real rule is a flat -1 once 2+ conceded in a match, not per-2 repeating - approximated the same linear way as Dream Team''s own goals_conceded_per_2 rule'),
    ('GK', 'penalty_save', 4.00, null),
    ('DEF', 'goal', 7.00, null),
    ('DEF', 'clean_sheet_60min', 5.00, null),
    ('DEF', 'goals_conceded_per_2', -1.00, 'Real rule is a flat -1 once 2+ conceded in a match, not per-2 repeating - approximated the same linear way as Dream Team''s own goals_conceded_per_2 rule'),
    ('MID', 'goal', 6.00, null),
    ('FWD', 'goal', 5.00, null)
) as rules(applies_to, stat, points, notes)
cross join (select id from fantasy_games where slug = 'cloudff') as g;
