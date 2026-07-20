-- NFL FanTeam - Stage 1 data foundation. Widens the shared players/teams
-- identity layer to cover NFL positions (players/game_players/squads and
-- everything hanging off game_player_id are already game-agnostic - Dream
-- Team and FanTeam already coexist in these same tables today, so a third
-- game via the same mechanism is the proven pattern, not a new risk), adds
-- NFL-specific quota columns to game_squad_rules (nullable, same "null =
-- not applicable" convention already used by max_per_club), seeds the
-- confirmed NFL FanTeam squad/scoring rules (pulled directly off FanTeam's
-- own live rules pages), and adds a typed nfl_game_player_stats table since
-- NFL's stat categories don't fit game_player_stats' soccer-named columns.

-- 1. Widen the position CHECK to add NFL positions alongside soccer's.
alter table players drop constraint players_position_check;
alter table players add constraint players_position_check
  check (position in ('GK', 'DEF', 'MID', 'FWD', 'QB', 'RB', 'WR', 'TE', 'DST'));

-- 2. NFL-specific squad quota columns (nullable - unused by soccer rows).
alter table game_squad_rules add column qb_quota int;
alter table game_squad_rules add column rb_quota int;
alter table game_squad_rules add column wr_quota int;
alter table game_squad_rules add column te_quota int;
alter table game_squad_rules add column dst_quota int;

-- 3. The 32 NFL teams.
insert into teams (name, short_name) values
  ('Buffalo Bills', 'Bills'),
  ('Miami Dolphins', 'Dolphins'),
  ('New England Patriots', 'Patriots'),
  ('New York Jets', 'Jets'),
  ('Baltimore Ravens', 'Ravens'),
  ('Cincinnati Bengals', 'Bengals'),
  ('Cleveland Browns', 'Browns'),
  ('Pittsburgh Steelers', 'Steelers'),
  ('Houston Texans', 'Texans'),
  ('Indianapolis Colts', 'Colts'),
  ('Jacksonville Jaguars', 'Jaguars'),
  ('Tennessee Titans', 'Titans'),
  ('Denver Broncos', 'Broncos'),
  ('Kansas City Chiefs', 'Chiefs'),
  ('Las Vegas Raiders', 'Raiders'),
  ('Los Angeles Chargers', 'Chargers'),
  ('Dallas Cowboys', 'Cowboys'),
  ('New York Giants', 'Giants'),
  ('Philadelphia Eagles', 'Eagles'),
  ('Washington Commanders', 'Commanders'),
  ('Chicago Bears', 'Bears'),
  ('Detroit Lions', 'Lions'),
  ('Green Bay Packers', 'Packers'),
  ('Minnesota Vikings', 'Vikings'),
  ('Atlanta Falcons', 'Falcons'),
  ('Carolina Panthers', 'Panthers'),
  ('New Orleans Saints', 'Saints'),
  ('Tampa Bay Buccaneers', 'Buccaneers'),
  ('Arizona Cardinals', 'Cardinals'),
  ('Los Angeles Rams', 'Rams'),
  ('San Francisco 49ers', '49ers'),
  ('Seattle Seahawks', 'Seahawks')
on conflict (name) do nothing;

-- 4. Odds API aliases for those teams (belt-and-braces alongside the exact
-- teams.name match resolve_team_id() already falls back to - see
-- scripts/import_fixtures_odds.py).
insert into team_aliases (team_id, source, external_name)
select t.id, 'oddsapi', t.name from teams t
where t.name in (
  'Buffalo Bills', 'Miami Dolphins', 'New England Patriots', 'New York Jets',
  'Baltimore Ravens', 'Cincinnati Bengals', 'Cleveland Browns', 'Pittsburgh Steelers',
  'Houston Texans', 'Indianapolis Colts', 'Jacksonville Jaguars', 'Tennessee Titans',
  'Denver Broncos', 'Kansas City Chiefs', 'Las Vegas Raiders', 'Los Angeles Chargers',
  'Dallas Cowboys', 'New York Giants', 'Philadelphia Eagles', 'Washington Commanders',
  'Chicago Bears', 'Detroit Lions', 'Green Bay Packers', 'Minnesota Vikings',
  'Atlanta Falcons', 'Carolina Panthers', 'New Orleans Saints', 'Tampa Bay Buccaneers',
  'Arizona Cardinals', 'Los Angeles Rams', 'San Francisco 49ers', 'Seattle Seahawks'
)
on conflict (source, external_name) do nothing;

-- 5. Squad rules: 9 players, fixed 1 QB / 2 RB / 4 WR / 1 TE / 1 DST, no
-- bench, £130M budget, max 3 per real team (all confirmed live on
-- FanTeam's own "Rules" tab for NFL Regular Season 2025/26).
insert into game_squad_rules (
  game_id, squad_size, starting_size, budget, max_per_club, uses_formations,
  qb_quota, rb_quota, wr_quota, te_quota, dst_quota
)
select id, 9, 9, 130, 3, false, 1, 2, 4, 1, 1
from fantasy_games where slug = 'nfl-fanteam';

-- 6. Odds API competition mapping - import_fixtures_odds.py already loops
-- over every distinct competition in this table with no code change needed.
insert into game_competitions (game_id, competition)
select id, 'americanfootball_nfl' from fantasy_games where slug = 'nfl-fanteam';

-- 7. Scoring rules, confirmed off FanTeam's own "Scoring" modal (Offense +
-- Defense tabs) for NFL Regular Season 2025/26. Offense stats are 'all'
-- since any rostered position can in principle post them (e.g. a WR
-- throwing a trick-play TD); DST is a whole-team defense/special-teams
-- unit, so its stats (including the points-allowed tiers, each its own row
-- since it's a categorical/tiered value rather than a per-unit rate) are
-- scored separately under 'DST'. 'return_td' is listed on both the Offense
-- and Defense tabs at the same value, so it gets a row under each.
insert into game_scoring_rules (game_id, applies_to, stat, points, notes)
select fg.id, v.applies_to, v.stat, v.points, v.notes
from fantasy_games fg, (values
    ('all', 'pass_yard', 0.04, 'passing yards'),
    ('all', 'rush_yard', 0.1, 'rushing yards'),
    ('all', 'rec_yard', 0.1, 'receiving yards'),
    ('all', 'pass_td', 4, null),
    ('all', 'rush_td', 6, null),
    ('all', 'rec_td', 6, null),
    ('all', 'return_td', 6, 'punt/kickoff/FG return for touchdown'),
    ('all', 'interception_thrown', -2, null),
    ('all', 'reception', 1, 'full PPR'),
    ('all', 'fumble_lost', -2, null),
    ('all', 'two_pt_conversion', 2, null),
    ('DST', 'sack', 1, null),
    ('DST', 'def_interception', 2, null),
    ('DST', 'fumble_recovery', 2, null),
    ('DST', 'safety', 2, null),
    ('DST', 'blocked_kick', 2, null),
    ('DST', 'def_return_td', 6, 'interception/fumble recovery touchdown'),
    ('DST', 'return_td', 6, 'punt/kickoff/FG return for touchdown'),
    ('DST', 'points_allowed_tier_0', 10, '0 points allowed'),
    ('DST', 'points_allowed_tier_1_6', 7, '1-6 points allowed'),
    ('DST', 'points_allowed_tier_7_13', 4, '7-13 points allowed'),
    ('DST', 'points_allowed_tier_14_20', 1, '14-20 points allowed'),
    ('DST', 'points_allowed_tier_21_27', 0, '21-27 points allowed (implied - not shown on FanTeam''s own scoring table)'),
    ('DST', 'points_allowed_tier_28_34', -1, '28-34 points allowed'),
    ('DST', 'points_allowed_tier_35_plus', -4, '35+ points allowed')
) as v(applies_to, stat, points, notes)
where fg.slug = 'nfl-fanteam'
on conflict (game_id, applies_to, stat) do update set points = excluded.points, notes = excluded.notes;

-- 8. NFL box-score stats. Kept as real typed columns (not game_player_stats'
-- soccer-named columns, and not raw_stats jsonb) so a later NFL projections
-- script can read them the same way compute_projections.py already reads
-- named soccer stat columns.
create table nfl_game_player_stats (
  id bigint generated always as identity primary key,
  game_player_id bigint not null references game_players(id) on delete cascade,
  season text not null,
  gameweek int,
  pass_yards numeric not null default 0,
  pass_tds int not null default 0,
  pass_ints int not null default 0,
  rush_yards numeric not null default 0,
  rush_tds int not null default 0,
  receptions int not null default 0,
  rec_yards numeric not null default 0,
  rec_tds int not null default 0,
  return_tds int not null default 0,
  fumbles_lost int not null default 0,
  two_pt_conversions int not null default 0,
  def_sacks numeric not null default 0,
  def_interceptions int not null default 0,
  def_fumble_recoveries int not null default 0,
  def_safeties int not null default 0,
  def_blocked_kicks int not null default 0,
  def_touchdowns int not null default 0,
  points_allowed int,
  total_points numeric,
  raw_stats jsonb not null default '{}',
  unique (game_player_id, season, gameweek)
);

alter table nfl_game_player_stats enable row level security;
create policy "public read" on nfl_game_player_stats for select using (true);

-- 9. NFL moneyline markets have no draw leg - import_fixtures_odds.py's
-- 3-way parsing branch (skipping any draw-less event) gets updated when the
-- NFL odds pipeline is actually built; this just unblocks the schema.
alter table fixture_odds alter column draw_price drop not null;
