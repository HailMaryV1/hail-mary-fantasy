"""
compute_fixture_strength_probabilities.py
--------------------------------------------
Turns each pair of teams' season-long strength ratings (from
compute_team_strength.py) into a synthetic home/draw/away probability
for every fixture - the fallback team_fixture_difficulty uses when no
real bookmaker match odds exist yet (see migration 0017).

Method (Bradley-Terry style, a standard way to turn a single strength
scalar per competitor into pairwise win probabilities):

    home_strength = exp(STEEPNESS * (strength_home + HOME_ADVANTAGE))
    away_strength = exp(STEEPNESS * strength_away)
    win_ratio_home = home_strength / (home_strength + away_strength)

win_ratio_home is a binary (no-draw) home-win probability. A fixed
league-average draw rate is then carved out, and the remainder split
proportionally:

    draw_prob = BASE_DRAW_RATE
    home_win_prob = win_ratio_home * (1 - draw_prob)
    away_win_prob = (1 - win_ratio_home) * (1 - draw_prob)

This is deliberately simple - a genuine fallback for when nothing
better exists, not a competitor to real bookmaker pricing. Run again
whenever compute_team_strength.py's input odds get refreshed.

RUN:
    python3 scripts/compute_fixture_strength_probabilities.py
"""

import math
import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
SEASON = "2026/27"

STEEPNESS = 3.0       # higher = strength differences swing win probability more sharply
HOME_ADVANTAGE = 0.10  # added to the home team's strength before comparing
BASE_DRAW_RATE = 0.24  # long-run EPL average draw rate


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def win_ratio(strength_home: float, strength_away: float) -> float:
    home_raw = math.exp(STEEPNESS * (strength_home + HOME_ADVANTAGE))
    away_raw = math.exp(STEEPNESS * strength_away)
    return home_raw / (home_raw + away_raw)


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select team_id, strength from team_season_strength where season = %s", (SEASON,))
        strength_by_team = {team_id: float(strength) for team_id, strength in cur.fetchall()}
        if not strength_by_team:
            raise SystemExit("No team_season_strength rows found - run compute_team_strength.py first.")

        cur.execute("select id, home_team_id, away_team_id from fixtures")
        fixtures = cur.fetchall()

        written, skipped = 0, 0
        for fixture_id, home_team_id, away_team_id in fixtures:
            if home_team_id not in strength_by_team or away_team_id not in strength_by_team:
                skipped += 1  # non-PL opponent (cup fixture vs lower-league side, etc.) - no rating for them
                continue

            ratio = win_ratio(strength_by_team[home_team_id], strength_by_team[away_team_id])
            draw_prob = BASE_DRAW_RATE
            home_win_prob = ratio * (1 - draw_prob)
            away_win_prob = (1 - ratio) * (1 - draw_prob)

            cur.execute(
                """
                insert into fixture_strength_model_probabilities
                    (fixture_id, home_win_prob, draw_prob, away_win_prob)
                values (%s, %s, %s, %s)
                """,
                (fixture_id, round(home_win_prob, 4), round(draw_prob, 4), round(away_win_prob, 4)),
            )
            written += 1

        conn.commit()
        print(f"Computed strength-model probabilities for {written} fixtures ({skipped} skipped - non-PL opponent).")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
