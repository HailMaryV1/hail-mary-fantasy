"""
compute_clean_sheet_probabilities.py
--------------------------------------
Real clean-sheet probability from the actual goals market, not
approximated from win/draw/loss odds. A "Team X total goals Under 0.5"
price is exactly the clean-sheet market for X's OPPONENT - if X doesn't
score, the other side didn't concede. So this reads fixture_team_totals
where line = 0.5 and attributes the result to the *other* team.

Only exact 0.5 lines are used. A 1.5 line answers "did they score 0 or
1" - a different question - and blending that in would just be a second
approximation, defeating the point of wiring in the real market.

Where no 0.5-line market exists yet for a fixture, team_fixture_difficulty
(migration 0010) automatically falls back to the win/draw approximation -
this script doesn't need to handle that case, it only ever writes rows
where real data exists.

RUN:
    python3 scripts/compute_clean_sheet_probabilities.py
"""

import os
import statistics
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return  # CI sets real env vars directly - no .env file there.
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def normalize_under(over_price, under_price):
    raw_over, raw_under = 1 / float(over_price), 1 / float(under_price)
    overround = raw_over + raw_under
    return raw_under / overround


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute(
            """
            select ftt.fixture_id, ftt.team_id, f.home_team_id, f.away_team_id,
                   ftt.bookmaker, ftt.over_price, ftt.under_price
            from fixture_team_totals ftt
            join fixtures f on f.id = ftt.fixture_id
            where ftt.line = 0.5
            """
        )
        rows = cur.fetchall()

        groups: dict[tuple[int, int], list[float]] = {}
        for fixture_id, scoring_team_id, home_id, away_id, _bookmaker, over_price, under_price in rows:
            clean_sheet_team_id = away_id if scoring_team_id == home_id else home_id
            key = (fixture_id, clean_sheet_team_id)
            groups.setdefault(key, []).append(normalize_under(over_price, under_price))

        written = 0
        for (fixture_id, team_id), probs in groups.items():
            cur.execute(
                """
                insert into fixture_clean_sheet_probabilities
                    (fixture_id, team_id, clean_sheet_prob, bookmaker_count)
                values (%s, %s, %s, %s)
                """,
                (fixture_id, team_id, statistics.median(probs), len(probs)),
            )
            written += 1

        conn.commit()
        print(f"Computed clean sheet probabilities for {written} (fixture, team) pairs from {len(rows)} bookmaker quotes.")
        if written == 0:
            print("(No 0.5-line team-total markets found yet - expected until fixtures are close to matchday.)")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
