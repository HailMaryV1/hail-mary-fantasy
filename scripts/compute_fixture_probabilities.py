"""
compute_fixture_probabilities.py
----------------------------------
First real piece of the Hail Mary algorithm: turns raw bookmaker prices
into a normalized implied probability per fixture.

Decimal odds imply a probability of 1/price per outcome, but the three
outcomes (home/draw/away) always sum to more than 100% - that excess is
the bookmaker's margin (overround). Dividing each raw probability by the
sum of all three removes the margin, leaving the bookmaker's genuine
assessment of each outcome's likelihood.

Uses the latest odds snapshot per bookmaker per fixture (fixture_odds is
append-only, so "latest per bookmaker" = most recent fetched_at), then
takes the median normalized probability across bookmakers - more robust
to one outlier bookmaker than a plain average.

RUN:
    python3 scripts/compute_fixture_probabilities.py
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


def normalize(home_price, draw_price, away_price):
    raw_home, raw_draw, raw_away = 1 / float(home_price), 1 / float(draw_price), 1 / float(away_price)
    overround = raw_home + raw_draw + raw_away
    return raw_home / overround, raw_draw / overround, raw_away / overround


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select id from fixtures order by kickoff_at")
        fixture_ids = [r[0] for r in cur.fetchall()]

        computed = 0
        for fixture_id in fixture_ids:
            # Latest snapshot per bookmaker for this fixture.
            cur.execute(
                """
                select distinct on (bookmaker) bookmaker, home_price, draw_price, away_price
                from fixture_odds
                where fixture_id = %s
                order by bookmaker, fetched_at desc
                """,
                (fixture_id,),
            )
            rows = cur.fetchall()
            if not rows:
                continue

            home_probs, draw_probs, away_probs = [], [], []
            for _, home_price, draw_price, away_price in rows:
                h, d, a = normalize(home_price, draw_price, away_price)
                home_probs.append(h)
                draw_probs.append(d)
                away_probs.append(a)

            cur.execute(
                """
                insert into fixture_probabilities
                    (fixture_id, home_win_prob, draw_prob, away_win_prob, bookmaker_count)
                values (%s, %s, %s, %s, %s)
                """,
                (
                    fixture_id,
                    statistics.median(home_probs),
                    statistics.median(draw_probs),
                    statistics.median(away_probs),
                    len(rows),
                ),
            )
            computed += 1

        conn.commit()
        print(f"Computed probabilities for {computed} fixtures.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
