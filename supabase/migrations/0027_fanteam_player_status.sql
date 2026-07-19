-- FanTeam's live players API (round=editable) includes two per-player,
-- per-gameweek fields on every playerChoices record - `lineup` (observed
-- live so far: only "expected") and `status` (observed live so far: only
-- "not_started") - see scraper_fanteam.py / import_fanteam_live.py.
-- These are believed to map to FanTeam's own pre-match badges (STA/BEN/
-- NOT/EXP/MAY/NES/INJ/SUS/N-A/OFF, from a user screenshot of FanTeam's
-- site) - Hail Mary Score needs this to discount rotation-risk/injured/
-- suspended players before the squad-lock deadline.
--
-- game_players is one row per (game, player), continually overwritten on
-- re-scrape - not gameweek-scoped, so it can't hold this. Separate table,
-- keyed (game_player_id, gameweek), upsert-overwrite on each re-import -
-- same "last scrape wins" semantics game_players already uses for price/
-- position_code, not the append-and-dedup-latest pattern projections/
-- player_score_by_horizon use (migration 0024) - there's no current need
-- to keep a history of every status change, only the latest known state
-- per gameweek. Revisit if that changes.
--
-- IMPORTANT - unconfirmed mapping: as of 2026-07-19 (~5 weeks before
-- kickoff) every one of 578 players shows the same two values above, so
-- the exact raw strings for INJ/SUS/benched/etc. are NOT yet confirmed.
-- This table just captures whatever FanTeam sends, verbatim, so the
-- mapping can be verified once real variance appears - see
-- compute_projections.py's LINEUP_MULTIPLIERS/STATUS_MULTIPLIERS and
-- scripts/verify_player_status_mapping.py.

create table fanteam_player_status (
  id bigint generated always as identity primary key,
  game_player_id bigint not null references game_players(id) on delete cascade,
  gameweek int not null,
  lineup text,            -- raw FanTeam value, e.g. "expected" (STA/BEN/NOT/EXP/MAY/NES family - unconfirmed)
  status text,            -- raw FanTeam value, e.g. "not_started" (INJ/SUS/N-A/OFF family - unconfirmed, may even be an unrelated live-match-progress flag - see compute_projections.py)
  scraped_at timestamptz not null default now(),
  unique (game_player_id, gameweek)
);

create index on fanteam_player_status (game_player_id);

alter table fanteam_player_status enable row level security;
create policy "public read" on fanteam_player_status for select using (true);

-- Extend the squad-builder/transfer pool view (migration 0012) with each
-- player's most-recently-captured status, so SquadBuilder/TransferBoard's
-- existing select("*") queries get it for free - no frontend query change
-- needed. "Most recent" = highest captured gameweek, ties broken by
-- scraped_at, since round=editable only ever returns the currently-open
-- gameweek's status (there's normally nothing to tie-break, but re-scrapes
-- within the same gameweek should still resolve to the newest one).
create or replace view game_player_pool as
select
    fg.slug as game_slug,
    gp.id as game_player_id,
    p.full_name,
    p.position,
    t.id as team_id,
    t.name as team_name,
    gp.price,
    latest_proj.hail_mary_score,
    latest_status.lineup,
    latest_status.status
from game_players gp
join players p on p.id = gp.player_id
join teams t on t.id = p.team_id
join fantasy_games fg on fg.id = gp.game_id
left join lateral (
    select hail_mary_score
    from projections pr
    where pr.game_player_id = gp.id
    order by pr.created_at desc
    limit 1
) latest_proj on true
left join lateral (
    select lineup, status
    from fanteam_player_status s
    where s.game_player_id = gp.id
    order by s.gameweek desc, s.scraped_at desc
    limit 1
) latest_status on true
where gp.is_active;
