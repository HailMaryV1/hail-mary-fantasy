-- Backing table for the "Update Odds" button (2026-08-08 user request) -
-- one row per game, showing whether an on-demand odds refresh is
-- currently running and when it last finished, so the frontend can
-- show a loading state and know when to stop polling and refresh.
-- Same requested_at/status shape as provider_squad_links' existing
-- sync-tracking columns (migration 0071), not a new pattern.
create table odds_refresh_status (
    game_id bigint primary key references fantasy_games(id) on delete cascade,
    requested_at timestamptz,
    completed_at timestamptz,
    status text not null default 'idle' check (status in ('idle', 'running', 'ok', 'error')),
    error_message text
);

insert into odds_refresh_status (game_id, status)
select id, 'idle' from fantasy_games
on conflict (game_id) do nothing;

alter table odds_refresh_status enable row level security;
create policy "public read" on odds_refresh_status for select using (true);
-- Not user-owned data (one row per game, shared across the app) - the
-- real gate is requireSignedIn() in the dispatch server action itself,
-- same split already used for provider_squad_links' own sync-request
-- write (RLS just needs to allow it for anyone actually logged in).
create policy "authenticated update" on odds_refresh_status for update using (auth.role() = 'authenticated');
