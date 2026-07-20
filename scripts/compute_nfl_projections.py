"""
compute_nfl_projections.py
----------------------------
NFL FanTeam v1 Hail Mary Score: a player's 2025 season total_points
(computed by import_nfl_historical_stats.py from real box-score stats
run through game_scoring_rules) divided by their games_played - i.e.
"what they scored per game last season," with no fixture adjustment.

That's a real limitation compared to compute_projections.py's v2-decomposed
soccer scoring, which fixture-adjusts each stat by the upcoming opponent's
attack/clean-sheet strength - deliberately not attempted here because
there's no 2026 NFL fixture list or odds data yet (no live NFL FanTeam
tournament exists to build a gameweek calendar from; see
import_nfl_historical_stats.py's module docstring for the same caveat).
A flat per-game average is the honest baseline until that data exists -
tracked as real algorithm work for a v2, not attempted blind here.

Reuses get_or_create_algorithm_version from compute_projections.py
unchanged (fully game-agnostic). Its upsert_projection isn't reused -
that function hardcodes compute_projections.py's own UPCOMING_SEASON
module constant ("2026/27", a soccer season label) rather than taking a
season as a parameter, which would silently mislabel every NFL row - so
this script writes its own insert instead.

Writes period-mode projections (gameweek is null, period_start/period_end
both set to today) since there's no gameweek calendar for this game yet -
game_player_pool only ever reads the latest projection per player
regardless of the period values, so this is enough for the squad builder
and rankings page to show a real score.

RUN:
    python3 scripts/compute_nfl_projections.py
"""

import datetime
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))
from compute_projections import get_or_create_algorithm_version  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SEASON = "2026"  # the season these projections are FOR, not the 2025 data they're derived from


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def upsert_projection(cur, algo_id, game_player_id, period_start, period_end, score, inputs):
    cur.execute(
        """
        insert into projections
            (algorithm_version_id, game_player_id, season, period_start, period_end,
             hail_mary_score, inputs)
        values (%s, %s, %s, %s, %s, %s, %s)
        on conflict (algorithm_version_id, game_player_id, period_start, period_end)
            where gameweek is null
            do update set hail_mary_score = excluded.hail_mary_score, inputs = excluded.inputs
        """,
        (algo_id, game_player_id, SEASON, period_start, period_end, round(score, 3),
         psycopg2.extras.Json(inputs)),
    )


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            cur.execute("select id from fantasy_games where slug = 'nfl-fanteam'")
            game_id = cur.fetchone()[0]

            weights = {"basis": "2025 season total_points / games_played"}
            algo_id, _ = get_or_create_algorithm_version(
                cur, "nfl-v1",
                "NFL FanTeam v1: 2025 season per-game average, no fixture adjustment (no 2026 schedule/odds yet)",
                weights,
            )

            cur.execute(
                """
                select gp.id, s.total_points, s.games_played
                from game_players gp
                join nfl_game_player_stats s on s.game_player_id = gp.id and s.season = '2025' and s.gameweek is null
                where gp.game_id = %s and gp.is_active
                """,
                (game_id,),
            )
            rows = cur.fetchall()

            today = datetime.date.today().isoformat()
            written = 0
            for game_player_id, total_points, games_played in rows:
                games = games_played or 1
                score = float(total_points or 0) / max(games, 1)
                upsert_projection(
                    cur, algo_id, game_player_id, today, today, score,
                    {"season_total_points": float(total_points or 0), "games_played": games},
                )
                written += 1

        conn.commit()
        print(f"Wrote {written} NFL FanTeam projections (algorithm nfl-v1).")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == "__main__":
    main()
