-- Real confirmed starting XI + pitch formation position, scraped from
-- Spreadex's own "Team-Line-Ups" pitch view (2026-08-30 user request -
-- "switch the pipeline for the fouls board to bring from spreadex").
-- Replaces SportMonks' fixtures?include=lineups;formations;participants,
-- which the Fouls tool (frontend-v2/src/lib/sportmonksFouls.ts) used for
-- exactly this - real starters, shirt numbers, and grid position (row is
-- goalkeeper-to-attack, col is touchline-to-touchline) that the duel map
-- (foulsMatchup.ts) turns into a lateral 0-1 pitch coordinate per player.
--
-- Mirrors fixture_player_props' own append-friendly shape rather than
-- upsert-in-place: a lineup is genuinely a point-in-time snapshot (a late
-- change before kickoff is real news, not noise to overwrite silently),
-- and the reader always wants "the latest capture for this fixture" -
-- same "distinct on, order by captured_at desc" convention every other
-- real-time table in this project already uses.
create table fixture_lineups (
  id bigint generated always as identity primary key,
  fixture_id bigint not null references fixtures(id) on delete cascade,
  team_id bigint not null references teams(id),
  player_id bigint references players(id),
  player_name_raw text not null,
  shirt_number integer,
  -- Pitch grid, same convention as SportMonks' own formation_field
  -- ("row:col") that foulsMatchup.ts already parses - row 1 is the
  -- goalkeeper, ascending toward attack; col is an ABSOLUTE touchline
  -- position (not flipped per team), confirmed live 2026-08-29 that this
  -- is what puts opposing full-backs on the correct facing side for the
  -- duel map. row_width is how many players share this player's row,
  -- needed to normalise col into a 0-1 lateral position the same way
  -- lateralOf() in sportmonksFouls.ts already does.
  formation_row integer,
  formation_col integer,
  row_width integer,
  is_starter boolean not null default true,
  captured_at timestamptz not null default now()
);

create index on fixture_lineups (fixture_id, captured_at desc);

alter table fixture_lineups enable row level security;
create policy "public read" on fixture_lineups for select using (true);
