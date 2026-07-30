-- Configurable (not hardcoded) weights for the modular projection engine
-- (see compute_projections.py) - how much each independent signal source
-- contributes to a player's projected rate for goal/assist/clean-sheet,
-- per game and position. A GK's clean sheet chance should lean heavily
-- on the bookmaker/fixture signal; a striker's goal rate should lean
-- more on their own historical scoring record - these numbers are the
-- knob for that, editable directly in this table without touching code.
--
-- Only 3 modules are real today: historical_performance (this player's
-- own shrunk historical rate x fixture factor - the system that already
-- existed before this migration), fixture_model (the POSITION-average
-- historical rate x the same fixture factor - "what would a
-- league-average player in this slot do in this exact matchup"), and
-- bookmaker_intelligence (real SportMonks market data - clean_sheet_score
-- directly for clean sheets, a real/estimated anytime-goalscorer
-- probability for goals once that market populates - see
-- scripts/import_sportmonks_player_props.py). player_role and
-- recent_form are seeded at weight 0 deliberately - their estimators
-- aren't built yet (recent_form has no real 2026/27 data to draw from
-- pre-season; player_role needs its own careful design pass) - a
-- configured weight for a module that always returns "no signal" would
-- be misleading, not a real allocation. Weights within a (game, position)
-- pair are meant to sum to 1.0; compute_projections.py renormalizes
-- defensively among whichever modules actually have data for a given
-- player/stat, so this isn't strictly enforced by the schema.
create table projection_module_weights (
  id bigint generated always as identity primary key,
  game_id bigint not null references fantasy_games(id) on delete cascade,
  position text not null check (position in ('GK', 'DEF', 'MID', 'FWD')),
  module text not null check (
    module in ('historical_performance', 'fixture_model', 'bookmaker_intelligence', 'player_role', 'recent_form')
  ),
  weight numeric(5, 4) not null default 0 check (weight >= 0 and weight <= 1),
  updated_at timestamptz not null default now(),
  unique (game_id, position, module)
);

alter table projection_module_weights enable row level security;
create policy "public read" on projection_module_weights for select using (true);

insert into projection_module_weights (game_id, position, module, weight)
select fg.id, v.position, v.module, v.weight
from fantasy_games fg
cross join (
  values
    ('GK', 'historical_performance', 0.35), ('GK', 'fixture_model', 0.25), ('GK', 'bookmaker_intelligence', 0.40),
    ('GK', 'player_role', 0.0), ('GK', 'recent_form', 0.0),
    ('DEF', 'historical_performance', 0.35), ('DEF', 'fixture_model', 0.25), ('DEF', 'bookmaker_intelligence', 0.40),
    ('DEF', 'player_role', 0.0), ('DEF', 'recent_form', 0.0),
    ('MID', 'historical_performance', 0.45), ('MID', 'fixture_model', 0.20), ('MID', 'bookmaker_intelligence', 0.35),
    ('MID', 'player_role', 0.0), ('MID', 'recent_form', 0.0),
    ('FWD', 'historical_performance', 0.40), ('FWD', 'fixture_model', 0.15), ('FWD', 'bookmaker_intelligence', 0.45),
    ('FWD', 'player_role', 0.0), ('FWD', 'recent_form', 0.0)
) as v(position, module, weight)
where fg.slug in ('fanteam', 'dreamteam')
on conflict (game_id, position, module) do nothing;
