"""
refresh_all.py
----------------
Single entrypoint for the automated data-refresh pipeline (see
.github/workflows/refresh_data.yml, twice-daily cron): odds -> fixture
extras -> probabilities -> FanTeam player pull -> import -> recompute
scores for every upcoming gameweek. Every step here is
authentication-free (the FanTeam player pull needs no login - confirmed
live, see scraper_fanteam.py) so this can run entirely unattended in CI.

Deliberately excludes:
  - compute_team_strength.py - manually re-run from screenshot odds, not
    on a schedule (see its own docstring).
  - FanTeam's fixture/gameweek-calendar refresh - needs a real login
    token that eventually expires (confirmed - see scraper_fanteam.py's
    fetch_fixtures docstring). Manual/occasional path only, run by hand
    if the season's schedule ever changes.
  - Dream Team - no live scrape source at all yet (existing, unrelated
    limitation).

Each step's failure is logged but doesn't abort the rest (e.g. a
transient Odds API hiccup shouldn't also block the FanTeam player pull,
or vice versa) - exits non-zero only if something failed, so GitHub
Actions surfaces a red run either way.

RUN:
    python3 scripts/refresh_all.py
"""

import os
import subprocess
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
MAX_GAMEWEEKS_AHEAD = 5


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


def run_step(label, relative_args):
    print(f"\n=== {label} ===")
    result = subprocess.run([sys.executable, *relative_args], cwd=ROOT)
    ok = result.returncode == 0
    if not ok:
        print(f"[FAILED] {label} (exit {result.returncode})")
    return ok


def upcoming_gameweeks(conn):
    cur = conn.cursor()
    cur.execute(
        """
        select distinct gfg.gameweek
        from game_fixture_gameweeks gfg
        join fixtures f on f.id = gfg.fixture_id
        join fantasy_games fg on fg.id = gfg.game_id
        where fg.slug = 'fanteam' and f.kickoff_at >= now()
        order by gfg.gameweek
        limit %s
        """,
        (MAX_GAMEWEEKS_AHEAD,),
    )
    return [row[0] for row in cur.fetchall()]


def main():
    load_env()
    results = []

    results.append(run_step("Odds: fixtures + h2h", ["scripts/import_fixtures_odds.py"]))
    results.append(
        run_step("Odds: fixture extras (team totals / player props)", ["scripts/import_fixture_extras.py", "--limit", "20"])
    )
    results.append(run_step("Fixture probabilities", ["scripts/compute_fixture_probabilities.py"]))
    results.append(run_step("Clean sheet probabilities", ["scripts/compute_clean_sheet_probabilities.py"]))
    results.append(run_step("FanTeam players (no login needed)", ["scraper_fanteam.py", "--players-only"]))
    results.append(run_step("Import FanTeam players", ["import_fanteam_live.py", "--skip-fixtures"]))
    results.append(run_step("Capture gameweek actuals", ["scripts/capture_gameweek_actuals.py"]))

    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        gameweeks = upcoming_gameweeks(conn)
    finally:
        conn.close()

    if not gameweeks:
        print("\nNo upcoming FanTeam gameweeks found in game_fixture_gameweeks - skipping score recompute.")
    else:
        print(f"\nRecomputing Hail Mary Score for FanTeam gameweeks: {gameweeks}")
        for gw in gameweeks:
            results.append(
                run_step(f"Recompute FanTeam GW{gw}", ["scripts/compute_projections.py", "fanteam", "--gameweek", str(gw)])
            )

    results.append(run_step("Evaluate Ask Mary predictions", ["scripts/evaluate_predictions.py"]))

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} steps succeeded.")
    if failed:
        raise SystemExit(f"{failed} step(s) failed - see log above.")


if __name__ == "__main__":
    main()
