"""
capture_gameweek_predictions.py
---------------------------------
Originally "Hail Mary Form System, Part 1" - that frontend badge/display
was deleted in the 2026-08-27 site-wide rating consolidation, but this
script itself stays: it's the step that INSERTs each gameweek's player_
gameweek_predictions row in the first place (migration 0044), which two
other still-live scripts only ever UPDATE, never insert - attach_
gameweek_results.py (actual_minutes/actual_goals/actual_assists - Recent
Form's own real data source, see compute_projections.py's fetch_recent_
gameweek_observations) and import_dreamteamtonic_starts.py (actual_
started - the Opportunity Model's real starts signal). Removing this
step would silently break both of those, not just the retired display.
Freezes each player's expected-side prediction the moment (and every
time, right up until) that gameweek's deadline passes, so it survives
every later compute_projections.py recompute untouched. See migration
0044's docstring for the full locked_at mechanism this script
implements - short version: an unlocked row keeps refreshing with the
latest model output on every run; the first run after the deadline passes
both writes the final refresh AND sets locked_at, after which every later
run's UPDATE for that row silently no-ops.

Scans every (game_id, gameweek) with a published calendar
(game_fixture_gameweeks), not just FanTeam - same game-agnostic shape as
capture_gameweek_actuals.py, so this only needs to run once per pipeline
invocation, not once per game slug.

expected_floor/expected_ceiling are a v1 heuristic - there's no historical
prediction-error data yet to calibrate a real interval against (that's
what this whole table exists to start collecting). confidence is a
penalty-subtraction score in the same house style as
frontend/src/lib/recommendationScoring.ts's MoveScore confidence - start
at 100, subtract for genuinely missing/thin signal, never for an
unfavourable-but-known value.

RUN:
    python3 scripts/capture_gameweek_predictions.py
"""

import datetime
import json
import os
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent

# Same constant as compute_projections.py's DEFAULT_WEIGHTS["shrinkage_games"] -
# the confidence formula's "how many 90s of real signal does this player
# actually have" reference point, not re-derived independently.
SHRINKAGE_GAMES = 10

# Floor = "what if this player only got appearance/clean-sheet points,
# zero attacking returns" - built from the model's own already-priced
# inputs.fixtures[0].stats, not an arbitrary fraction of expected_points.
CLEAN_SHEET_POSITIONS = {"GK", "DEF"}

# Ceiling = expected_points x a bounded, position-aware multiplier -
# attacking positions have fatter score tails (one big game blows past
# the mean) than defensive ones (capped by clean-sheet + saves, a
# tighter distribution). NFL positions fall through to the default - not
# hand-tuned this pass, no real error data for that game either.
CEILING_MULTIPLIER = {"GK": 1.6, "DEF": 1.8, "MID": 2.2, "FWD": 2.5}
DEFAULT_CEILING_MULTIPLIER = 2.0


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


def fixture_stat(inputs, stat, key="projected"):
    """inputs['fixtures'][0]['stats'][stat][key], or None if any level is
    missing - covers v1 rows (no 'stats' key at all) and any stat with no
    scoring rule for this game (price_projected_stats skips those)."""
    fixtures = inputs.get("fixtures") or []
    if not fixtures:
        return None
    stats = fixtures[0].get("stats") or {}
    entry = stats.get(stat)
    return entry.get(key) if entry else None


def fixture_field(inputs, field):
    """inputs['fixtures'][0][field] (a sibling of 'stats', e.g.
    'predicted_minutes'), or None if there's no fixture."""
    fixtures = inputs.get("fixtures") or []
    if not fixtures:
        return None
    return fixtures[0].get(field)


def compute_floor(position, expected_points, inputs):
    appearance_prob = fixture_stat(inputs, "appearance") or 0.0
    appearance_points_each = fixture_stat(inputs, "appearance", "points_each") or 0.0
    baseline = appearance_prob * appearance_points_each
    if position in CLEAN_SHEET_POSITIONS:
        cs_prob = fixture_stat(inputs, "clean_sheet_60min") or 0.0
        cs_points_each = fixture_stat(inputs, "clean_sheet_60min", "points_each") or 0.0
        baseline += cs_prob * cs_points_each
    return round(max(0.0, min(expected_points, baseline)), 2)


def compute_ceiling(position, expected_points):
    multiplier = CEILING_MULTIPLIER.get(position, DEFAULT_CEILING_MULTIPLIER)
    return round(expected_points * multiplier, 2)


def compute_confidence(inputs):
    confidence = 100.0

    games90 = inputs.get("games90")
    if games90 is None or games90 < SHRINKAGE_GAMES:
        shortfall = SHRINKAGE_GAMES - (games90 or 0.0)
        confidence -= min(30.0, shortfall * 3.0)  # up to -30 for an unseen/near-zero-minutes player

    status = inputs.get("status") or {}
    if status.get("lineup") is None and status.get("status") is None:
        confidence -= 15.0  # no live lineup/status captured for this gameweek yet

    multiplier = status.get("multiplier", 1.0)
    if multiplier < 1.0:
        confidence -= min(25.0, (1.0 - multiplier) * 40.0)  # heavier status discount = more uncertainty

    return round(max(10.0, min(100.0, confidence)), 1)


def fetch_deadlines(cur):
    cur.execute(
        """
        select gfg.game_id, gfg.gameweek, min(f.kickoff_at) as deadline
        from game_fixture_gameweeks gfg
        join fixtures f on f.id = gfg.fixture_id
        group by gfg.game_id, gfg.gameweek
        """
    )
    return cur.fetchall()


