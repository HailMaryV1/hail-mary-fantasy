-- projections.gameweek was designed assuming a real gameweek calendar
-- would exist by the time anything got written here. Neither Dream Team
-- nor FanTeam has published their 2026/27 fixture calendar yet (both
-- still off-season), so there's no real gameweek number to assign right
-- now. Table is empty (confirmed before writing this), so this is a
-- free redesign, not a migration around real data.
--
-- gameweek becomes nullable; period_start/period_end (plain dates) let
-- us log projections for a date window now. Once real gameweek
-- calendars exist, new projections can use gameweek instead - both are
-- supported, each enforced unique by its own partial index.

alter table projections
  alter column gameweek drop not null,
  add column period_start timestamptz,
  add column period_end timestamptz;

alter table projections
  drop constraint projections_algorithm_version_id_game_player_id_gameweek_key;

create unique index projections_by_gameweek_key
  on projections (algorithm_version_id, game_player_id, gameweek)
  where gameweek is not null;

create unique index projections_by_period_key
  on projections (algorithm_version_id, game_player_id, period_start, period_end)
  where gameweek is null;

alter table projections
  add constraint projections_period_or_gameweek check (
    (gameweek is not null) or (period_start is not null and period_end is not null)
  );
