-- The frontend's Supabase key is a "publishable" key, deliberately public
-- (it ships in browser JS) - Supabase's security model expects Row Level
-- Security to be the actual gate, not key secrecy. RLS was off on every
-- table (Supabase's default for tables created via raw SQL migrations
-- rather than the table editor), which meant that public key currently
-- had full read AND write access to everything - anyone who opened dev
-- tools could delete data, not just read it.
--
-- Fixed with the minimum needed for today: anon can SELECT everything
-- (the frontend is read-only right now, no login/personal squads yet),
-- nothing can INSERT/UPDATE/DELETE via the anon key. Once per-user data
-- (saved squads, auth) gets built, those tables need their own
-- user-scoped policies (auth.uid() = owner_id) - this migration doesn't
-- try to anticipate that, it just closes today's actual write hole.

alter table teams enable row level security;
alter table team_aliases enable row level security;
alter table players enable row level security;
alter table fantasy_games enable row level security;
alter table game_players enable row level security;
alter table game_player_stats enable row level security;
alter table algorithm_versions enable row level security;
alter table projections enable row level security;
alter table fixtures enable row level security;
alter table fixture_odds enable row level security;
alter table fixture_probabilities enable row level security;
alter table fixture_team_totals enable row level security;
alter table fixture_player_props enable row level security;
alter table game_competitions enable row level security;

create policy "public read" on teams for select using (true);
create policy "public read" on team_aliases for select using (true);
create policy "public read" on players for select using (true);
create policy "public read" on fantasy_games for select using (true);
create policy "public read" on game_players for select using (true);
create policy "public read" on game_player_stats for select using (true);
create policy "public read" on algorithm_versions for select using (true);
create policy "public read" on projections for select using (true);
create policy "public read" on fixtures for select using (true);
create policy "public read" on fixture_odds for select using (true);
create policy "public read" on fixture_probabilities for select using (true);
create policy "public read" on fixture_team_totals for select using (true);
create policy "public read" on fixture_player_props for select using (true);
create policy "public read" on game_competitions for select using (true);
