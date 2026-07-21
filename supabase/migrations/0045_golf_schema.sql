-- FanTeam Golf - Single Gameweek mode, Phase 1 (schema + importer target).
-- See the approved plan for the full investigation this is based on -
-- short version: FanTeam's golf data lives at
-- https://fanteam-game.api.scoutgg.net/tournaments/{id}/players?round=editable
-- (unauthenticated, confirmed live against a real tournament, "The 3M
-- Open" - tournament_id 1131817), returning ~140 golfers per tournament
-- with price/lineup/status/form plus rich but sparse avg/total stat
-- blobs (made-cut rate, birdie/eagle/bogey rates, bounce-back, finish
-- tiers - the exact key set varies per golfer, 30+ distinct keys
-- observed).
--
-- Why golf gets its OWN identity table instead of the NFL playbook
-- (widen players/teams in place): NFL worked because NFL positions are
-- real discrete squad-quota categories and NFL teams are real teams.
-- Golf has neither - players.position is NOT NULL with a closed CHECK
-- (confirmed by reading migration 0001, not assumed), and a golfer has
-- no real team (FanTeam's own API boxes every golfer into a fake
-- pseudo-team, "PGA Tour 2026", purely so its generic match-based engine
-- has something to point at - mirroring that would copy an artifact, not
-- a real concept). game_player_pool's existing view also INNER JOINs
-- teams, so a null-team players row would silently vanish from it.
-- Instead: a small dedicated `golfers` table, and `game_players` (already
-- the fully generic "this game's price/external-ID mapping" layer)
-- widened with a second nullable FK so everything already hanging off
-- game_players.id - projections, algorithm_versions, squad_players, the
-- whole prediction/performance-tracking stack - keeps working for golf
-- completely unchanged.
--
-- Why golf pricing is tournament-scoped, not the mutable game_players.price
-- singleton football uses: a wholly new player pool/price sheet drops
-- every tournament, and past tournaments' prices must never be
-- overwritten (confirmed requirement). `golf_tournament_entries` is the
-- source of truth, keyed unique(tournament_id, game_player_id) so
-- re-running the importer against the same tournament is always a safe
-- upsert. game_players.price stays a "last-seen" convenience cache, same
-- role it already plays for football.
--
-- Why golf's "gameweek" is populated for real (not period_start/
-- period_end like NFL/Dream Team): the API's `round` field (e.g. 27,
-- "the 27th PGA Tour event of the season") is a real sequential
-- per-season integer, exactly like football's gameweek - the stronger of
-- the two existing paths, not a new one.
--
-- Why golf squads reuse squads/squad_players directly with no
-- transfer/wildcard machinery: FanTeam golf is DFS-shaped
-- (maxFantasyTeamsPerUser: 20 - multiple independent entries per
-- tournament), not a season-long persistent team. A golf "squad" is "my
-- lineup for tournament X" - squads.golf_tournament_id records which.
-- free_transfers/wildcard columns simply stay unused (default/null) for
-- golf rows, same "null = not applicable" convention NFL's own quota
-- columns already use on football rows and vice versa.
--
-- `golf_tournaments.game_scope` is populated straight from the API's own
-- `gameScope` field ("single" today) - this future-proofs Season Game
-- for free: when it eventually gets built, its data lands in this exact
-- same table shape with game_scope = "season", zero schema change then.

-- 1. Golf's own identity table - see rationale above.
create table golfers (
  id bigint generated always as identity primary key,
  full_name text not null,
  country text,
  sporty_id text unique,   -- ScoutGG's internal player ID (realPlayer.sportyId) - the only stable external ID FanTeam exposes
  created_at timestamptz not null default now()
);

alter table golfers enable row level security;
create policy "public read" on golfers for select using (true);

-- 2. Widen game_players to anchor either a team-sport player or an
-- individual-athlete golfer - see rationale above. Purely additive:
-- every existing row already has player_id set and trivially satisfies
-- the check.
alter table game_players alter column player_id drop not null;
alter table game_players alter column price drop not null;
alter table game_players add column golfer_id bigint references golfers(id) on delete cascade;
alter table game_players add constraint game_players_player_xor_golfer
  check ((player_id is not null) != (golfer_id is not null));
create index on game_players (golfer_id);

-- 3. The game itself - minimal first-migration pattern NFL used
-- (migration 0037), so the gateway page picks it up automatically (it's
-- already fully DB-driven off fantasy_games).
insert into fantasy_games (slug, display_name) values ('fanteam-golf', 'FanTeam Golf')
on conflict (slug) do nothing;

