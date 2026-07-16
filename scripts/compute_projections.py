"""
compute_projections.py
------------------------
First real Hail Mary Score: combines each player's historical output
rate with their team's upcoming fixture(s) opportunity, position-aware.

    expected_points_per_fixture = points_per_90 * fixture_factor
    hail_mary_score = sum over every fixture in the period

fixture_factor centers on 1.0 (an "average difficulty" fixture leaves
points_per_90 unchanged); above 1.0 is a favourable fixture, below 1.0
is tough. It blends attack_score and clean_sheet_score from
team_fixture_difficulty using per-position weights stored in
algorithm_versions.weights - so tuning a position's weighting later is
a data change, not a code change.

KNOWN v1 LIMITATIONS (by design - this is meant to be simple first,
tuned all season, not final):
  - Uses each player's LAST SEASON's team (players.team_id, from the
    2025/26 CSV import) to look up fixtures. Anyone who's transferred
    over the summer will be projected against their OLD team's
    fixtures until we have a real 2026/27 squad list. No transfer/squad
    data source exists yet - this is a real gap, not an oversight.
  - points_per_90 uses one season of history - no weighting for recent
    form, no regression for small minutes samples.
  - Assumes a player starts and plays close to 90 minutes - no expected
    minutes/rotation/injury modelling yet.
  - clean_sheet_score is the win% + half-draw% approximation, not the
    real team-goals market (see migration 0004 - empty until closer to
    matchday).
Each of these is a natural place to improve v2 - tracked here rather
than silently assumed.

RUN:
    python3 scripts/compute_projections.py dreamteam 2026-08-01 2026-08-31
"""

import json
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
HISTORICAL_SEASON = "2025/26"
UPCOMING_SEASON = "2026/27"

DEFAULT_WEIGHTS = {
    "position_weights": {
        "GK": {"attack": 0.0, "clean_sheet": 1.0},
        "DEF": {"attack": 0.3, "clean_sheet": 0.7},
        "MID": {"attack": 0.7, "clean_sheet": 0.3},
        "FWD": {"attack": 1.0, "clean_sheet": 0.0},
    },
    "neutral_attack": 1 / 3,
    "neutral_clean_sheet": 0.5,
    # Shrinkage: blend each player's own points-per-90 toward their
    # position's average, weighted as if we'd additionally observed
    # this many 90-minute games at the average rate. Without this, a
    # player with 20 minutes and one big return gets a wildly inflated
    # rate that isn't predictive of anything - discovered by inspecting
    # v1's first real output (a 2.00-price fringe player topped the
    # list ahead of Haaland) rather than assumed in advance.
    "shrinkage_games": 10,
}


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def get_or_create_algorithm_version(cur, label, description, weights):
    # Upsert, not get-or-create: while iterating pre-season (no real
    # outcomes compared against yet), a weights change is a bug fix, not
    # a new tunable version. Once projections start getting compared
    # against actual results, stop calling this with changed weights
    # under the same label - bump the label instead so history stays honest.
    cur.execute(
        """
        insert into algorithm_versions (version_label, description, weights)
        values (%s, %s, %s)
        on conflict (version_label) do update
            set description = excluded.description, weights = excluded.weights
        returning id, weights
        """,
        (label, description, psycopg2.extras.Json(weights)),
    )
    return cur.fetchone()


def fixture_factor(position, attack_score, clean_sheet_score, weights):
    pw = weights["position_weights"][position]
    neutral_attack = weights["neutral_attack"]
    neutral_clean_sheet = weights["neutral_clean_sheet"]
    return (
        pw["attack"] * (float(attack_score) / neutral_attack)
        + pw["clean_sheet"] * (float(clean_sheet_score) / neutral_clean_sheet)
    )


def main():
    if len(sys.argv) != 4:
        print("Usage: python3 compute_projections.py <game_slug> <period_start> <period_end>")
        sys.exit(1)
    game_slug, period_start, period_end = sys.argv[1], sys.argv[2], sys.argv[3]

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        algo_id, weights = get_or_create_algorithm_version(
            cur, "v1", "points_per_90 x position-weighted fixture factor", DEFAULT_WEIGHTS
        )
        if isinstance(weights, str):
            weights = json.loads(weights)

        cur.execute("select id from fantasy_games where slug = %s", (game_slug,))
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"Unknown game slug: {game_slug}")
        game_id = row[0]

        # points_per_90 per game_player, from last season's totals.
        cur.execute(
            """
            select gp.id, p.position, gp.player_id,
                   gps.total_points, gps.minutes_played
            from game_players gp
            join players p on p.id = gp.player_id
            join game_player_stats gps
                on gps.game_player_id = gp.id and gps.season = %s and gps.gameweek = 0
            where gp.game_id = %s and gps.minutes_played > 0
            """,
            (HISTORICAL_SEASON, game_id),
        )
        players = cur.fetchall()

        # Position-average points-per-90, weighted by minutes (not a
        # plain average of individual rates - that would have the same
        # small-sample problem this is meant to fix). Used as the
        # shrinkage target below.
        position_totals = {}
        for _, position, _, total_points, minutes_played in players:
            agg = position_totals.setdefault(position, [0.0, 0.0])
            agg[0] += float(total_points)
            agg[1] += float(minutes_played) / 90.0
        position_avg_pp90 = {pos: pts / games for pos, (pts, games) in position_totals.items()}

        # This player's team's fixtures in the period (team_id via players.team_id -
        # last season's team, see docstring caveat about summer transfers).
        cur.execute(
            """
            select p.id as player_id, tfd.fixture_id, tfd.kickoff_at,
                   tfd.attack_score, tfd.clean_sheet_score
            from players p
            join team_fixture_difficulty tfd
                on tfd.team_id = p.team_id and tfd.game_id = %s
            where tfd.kickoff_at >= %s and tfd.kickoff_at < %s
            """,
            (game_id, period_start, period_end),
        )
        fixtures_by_player = {}
        for player_id, fixture_id, kickoff_at, attack_score, clean_sheet_score in cur.fetchall():
            fixtures_by_player.setdefault(player_id, []).append(
                {"fixture_id": fixture_id, "kickoff_at": kickoff_at.isoformat(),
                 "attack_score": float(attack_score), "clean_sheet_score": float(clean_sheet_score)}
            )

        written = 0
        for game_player_id, position, player_id, total_points, minutes_played in players:
            player_fixtures = fixtures_by_player.get(player_id, [])
            if not player_fixtures:
                continue

            games_played = float(minutes_played) / 90.0
            k = weights["shrinkage_games"]
            points_per_90 = (float(total_points) + k * position_avg_pp90[position]) / (games_played + k)
            score = 0.0
            fixture_breakdown = []
            for fx in player_fixtures:
                factor = fixture_factor(position, fx["attack_score"], fx["clean_sheet_score"], weights)
                contribution = points_per_90 * factor
                score += contribution
                fixture_breakdown.append({**fx, "fixture_factor": factor, "contribution": contribution})

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
                (
                    algo_id, game_player_id, UPCOMING_SEASON, period_start, period_end,
                    round(score, 3),
                    psycopg2.extras.Json({
                        "points_per_90": round(points_per_90, 3),
                        "fixtures": fixture_breakdown,
                    }),
                ),
            )
            written += 1

        conn.commit()
        print(f"Wrote {written} projections for {game_slug}, {period_start} to {period_end}.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
