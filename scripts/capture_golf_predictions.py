"""
capture_golf_predictions.py
------------------------------
Hail Mary Golf, Phase 4 - freezes each golfer's expected-side prediction
into golf_tournament_predictions (migration 0049) the moment (and every
time, right up until) that tournament's registration_time passes, so it
survives every later compute_golf_projections.py recompute untouched. See
that migration's docstring for the full locked_at mechanism - short
version: an unlocked row keeps refreshing with the latest model output on
every run; the first run after the deadline passes both writes the final
refresh AND sets locked_at, after which every later run's UPDATE for that
row silently no-ops.

Scans every golf_tournaments row, not just one - safe to run unattended
(see refresh_all.py wiring) since it needs no tournament ID argument,
unlike the scraper/importer/projections scripts which operate on
whichever tournament you point them at.

RUN:
    python3 scripts/capture_golf_predictions.py
"""

import datetime
import json
import os
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def fetch_tournaments(cur):
    cur.execute("select id, registration_time from golf_tournaments where registration_time is not null")
    return cur.fetchall()


def fetch_latest_projections(cur, tournament_id):
    """Latest golf-v1 projections row per game_player_id for this
    tournament's entries - same "latest projection wins" principle
    capture_gameweek_predictions.py already uses for football."""
    cur.execute(
        """
        select gte.game_player_id, gte.price, latest.algorithm_version_id, av.version_label,
               latest.hail_mary_score, latest.inputs
        from golf_tournament_entries gte
        join lateral (
            select algorithm_version_id, hail_mary_score, inputs
            from projections pr
            where pr.game_player_id = gte.game_player_id
            order by pr.created_at desc
            limit 1
        ) latest on true
        join algorithm_versions av on av.id = latest.algorithm_version_id
        where gte.tournament_id = %s and av.family = 'golf-v1'
        """,
        (tournament_id,),
    )
    return cur.fetchall()


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        tournaments = fetch_tournaments(cur)
        written, newly_locked = 0, 0
        now = datetime.datetime.now(datetime.timezone.utc)

        for tournament_id, registration_time in tournaments:
            is_past_deadline = now >= registration_time
            rows = fetch_latest_projections(cur, tournament_id)

            for game_player_id, price, algo_id, version_label, expected_points, inputs in rows:
                # Same defensive unwrap compute_projections.py's own
                # get_or_create_algorithm_version() uses for a jsonb
                # column read back through psycopg2.
                if isinstance(inputs, str):
                    inputs = json.loads(inputs)
                expected_points = float(expected_points)

                cur.execute(
                    """
                    insert into golf_tournament_predictions (
                        tournament_id, game_player_id, algorithm_version_id, model_version_label,
                        expected_points, expected_floor, expected_ceiling, value,
                        make_cut_probability, top_finish_probability, boom_probability, bust_probability,
                        price, predicted_at, locked_at
                    ) values (
                        %(tournament_id)s, %(game_player_id)s, %(algo_id)s, %(version_label)s,
                        %(expected_points)s, %(floor)s, %(ceiling)s, %(value)s,
                        %(make_cut_probability)s, %(top_finish_probability)s, %(boom_probability)s, %(bust_probability)s,
                        %(price)s, now(), %(locked_at)s
                    )
                    on conflict (tournament_id, game_player_id) do update set
                        algorithm_version_id = excluded.algorithm_version_id,
                        model_version_label = excluded.model_version_label,
                        expected_points = excluded.expected_points,
                        expected_floor = excluded.expected_floor,
                        expected_ceiling = excluded.expected_ceiling,
                        value = excluded.value,
                        make_cut_probability = excluded.make_cut_probability,
                        top_finish_probability = excluded.top_finish_probability,
                        boom_probability = excluded.boom_probability,
                        bust_probability = excluded.bust_probability,
                        price = excluded.price,
                        predicted_at = excluded.predicted_at,
                        locked_at = excluded.locked_at
                    where golf_tournament_predictions.locked_at is null
                    """,
                    {
                        "tournament_id": tournament_id,
                        "game_player_id": game_player_id,
                        "algo_id": algo_id,
                        "version_label": version_label,
                        "expected_points": expected_points,
                        "floor": inputs.get("floor"),
                        "ceiling": inputs.get("ceiling"),
                        "value": inputs.get("value"),
                        "make_cut_probability": inputs.get("make_cut_probability"),
                        "top_finish_probability": inputs.get("top_finish_probability"),
                        "boom_probability": inputs.get("boom_probability"),
                        "bust_probability": inputs.get("bust_probability"),
                        "price": float(price) if price is not None else None,
                        "locked_at": now if is_past_deadline else None,
                    },
                )
                written += 1
            if is_past_deadline:
                newly_locked += len(rows)

        conn.commit()
        print(f"Captured/refreshed {written} golf prediction row(s) across {len(tournaments)} tournament(s), {newly_locked} at/past their deadline.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
