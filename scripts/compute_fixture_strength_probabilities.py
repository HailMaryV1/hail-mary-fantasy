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

strength_home/strength_away come from team_season_strength's home_strength/
away_strength columns when a source rates a team differently by venue
(migration 0102 - EFL Fantasy's own real fdrHome/fdrAway), falling back
to the single `strength` column otherwise (every other game).

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
        # home_strength/away_strength (migration 0102) let a source that
        # genuinely rates a team differently by venue - EFL Fantasy's own
        # real fdrHome/fdrAway, see import_eflfantasy.py's seed_team_strength -
        # express that, instead of forcing one flat `strength` onto both
        # sides of the fixture. Falls back to `strength` per-team whenever
        # its context-specific column is null (every other game, which
        # only ever sets `strength`), so this is zero-drift for them.
        # manual_home_strength_override/manual_away_strength_override
        # (migration 0153, 2026-08-27 user request - "their tool has
        # separate Home and Away strength sliders per team... lets copy
        # something similar") win over BOTH the automated `strength`
        # baseline AND the per-venue home_strength/away_strength columns
        # whenever set, independently per side - a team can genuinely be
        # overridden at home but left on the automated baseline away, or
        # vice versa. Verified live 2026-08-27 that every team (all 92
        # season rows, PL included) already has non-null home_strength/
        # away_strength - EFL Fantasy's own seed_team_strength() writes
        # real ones, but set_manual_pl_fixture_strength.py (the script
        # this override supersedes) wrote a flat pair for every PL team
        # too - so a naive "fall back to strength only when the venue
        # columns are null" check never fires and the override would
        # silently do nothing. Same "only fills the gap real data
        # leaves" rule the rest of this engine follows either way - real
        # bookmaker odds still beat all of this further up team_fixture_
        # difficulty's own COALESCE chain (migration 0017), this script
        # only ever feeds that chain's LAST fallback.
        cur.execute(
            "select team_id, strength, home_strength, away_strength, "
            "manual_home_strength_override, manual_away_strength_override "
            "from team_season_strength where season = %s",
            (SEASON,),
        )
        home_strength_by_team = {}
        away_strength_by_team = {}
        for team_id, strength, home_strength, away_strength, manual_home_override, manual_away_override in cur.fetchall():
            strength = float(strength)
            fallback_home = float(home_strength) if home_strength is not None else strength
            fallback_away = float(away_strength) if away_strength is not None else strength
            home_strength_by_team[team_id] = float(manual_home_override) if manual_home_override is not None else fallback_home
            away_strength_by_team[team_id] = float(manual_away_override) if manual_away_override is not None else fallback_away
        if not home_strength_by_team:
            raise SystemExit("No team_season_strength rows found - run compute_team_strength.py first.")

        cur.execute("select id, home_team_id, away_team_id from fixtures")
        fixtures = cur.fetchall()

        written, skipped = 0, 0
        for fixture_id, home_team_id, away_team_id in fixtures:
            if home_team_id not in home_strength_by_team or away_team_id not in away_strength_by_team:
                skipped += 1  # non-PL opponent (cup fixture vs lower-league side, etc.) - no rating for them
                continue

            ratio = win_ratio(home_strength_by_team[home_team_id], away_strength_by_team[away_team_id])
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
