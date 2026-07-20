-- Mary Performance Lab, Part 2 - grading a stored prediction against
-- player_gameweek_results once actuals exist for its gameweek. Written
-- by a new scripts/evaluate_predictions.py, run in the pipeline after
-- scripts/capture_gameweek_actuals.py.
--
-- Deliberately NOT attempting the full error-attribution vocabulary from
-- the feature spec (unexpected injury, red card, penalty missed,
-- tactical change, ...) - this project has no match-event feed, only an
-- aggregate actual-points number per player per gameweek, which cannot
-- distinguish "missed a penalty" from "just had a quiet game". Real
-- attribution needs richer data than exists yet; error_attribution below
-- is intentionally limited to what's genuinely inferable from the data
-- this app actually has (magnitude of the miss, and whether a player
-- expected to feature didn't play at all).
--
-- hold_correct is left uncomputed in this phase - grading a "no transfer
-- needed" call correctly would mean re-deriving the full candidate set
-- as of that past gameweek, which needs point-in-time replay
-- infrastructure this phase doesn't build. A later phase.

create table prediction_evaluations (
  id bigint generated always as identity primary key,
  prediction_id bigint not null references predictions(id) on delete cascade,
  evaluated_at timestamptz not null default now(),

  actual_points_out numeric(6, 2),
  actual_points_in numeric(6, 2),
  actual_gain numeric(6, 2),
  prediction_error numeric(6, 2), -- expected_gain - actual_gain; positive = Mary was too optimistic

  transfer_success boolean,

  captain_actual_points numeric(6, 2),
  vice_captain_actual_points numeric(6, 2),
  captain_success boolean,

  hold_correct boolean,

  error_attribution text[] not null default '{}',
  constraint prediction_evaluations_attribution_valid check (
    error_attribution <@ array[
      'as_expected', 'overperformed_expectation', 'underperformed_expectation',
      'unexpected_unavailability', 'unknown'
    ]::text[]
  ),

  unique (prediction_id)
);

create index on prediction_evaluations (prediction_id);

alter table prediction_evaluations enable row level security;
create policy "own evaluations select" on prediction_evaluations for select using (
  exists (select 1 from predictions p where p.id = prediction_evaluations.prediction_id and p.user_id = auth.uid())
);
-- No insert/update/delete policy for the anon/authenticated key - only
-- the pipeline's service-role connection writes evaluations, same
-- reasoning as activity_log.
