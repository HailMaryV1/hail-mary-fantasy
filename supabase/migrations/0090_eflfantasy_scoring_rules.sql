-- EFL Fantasy's scoring-rule LABELS are confirmed live (fantasy.efl.com's
-- own /json/fantasy/loco/en.json "score.banner" copy: appearance, assist,
-- hat-trick, missed penalty, yellow/red card, own goal; FORWARDS get goal
-- scored; MIDFIELDERS & FORWARDS get key pass + shot on target;
-- MIDFIELDERS get interception; DEFENDERS get every-4-clearances/every-2-
-- blocks/every-2-tackles; GOALKEEPERS & DEFENDERS get clean sheet (60+
-- mins) + every-2-goals-conceded; GOALKEEPERS get every-3-saves + penalty
-- save. The exact POINT VALUES are NOT confirmed anywhere in the public
-- API - unlike every other game's scoring_rules migration in this repo
-- (which always encodes a real, user-provided or scraped rule set), these
-- are placeholder estimates loosely modeled on FanTeam's own matrix
-- (migration 0021), to be reverse-engineered against real
-- totalPoints/averagePoints once player data is imported (see
-- import_eflfantasy.py) and tuned in a follow-up migration - flagged
-- explicitly, not silently treated as real.
--
-- "every N X" rules (clearances/4, blocks/2, tackles/2, saves/3) use this
-- repo's existing pre-divided-rate convention (see goals_conceded_per_2 in
-- migration 0021 and STAT_RATE_SCALE in compute_projections.py) rather
-- than a new schema feature - the stored `points` value is the full bonus
-- for N occurrences, and compute_projections.py pre-divides the projected
-- rate by N before pricing it through this flat per-unit row.
--
-- Club scoring (applies_to = 'CLUB') is the one genuinely new category -
-- no other game in this schema has a squad slot that isn't an individual
-- player. It reuses this same table via the synthetic-player pattern (see
-- migration 0087's docstring) rather than a parallel schema.
insert into game_scoring_rules (game_id, applies_to, stat, points, notes)
select fg.id, v.applies_to, v.stat, v.points, v.notes
from fantasy_games fg, (values
    ('all', 'appearance', 1, 'placeholder - not yet confirmed against real point values'),
    ('all', 'assist', 3, 'placeholder'),
    ('all', 'hat_trick', 5, 'placeholder - discrete bonus for 3+ goals in a match, not a linear per-unit stat'),
    ('all', 'penalty_miss', -2, 'placeholder'),
    ('all', 'yellow_card', -1, 'placeholder'),
    ('all', 'red_card', -3, 'placeholder'),
    ('all', 'own_goal', -2, 'placeholder'),
    ('GK', 'goal', 10, 'placeholder'),
    ('GK', 'clean_sheet_60min', 4, 'placeholder'),
    ('GK', 'goals_conceded_per_2', -1, 'placeholder'),
    ('GK', 'saves_per_3', 1, 'placeholder'),
    ('GK', 'penalty_save', 5, 'placeholder'),
    ('DEF', 'goal', 6, 'placeholder'),
    ('DEF', 'clean_sheet_60min', 4, 'placeholder'),
    ('DEF', 'goals_conceded_per_2', -1, 'placeholder'),
    ('DEF', 'clearances_per_4', 1, 'placeholder'),
    ('DEF', 'blocks_per_2', 1, 'placeholder'),
    ('DEF', 'tackles_per_2', 1, 'placeholder'),
    ('MID', 'goal', 5, 'placeholder'),
    ('MID', 'key_pass', 1, 'placeholder'),
    ('MID', 'shot_on_target', 1, 'placeholder'),
    ('MID', 'interception', 1, 'placeholder'),
    ('FWD', 'goal', 4, 'placeholder'),
    ('FWD', 'key_pass', 1, 'placeholder'),
    ('FWD', 'shot_on_target', 1, 'placeholder'),
    ('CLUB', 'win', 6, 'placeholder'),
    ('CLUB', 'draw', 2, 'placeholder'),
    ('CLUB', 'away_win_bonus', 1, 'placeholder - additional to win, only when the win was away'),
    ('CLUB', 'clean_sheet', 2, 'placeholder'),
    ('CLUB', 'two_plus_goals', 1, 'placeholder'),
    ('CLUB', 'four_plus_goals', 2, 'placeholder - additional to two_plus_goals')
) as v(applies_to, stat, points, notes)
where fg.slug = 'eflfantasy'
on conflict (game_id, applies_to, stat) do update set points = excluded.points, notes = excluded.notes;
