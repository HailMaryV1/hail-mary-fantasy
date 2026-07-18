-- Missing from migration 0011: an UPDATE policy for squad_players.
-- Without it, RLS silently blocked all updates (no error - the UPDATE
-- just matched zero rows), which is exactly what happened when
-- saveLineup tried to move players onto the bench: the query "succeeded"
-- but changed nothing. Caught by checking the database directly rather
-- than trusting the redirect-on-success signal.

create policy "own squad players update" on squad_players for update
  using (exists (select 1 from squads where squads.id = squad_players.squad_id and squads.user_id = auth.uid()));
