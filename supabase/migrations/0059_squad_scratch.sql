-- Phase B of the FanTeam strategy audit: lets a user build/duplicate a
-- squad purely to test an alternative route through Ask Mary, without it
-- becoming a permanent "real" team mixed into /squads or Performance Lab.
-- Deliberately still a normal `squads` row (not a separate schema/table) -
-- Ask Mary, the lineup page, budget/transfer rules, and every other piece
-- of existing squad infrastructure already works on any squad_id, so a
-- scratch squad gets all of that for free. Only the UI grouping and
-- Performance Lab archiving change based on this one flag.
alter table squads add column is_scratch boolean not null default false;

-- Nullable, set only when a scratch squad was created via "Duplicate to
-- test" from a real squad (not from a from-scratch build) - lets the UI
-- show "Testing an alternative to <name>" instead of just a bare name.
alter table squads add column scratch_source_squad_id bigint references squads(id) on delete set null;

create index on squads (user_id, is_scratch);
