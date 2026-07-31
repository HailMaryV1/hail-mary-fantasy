-- Auto Import My Squad - shared architecture across every provider
-- (FanTeam Football/Golf/NFL share one Scout Gaming login; Dream Team and
-- Cloud Fantasy Football each have their own). Two tables, deliberately
-- split by sensitivity:
--
-- provider_credentials holds the actual auth material (tokens, session
-- state, or - only as a last resort - a password) ENCRYPTED at the
-- application layer before it ever reaches this table (see
-- scripts/provider_secrets.py) - this table stores ciphertext only, never
-- a plaintext secret. RLS is enabled with NO policies at all, for anyone -
-- not even the owning user gets a select/insert/update policy here. Only
-- the service-role key (which bypasses RLS entirely - see
-- frontend/src/lib/supabaseServiceClient.ts's established privileged-write
-- pattern from the golf importer) and the Python sync scripts (service
-- role via DATABASE_URL) can ever touch it. The frontend's "Sync Now"
-- button never reads or writes this table - it only ever touches
-- provider_squad_links.sync_requested_at.
--
-- provider_squad_links maps one Hail Mary squad to exactly one external
-- provider team/entry - the row a re-sync always targets, which is what
-- makes re-syncing idempotent (update-in-place) instead of duplicate-
-- creating. unique(squad_id) and unique(provider, external_team_id)
-- enforce that 1:1 relationship in both directions.
create table provider_credentials (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  -- One row per (user, provider) - FanTeam Football/Golf/NFL all share
  -- the 'fanteam_scoutgg' row since they're one Scout Gaming account.
  provider text not null check (provider in ('fanteam_scoutgg', 'dreamteamfc', 'cloudff')),
  -- Preference order per the user's explicit instruction: prefer a
  -- rotating refresh/access token pair; fall back to a saved encrypted
  -- browser session (Playwright storage_state) only if a provider has no
  -- real token endpoint; encrypted_password is the last resort, only for
  -- a provider where neither of the above can be automated.
  auth_method text not null check (auth_method in ('refresh_token', 'session_state', 'encrypted_password')),
  encrypted_access_token text,
  access_token_expires_at timestamptz,
  encrypted_refresh_token text,
  encrypted_session_state text,
  encrypted_username text,
  encrypted_password text,
  last_refreshed_at timestamptz,
  last_refresh_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

create table provider_squad_links (
  id bigint generated always as identity primary key,
  squad_id bigint not null references squads(id) on delete cascade,
  provider text not null check (provider in ('fanteam_scoutgg', 'dreamteamfc', 'cloudff')),
  -- The provider's own contest/tournament id and this user's team/entry id
  -- within it - what fetch_json(BASE + "/tournaments/{external_tournament_id}/...")-
  -- style calls key off (see scraper_fanteam.py's existing TOURNAMENT_ID
  -- pattern, generalised here to be per-squad instead of hardcoded).
  external_tournament_id text not null,
  external_team_id text not null,
  external_user_id text,
  sync_enabled boolean not null default true,
  -- Set by the frontend's "Sync Now" button (an update the OWNING user is
  -- allowed to make - see the policy below); cleared by the sync job once
  -- it picks the row up. A short-cadence scheduled job (matching the
  -- existing 5-minute golf-live-scores precedent) polls for non-null
  -- values here rather than the frontend calling any sync logic directly -
  -- keeps every provider credential and API call server-side only.
  sync_requested_at timestamptz,
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never', 'ok', 'error')),
  last_sync_error text,
  -- Human-readable summary of the most recent real change detected
  -- (captain swap, transfer, formation change...) - shown on the squad
  -- page, same spirit as activity_log's own summary strings.
  last_change_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (squad_id),
  unique (provider, external_team_id)
);

create index on provider_squad_links (sync_requested_at) where sync_requested_at is not null;
create index on provider_squad_links (provider, sync_enabled) where sync_enabled;

alter table provider_credentials enable row level security;
alter table provider_squad_links enable row level security;

-- provider_credentials: deliberately zero policies - default-deny for
-- anon and authenticated alike. Only a service-role connection reaches
-- this table at all.

-- provider_squad_links carries no secrets (just ids/status/timestamps),
-- so it follows the same "own row" pattern as squad_transfers - the owner
-- can see their own link's sync status and request a sync; row creation
-- and the actual squad-data writes stay service-role-only (the sync
-- backend, not the frontend, decides when a link is first created).
create policy "own provider squad links select" on provider_squad_links for select
  using (exists (select 1 from squads where squads.id = provider_squad_links.squad_id and squads.user_id = auth.uid()));
create policy "own provider squad links request sync" on provider_squad_links for update
  using (exists (select 1 from squads where squads.id = provider_squad_links.squad_id and squads.user_id = auth.uid()))
  with check (exists (select 1 from squads where squads.id = provider_squad_links.squad_id and squads.user_id = auth.uid()));
