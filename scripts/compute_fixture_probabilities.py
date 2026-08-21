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
from collections import defaultdict
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

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
        # Real bottleneck found live 2026-08-21 investigating the "shared
        # odds" refresh timing out past its 2hr CI limit: this used to
        # issue one SELECT + one INSERT round trip PER fixture (up to
        # ~4900 sequential round trips against a remote DB, and growing
        # every day as the season adds fixtures) and never scoped to
        # upcoming fixtures at all - already-played fixtures never get
        # new fixture_odds rows, so recomputing them every run was pure
        # waste. One bulk query (still DISTINCT ON per fixture+bookmaker,
        # just across every upcoming fixture at once) plus one batched
        # insert replaces that entirely. This table is deliberately
        # append-only (see migration 0003's docstring - tracks how the
        # assessment moved over the week) - that's unchanged, only the
        # I/O pattern getting there is.
        cur.execute(
            """
            select distinct on (fo.fixture_id, fo.bookmaker)
                fo.fixture_id, fo.bookmaker, fo.home_price, fo.draw_price, fo.away_price
            from fixture_odds fo
            join fixtures f on f.id = fo.fixture_id
            where f.kickoff_at >= now()
            order by fo.fixture_id, fo.bookmaker, fo.fetched_at desc
            """
        )
        by_fixture = defaultdict(list)
        for fixture_id, _bookmaker, home_price, draw_price, away_price in cur.fetchall():
            by_fixture[fixture_id].append((home_price, draw_price, away_price))

        rows_to_insert = []
        for fixture_id, prices in by_fixture.items():
            home_probs, draw_probs, away_probs = [], [], []
            for home_price, draw_price, away_price in prices:
                h, d, a = normalize(home_price, draw_price, away_price)
                home_probs.append(h)
                draw_probs.append(d)
                away_probs.append(a)
            rows_to_insert.append((
                fixture_id,
                statistics.median(home_probs),
                statistics.median(draw_probs),
                statistics.median(away_probs),
                len(prices),
            ))

        if rows_to_insert:
            execute_values(
                cur,
                """
                insert into fixture_probabilities
                    (fixture_id, home_win_prob, draw_prob, away_win_prob, bookmaker_count)
                values %s
                """,
                rows_to_insert,
            )
        computed = len(rows_to_insert)

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