def fetch_latest_projections(cur, game_id, gameweek):
    """Latest projections row per game_player_id for this game+gameweek -
    same "latest projection wins" lateral-join pattern game_player_pool
    already uses (migration 0012), so a stale row from a superseded
    algorithm_version never wins over a fresher one."""
    cur.execute(
        """
        select gp.id as game_player_id, pl.position, latest.algorithm_version_id,
               av.version_label, latest.hail_mary_score, latest.inputs
        from game_players gp
        join players pl on pl.id = gp.player_id
        join lateral (
            select algorithm_version_id, hail_mary_score, inputs
            from projections pr
            where pr.game_player_id = gp.id and pr.gameweek = %s
            order by pr.created_at desc
            limit 1
        ) latest on true
        join algorithm_versions av on av.id = latest.algorithm_version_id
        where gp.game_id = %s
        """,
        (gameweek, game_id),
    )
    return cur.fetchall()


UPSERT_TEMPLATE = """(
    %(game_id)s, %(game_player_id)s, %(gameweek)s, %(algo_id)s, %(version_label)s,
    %(expected_points)s, %(points_per_90)s, %(floor)s, %(ceiling)s,
    %(predicted_minutes)s, %(appearance)s, %(start)s, %(goal)s,
    %(assist)s, %(clean_sheet)s, %(confidence)s, now(), %(locked_at)s
)"""


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        deadlines = fetch_deadlines(cur)
        written, newly_locked = 0, 0
        now = datetime.datetime.now(datetime.timezone.utc)

        # Real bottleneck found live 2026-08-29 investigating why every
        # single Refresh - wrap-up run (chronically, not a one-off) hit
        # its own 2-hour CI ceiling: this used to run one INSERT round
        # trip PER PLAYER PER GAMEWEEK against a remote DB - with ~2,000
        # active EFL Fantasy game_players alone across up to 6 published
        # gameweeks, that's tens of thousands of individual round trips,
        # easily accounting for the whole multi-hour stall on its own.
        # Same class of bug already found and fixed elsewhere this session
        # (import_sportmonks_player_props.py's own _fetch_existing_flags
        # docstring - "a real run wrote 123,464 hub rows... together good
        # for a quarter-million+ round trips"). Collects every row across
        # every (game_id, gameweek) first, then writes them all in one
        # batched execute_values call.
        rows_to_insert = []
        for game_id, gameweek, deadline in deadlines:
            is_past_deadline = now >= deadline
            rows = fetch_latest_projections(cur, game_id, gameweek)

            for game_player_id, position, algo_id, version_label, expected_points, inputs in rows:
                # Same defensive unwrap compute_projections.py's own
                # get_or_create_algorithm_version() uses for a jsonb
                # column read back through psycopg2 - not always
                # auto-deserialized to a dict.
                if isinstance(inputs, str):
                    inputs = json.loads(inputs)
                expected_points = float(expected_points)
                floor = compute_floor(position, expected_points, inputs)
                ceiling = compute_ceiling(position, expected_points)
                confidence = compute_confidence(inputs)

                rows_to_insert.append({
                    "game_id": game_id,
                    "game_player_id": game_player_id,
                    "gameweek": gameweek,
                    "algo_id": algo_id,
                    "version_label": version_label,
                    "expected_points": expected_points,
                    "points_per_90": inputs.get("points_per_90"),
                    "floor": floor,
                    "ceiling": ceiling,
                    "predicted_minutes": fixture_field(inputs, "predicted_minutes"),
                    "appearance": fixture_stat(inputs, "appearance"),
                    "start": fixture_stat(inputs, "minutes_60_plus"),
                    "goal": fixture_stat(inputs, "goal"),
                    "assist": fixture_stat(inputs, "assist"),
                    "clean_sheet": fixture_stat(inputs, "clean_sheet_60min"),
                    "confidence": confidence,
                    "locked_at": now if is_past_deadline else None,
                })
            if is_past_deadline:
                newly_locked += len(rows)

        if rows_to_insert:
            psycopg2.extras.execute_values(
                cur,
                """
                insert into player_gameweek_predictions (
                    game_id, game_player_id, gameweek, algorithm_version_id, model_version_label,
                    expected_points, expected_points_per_90, expected_floor, expected_ceiling,
                    predicted_minutes, appearance_probability, start_probability, goal_probability,
                    assist_probability, clean_sheet_probability, confidence, predicted_at, locked_at
                ) values %s
                on conflict (game_player_id, gameweek) do update set
                    algorithm_version_id = excluded.algorithm_version_id,
                    model_version_label = excluded.model_version_label,
                    expected_points = excluded.expected_points,
                    expected_points_per_90 = excluded.expected_points_per_90,
                    expected_floor = excluded.expected_floor,
                    expected_ceiling = excluded.expected_ceiling,
                    predicted_minutes = excluded.predicted_minutes,
                    appearance_probability = excluded.appearance_probability,
                    start_probability = excluded.start_probability,
                    goal_probability = excluded.goal_probability,
                    assist_probability = excluded.assist_probability,
                    clean_sheet_probability = excluded.clean_sheet_probability,
                    confidence = excluded.confidence,
                    predicted_at = excluded.predicted_at,
                    locked_at = excluded.locked_at
                where player_gameweek_predictions.locked_at is null
                """,
                rows_to_insert,
                template=UPSERT_TEMPLATE,
                page_size=1000,
            )
            written = len(rows_to_insert)

        conn.commit()
        print(f"Captured/refreshed {written} prediction row(s) across {len(deadlines)} gameweek(s), {newly_locked} at/past their deadline.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
