-- FanTeam's real scoring matrix (from the user, off FanTeam's own rules
-- page) - stored now so it's captured rather than lost, even though
-- the algorithm doesn't consume it yet. points_per_90 currently uses
-- FanTeam's own reported total_points from last season, which already
-- implicitly reflects this matrix - but having it explicit is what a
-- smarter v2 algorithm needs: projecting individual stat probabilities
-- (expected goals from attack_score, expected clean sheets from the
-- clean-sheet market, etc.) and converting each through its real point
-- value, instead of scaling one blunt historical rate by a fixture
-- factor. That rebuild is real algorithm work, not a quick addition -
-- tracked as the next big piece, not attempted here.

create table game_scoring_rules (
  id bigint generated always as identity primary key,
  game_id bigint not null references fantasy_games(id) on delete cascade,
  applies_to text not null,   -- 'all' | 'GK' | 'DEF' | 'MID' | 'FWD'
  stat text not null,         -- e.g. 'goal', 'assist', 'clean_sheet_60min', 'appearance'
  points numeric(5, 2) not null,
  notes text,
  unique (game_id, applies_to, stat)
);

alter table game_scoring_rules enable row level security;
create policy "public read" on game_scoring_rules for select using (true);

insert into game_scoring_rules (game_id, applies_to, stat, points, notes)
select fg.id, v.applies_to, v.stat, v.points, v.notes
from fantasy_games fg, (values
    ('all', 'appearance', 1, null),
    ('all', 'minutes_60_plus', 3, '60+ minutes on pitch'),
    ('all', 'assist', 3, 'assist or fantasy assist'),
    ('all', 'caused_penalty', -2, null),
    ('all', 'caused_scoring_free_kick', -2, null),
    ('all', 'penalty_miss', -2, null),
    ('all', 'own_goal', -2, null),
    ('all', 'yellow_card', -1, null),
    ('all', 'red_card', -3, null),
    ('all', 'positive_impact', 0.3, null),
    ('all', 'negative_impact', -0.3, null),
    ('GK', 'penalty_save', 5, null),
    ('GK', 'save', 0.5, null),
    ('GK', 'clean_sheet_60min', 4, null),
    ('GK', 'goals_conceded_per_2', -1, null),
    ('GK', 'goal', 8, null),
    ('GK', 'shot_on_target', 1, null),
    ('DEF', 'goal', 6, null),
    ('DEF', 'clean_sheet_60min', 4, null),
    ('DEF', 'shot_on_target', 0.6, null),
    ('DEF', 'goals_conceded_per_2', -1, null),
    ('MID', 'goal', 5, null),
    ('MID', 'clean_sheet_60min', 1, null),
    ('MID', 'played_full_match', 1, null),
    ('MID', 'shot_on_target', 0.4, null),
    ('FWD', 'goal', 4, null),
    ('FWD', 'played_full_match', 1, null),
    ('FWD', 'shot_on_target', 0.4, null)
) as v(applies_to, stat, points, notes)
where fg.slug = 'fanteam'
on conflict (game_id, applies_to, stat) do update set points = excluded.points, notes = excluded.notes;
