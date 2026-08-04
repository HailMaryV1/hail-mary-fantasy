-- Retiring the scratch-squad feature (is_scratch / scratch_source_squad_id,
-- migration 0059) entirely - full clean retirement, not a soft-disable.
-- "Duplicate to test"/"Build a test squad to analyse" let a user clone or
-- build a squad purely to run through Ask Mary without it counting as a
-- real entry. Real evidence (confirmed live, 2026-08-04):
-- `select count(*) from squads where is_scratch = true` returns 0 - zero
-- of the 16 real squads in the DB have ever used this. All the frontend
-- code reading/writing these columns (squads/actions.ts's
-- duplicateSquadAsScratch, squads/new's ?scratch=1 handling, squads/page.tsx's
-- "+ Test squad" button and "Test Squads" section, and every isScratch
-- exclusion filter in Ask Mary/Performance Lab) has been removed in the
-- same change as this migration - nothing left reads these columns, so
-- there's no reason to keep carrying them.
alter table squads drop column is_scratch;
alter table squads drop column scratch_source_squad_id;