-- 4. One row per real tournament - golf's equivalent of a fixture
-- calendar, except each tournament IS the "gameweek" (see docstring
-- above), not a 2-team match fixtures could represent.
create table golf_tournaments (
  id bigint generated always as identity primary key,
  game_id bigint not null references fantasy_games(id) on delete cascade,
  fanteam_tournament_id text not null unique,  -- FanTeam's tournament.id, e.g. "1131817"
  fanteam_game_id text,        -- ScoutGG's recurring event-slot ID (matchCollection.id / tournament.gameId) - sibling tournament_ids (different buy-in tiers) share this for the same real event
  name text not null,
  tour text,                   -- e.g. "PGA Tour" (seasons[0].league.name)
  season_year int,
  event_number int,            -- the "round" field - sequential event number within the tour season, doubles as this event's gameweek
  game_scope text,             -- "single" | "season" (matchCollection.gameScope) - see docstring above
  registration_time timestamptz,  -- golf's deadline-equivalent
  start_time timestamptz,
  end_time timestamptz,
  status text not null default 'upcoming',  -- 'upcoming' | 'live' | 'completed'
  raw jsonb not null default '{}',  -- full tournament+matchCollection+seasons payload, for audit/debugging
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index on golf_tournaments (game_id);

alter table golf_tournaments enable row level security;
create policy "public read" on golf_tournaments for select using (true);

-- 5. The actual per-tournament player pool snapshot - see "tournament-
-- scoped pricing" rationale above. game_player_id is nullable until the
-- importer's name-matching resolves it (see import_fanteam_golf.py) -
-- unlike football, golf matching has no team/position bucket to
-- disambiguate by, so an entry can land unmatched pending manual review
-- rather than being silently guessed.
create table golf_tournament_entries (
  id bigint generated always as identity primary key,
  tournament_id bigint not null references golf_tournaments(id) on delete cascade,
  game_player_id bigint references game_players(id) on delete cascade,
  external_player_id text not null,  -- FanTeam's realPlayerId, stable across tournaments
  price numeric(6, 2),
  lineup text,       -- 'expected' | 'refuted' (confirmed live - 'refuted' = withdrawn)
  status text,       -- 'not_started' | 'not_play' (confirmed live)
  form numeric(6, 2),
  total_points numeric(8, 2),  -- FanTeam's own season-cumulative fantasy points
  last_points numeric(6, 2),
  active boolean not null default true,

  -- Typed core stats - promoted from avg_stats because these ~10 keys
  -- are present for nearly every golfer (confirmed: 136/140 in the
  -- reference pool), unlike the long sparse tail below. These are
  -- FanTeam's own pre-computed AVERAGE rates (avgStats), not totals.
  made_cut_rate numeric(5, 4),
  birdie_rate numeric(6, 2),
  bogey_rate numeric(6, 2),
  eagle_rate numeric(6, 2),
  double_bogey_rate numeric(6, 2),
  bounce_back_rate numeric(5, 4),
  score_avg numeric(6, 2),        -- avgStats.score - strokes relative to par (par - score-ish), see raw for exact semantics
  total_score_avg numeric(6, 2),  -- avgStats.totalScore - average score-to-par
  match_count int,   -- avgStats.matchCount - sample-size signal for shrinkage, same role games90 plays for football
  start_count int,

  -- Full sparse blobs - 30+ distinct keys observed across a single
  -- tournament's pool (top10/15/20/25/30/40/50/60, rank1-9, holeInOne,
  -- tripleBogeyOrWorse, threeConsecutiveBirdies, allFourSub70,
  -- remainingHoles, ...) - not a fixed schema, mirrors this project's
  -- existing raw_stats jsonb convention for exactly this shape of problem.
  avg_stats jsonb not null default '{}',
  total_stats jsonb not null default '{}',
  raw jsonb not null default '{}',  -- the whole playerChoice, for audit/debugging

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tournament_id, game_player_id)
);

create index on golf_tournament_entries (tournament_id);
create index on golf_tournament_entries (game_player_id);

alter table golf_tournament_entries enable row level security;
create policy "public read" on golf_tournament_entries for select using (true);

-- 6. Squad rules: 6 golfers, no bench, no positions, £100 budget, no
-- club limit (no clubs). Confirmed live against tournament.details on
-- the real 3M Open tournament.
insert into game_squad_rules (game_id, squad_size, starting_size, budget, max_per_club, uses_formations)
select id, 6, 6, 100, null, false from fantasy_games where slug = 'fanteam-golf'
on conflict (game_id) do nothing;

-- 7. Scoring rules - real stat vocabulary confirmed live (matches a
-- public FanTeam golf guide's own terminology almost 1:1), but exact
-- point values are NOT yet confirmed beyond hole-in-one/better-than-eagle
-- (10, confirmed via that same guide). Every unconfirmed row is priced
-- at 0 - deliberately inert rather than a plausible-looking guess - and
-- flagged in notes. Update in place the moment the real FanTeam scoring
-- table is available; no code changes needed when that happens.
insert into game_scoring_rules (game_id, applies_to, stat, points, notes)
select fg.id, 'all', v.stat, v.points, v.notes
from fantasy_games fg, (values
    ('birdie', 0, 'UNCONFIRMED - pending real FanTeam scoring table'),
    ('bogey', 0, 'UNCONFIRMED - pending real FanTeam scoring table'),
    ('eagle', 0, 'UNCONFIRMED - pending real FanTeam scoring table'),
    ('double_bogey', 0, 'UNCONFIRMED - pending real FanTeam scoring table'),
    ('triple_bogey_or_worse', 0, 'UNCONFIRMED - pending real FanTeam scoring table'),
    ('made_cut', 0, 'UNCONFIRMED - pending real FanTeam scoring table'),
    ('bounce_back', 0, 'UNCONFIRMED - "no dropped shots" style round bonus - pending real FanTeam scoring table'),
    ('no_bogeys', 0, 'UNCONFIRMED - par-or-better every hole in a round - pending real FanTeam scoring table'),
    ('round_of_64', 0, 'UNCONFIRMED - pending real FanTeam scoring table'),
    ('three_consecutive_birdies', 0, 'UNCONFIRMED - pending real FanTeam scoring table'),
    ('hole_in_one', 10, 'Confirmed via FanTeam''s own public golf guide - "better than eagle" (hole-in-one or albatross)'),
    ('top10', 0, 'UNCONFIRMED - pending real FanTeam scoring table'),
    ('top25', 0, 'UNCONFIRMED - pending real FanTeam scoring table')
) as v(stat, points, notes)
where fg.slug = 'fanteam-golf'
on conflict (game_id, applies_to, stat) do update set points = excluded.points, notes = excluded.notes;

-- 8. A golf squad is "my lineup for tournament X" - see docstring above.
-- Nullable: irrelevant for every other game.
alter table squads add column golf_tournament_id bigint references golf_tournaments(id) on delete cascade;
create index on squads (golf_tournament_id);
