-- Provider competitions become a first-class entity instead of a
-- denormalized string on provider_squad_links. A FanTeam "competition"
-- (e.g. "EPL Fantasy Season Game [Micro]") is a real external object
-- with its own name/sport/status that can hold MULTIPLE squad entries
-- (e.g. several separate teams you've entered into the same weekly
-- contest) - status (Upcoming/Running) is a property of the
-- competition as a whole, not of any one entry within it, so it
-- belongs here rather than repeated per squad link.
--
-- competition_name/sport are NOT NULL deliberately - a row only ever
-- gets written once both are reliably known (see
-- provider_fanteam_scoutgg.py's fetch_tournament_meta, which reads the
-- real gameType/name fields straight off FanTeam's own tournament API -
-- confirmed live: gameType is the literal string "football" for the
-- real account's real EPL entry). There is no such thing as a
-- half-populated Golf/NFL row in this table.
--
-- Buy-in is deliberately left unpopulated for now: the tournament API's
-- own buyIn/currency fields were confirmed live to be denominated in
-- FanTeam's base currency (EUR, e.g. 0.97) rather than the GBP amount
-- actually shown to the user on FanTeam's own UI (e.g. "£1.00") -
-- populating from the wrong-currency field would show something
-- actively misleading, so amount/currency/label all start null until a
-- reliable GBP-denominated source is confirmed.
create table provider_competitions (
  id bigint generated always as identity primary key,
  provider text not null check (provider in ('fanteam_scoutgg', 'dreamteamfc', 'cloudff')),
  external_competition_id text not null,
  competition_name text not null,
  sport text not null,
  season text,
  buy_in_amount numeric,
  buy_in_currency text,
  buy_in_label text,
  status text check (status in ('upcoming', 'running', 'ended')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, external_competition_id)
);

alter table provider_squad_links
  add column competition_id bigint references provider_competitions(id),
  -- Your position within a competition - a property of the entry, not
  -- the competition itself (multiple squads in the same competition can
  -- have different ranks). No extraction path exists yet (the real
  -- account's only entry shows "-", pre-season); populated once GW1
  -- produces a real rank.
  add column current_rank integer;

create index on provider_squad_links (competition_id);

alter table provider_competitions enable row level security;

-- Same "own row" shape as provider_squad_links itself - a competition
-- is only visible to a user through a squad link they own, never
-- broad/public.
create policy "own provider competitions select" on provider_competitions for select
  using (
    exists (
      select 1
      from provider_squad_links psl
      join squads s on s.id = psl.squad_id
      where psl.competition_id = provider_competitions.id and s.user_id = auth.uid()
    )
  );
