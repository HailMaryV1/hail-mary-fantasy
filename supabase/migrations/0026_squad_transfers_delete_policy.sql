-- squad_transfers (migration 0022) only ever got SELECT and INSERT
-- policies - there was no delete path when it was written. reverseTransfer
-- (squads/actions.ts) needs to delete a transfer's log row when undoing
-- it; without this policy RLS silently blocks the delete (0 rows
-- affected, no error) rather than failing loudly - caught by directly
-- checking the DB after a real undo instead of trusting the UI's
-- redirect, same discipline as the original missing-UPDATE-policy bug
-- earlier in this project.

create policy "own squad transfers delete" on squad_transfers for delete
  using (exists (select 1 from squads where squads.id = squad_transfers.squad_id and squads.user_id = auth.uid()));
