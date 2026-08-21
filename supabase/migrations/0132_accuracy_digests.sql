-- Tracks which (squad, gameweek) accuracy digests have already been sent
-- (scripts/send_accuracy_digest.py), so a squad/gameweek that's already
-- fully graded never re-fires on the next wrap-up cycle just because the
-- script runs again. Same "log real state so a repeat run is a no-op"
-- shape as bookmaker_player_probability_history.alerted (migration 0120).

create table accuracy_digests (
    id bigint generated always as identity primary key,
    squad_id bigint not null references squads(id) on delete cascade,
    gameweek int not null,
    sent_at timestamptz not null default now(),
    unique (squad_id, gameweek)
);
