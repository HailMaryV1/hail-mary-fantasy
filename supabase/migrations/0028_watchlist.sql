-- Fixture Swing Intelligence & Watchlist, Part 2 - lets a user save
-- players to monitor. Shared across all of a user's squads within a
-- game (confirmed with the user - watching a player is account+game
-- level, not tied to one specific squad), so keyed by
-- (user_id, game_id, game_player_id), NOT squad_id. "Transfer In"
-- separately resolves WHICH squad to apply a transfer to at click time.
--
-- watch_reasons is a text[] with a check constraint, not a Postgres
-- enum - this codebase never uses `create type ... as enum` anywhere
-- (players.position uses `check (position in (...))` instead - see
-- migration 0001), and a player can plausibly be watched for more than
-- one reason at once (e.g. both "Fixture Swing" and "Differential").
--
-- last_seen_* columns are a snapshot of the previous page load's
-- computed state, used by the alert logic (frontend/src/lib/watchlistAlerts.ts)
-- to detect changes since last viewed ("score increased", "entered a
-- bad run", "became unavailable") without any new background job -
-- the watchlist page itself updates these right after computing alerts
-- on each render.

create table watchlist_entries (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  game_id bigint not null references fantasy_games(id) on delete cascade,
  game_player_id bigint not null references game_players(id) on delete cascade,
  watch_reasons text[] not null default '{}',
  notes text,
  added_at timestamptz not null default now(),
  last_seen_score numeric,
  last_seen_lineup text,
  last_seen_status text,
  last_seen_swing_kind text,  -- 'good' | 'bad' | null - nearest detected fixture run's kind
  constraint watchlist_entries_reasons_valid check (
    watch_reasons <@ array[
      'fixture_swing', 'differential', 'form', 'price_watch',
      'injury_return', 'minutes_increasing', 'buy_target', 'sell_watch'
    ]::text[]
  ),
  unique (user_id, game_id, game_player_id)
);

create index on watchlist_entries (user_id, game_id);

alter table watchlist_entries enable row level security;

create policy "own watchlist select" on watchlist_entries for select using (auth.uid() = user_id);
create policy "own watchlist insert" on watchlist_entries for insert with check (auth.uid() = user_id);
create policy "own watchlist update" on watchlist_entries for update using (auth.uid() = user_id);
create policy "own watchlist delete" on watchlist_entries for delete using (auth.uid() = user_id);
