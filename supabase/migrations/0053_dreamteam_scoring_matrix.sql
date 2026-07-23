-- Dream Team's real scoring matrix (Section 3.2.4 of Dream Team's own
-- official rules, pasted in full by the user) - this table already exists
-- (migration 0021, seeded for fanteam only) and its shape needs no
-- changes: applies_to/stat/points is exactly generic enough for a second
-- game.
--
-- Seeding this is what flips compute_projections.py from "v1" blended
-- mode to "v2-decomposed" mode for dreamteam - the switch is literally
-- `use_v2 = len(scoring_rules) > 0` (see fetch_scoring_rules/main() in
-- that script), no other code path decision needed.
--
-- 'save' and 'tackle' both use FanTeam's own existing convention for a
-- "points per 2" rule: enter the per-single-unit equivalent (0.5) rather
-- than inventing a "_per_2" stat name + STAT_RATE_SCALE entry (FanTeam's
-- own 'save' row already does exactly this: 0.5, not 1-per-2). Only
-- goals_conceded_per_2 needs the separate rate-scaling mechanism, and it
-- already exists in compute_projections.py for FanTeam - reused as-is.
--
-- Dream Team's real goals-conceded rule has a "free first goal" (0-1
-- conceded = 0pts, 2 conceded = -1, 3 = -2, ...) that this flat linear
-- per-2 mechanism doesn't capture exactly - a documented, minor known
-- approximation (see compute_projections.py), not worth bespoke
-- non-linear logic for a stat that isn't this pass's actual target
-- (bonus points are).
--
-- Bonus points (the PPM-tier system) are NOT a row here - they're a
-- derived, two-stage value (12 raw per-match rates -> summed PPM score ->
-- tiered step function) that doesn't fit this table's flat "rate x
-- points" shape at all. Computed by a dedicated function in
-- compute_projections.py instead.

insert into game_scoring_rules (game_id, applies_to, stat, points, notes)
select fg.id, v.applies_to, v.stat, v.points, v.notes
from fantasy_games fg, (values
    ('all', 'goal', 6, null),
    ('all', 'assist', 3, null),
    ('all', 'shot_on_target', 1, null),
    ('all', 'big_chance_created', 1, null),
    ('all', 'tackle', 0.5, '1 point per 2 successful tackles'),
    ('all', 'appearance', 1, 'up to 59 minutes on pitch'),
    ('all', 'minutes_60_plus', 1, 'additional point for reaching the 60th minute'),
    ('all', 'yellow_card', -1, null),
    ('all', 'red_card', -3, null),
    ('all', 'penalty_miss', -3, null),
    ('all', 'own_goal', -2, null),
    ('GK', 'save', 0.5, '1 point per 2 saves'),
    ('GK', 'penalty_save', 3, null),
    ('GK', 'clean_sheet_60min', 5, null),
    ('GK', 'goals_conceded_per_2', -1, 'approximated as linear per-2 conceded - real rule has a free first goal, see compute_projections.py'),
    ('DEF', 'clean_sheet_60min', 5, null),
    ('DEF', 'goals_conceded_per_2', -1, 'approximated as linear per-2 conceded - real rule has a free first goal, see compute_projections.py')
) as v(applies_to, stat, points, notes)
where fg.slug = 'dreamteam'
on conflict (game_id, applies_to, stat) do update set points = excluded.points, notes = excluded.notes;
