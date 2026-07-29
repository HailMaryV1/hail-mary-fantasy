"""
refresh_all.py
----------------
Single entrypoint for the automated data-refresh pipeline (see
.github/workflows/refresh_data.yml, twice-daily cron): odds -> fixture
extras -> SportMonks player props -> probabilities -> FanTeam player
pull -> import -> recompute scores for every upcoming gameweek. Every
step here is
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


def current_golf_tournament(conn):
    """Same "current" definition every golf page already uses (most
    recently STARTED tournament, see golf/page.tsx/golf/team/page.tsx) -
    not "most recently imported", since import timing and start_time can
    differ. Returns None if FanTeam Golf isn't seeded at all yet or no
    tournament has ever been imported - either is a legitimate steady
    state, not an error."""
    cur = conn.cursor()
    cur.execute(
        """
        select t.fanteam_tournament_id
        from golf_tournaments t
        join fantasy_games fg on fg.id = t.game_id
        where fg.slug = 'fanteam-golf'
        order by t.start_time desc
        limit 1
        """
    )
    row = cur.fetchone()
    return row[0] if row else None


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
    results.append(
        run_step("SportMonks: player-level bookmaker props", ["scripts/import_sportmonks_player_props.py"])
    )
    results.append(run_step("Fixture probabilities", ["scripts/compute_fixture_probabilities.py"]))
    results.append(run_step("Clean sheet probabilities", ["scripts/compute_clean_sheet_probabilities.py"]))
    results.append(run_step("FanTeam players (no login needed)", ["scraper_fanteam.py", "--players-only"]))
    results.append(run_step("Import FanTeam players", ["import_fanteam_live.py", "--skip-fixtures"]))
    results.append(run_step("Capture gameweek actuals", ["scripts/capture_gameweek_actuals.py"]))
    results.append(run_step("Attach gameweek results to frozen predictions", ["scripts/attach_gameweek_results.py"]))

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

    results.append(run_step("Freeze gameweek predictions (Hail Mary Form)", ["scripts/capture_gameweek_predictions.py"]))
    results.append(run_step("Evaluate Ask Mary predictions", ["scripts/evaluate_predictions.py"]))

    # FanTeam Golf - deliberately NOT the scraper/importer steps above (a
    # new tournament ID drops every week with no auto-discovery endpoint,
    # so IMPORTING a new tournament stays the manual weekly workflow -
    # paste a URL at /golf/import or run scraper_fanteam_golf.py by hand).
    # Recomputing projections for the tournament that's already been
    # imported, though, needs no new information from FanTeam at all -
    # golf_tournament_entries.avg_stats is already sitting in the DB from
    # that import - so it's exactly as safe to run unattended as the
    # football score-recompute above. Without this, a freshly-imported
    # tournament silently shows 0.0/stale-prior-week scores on Team
    # Builder/Rankings until someone remembers to run this by hand (real
    # incident: Rocket Classic GW28 import).
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        golf_tournament_ref = current_golf_tournament(conn)
    finally:
        conn.close()

    if golf_tournament_ref:
        results.append(
            run_step(f"Recompute Hail Mary Golf projections ({golf_tournament_ref})", ["scripts/compute_golf_projections.py", golf_tournament_ref])
        )
    else:
        print("\nNo FanTeam Golf tournament imported yet - skipping golf projection recompute.")

    # These two scans need no tournament ID at all - they operate on
    # every already-imported golf_tournaments row, so they're exactly as
    # safe to run unattended as their football counterparts above.
    results.append(run_step("Freeze golf predictions (Hail Mary Golf)", ["scripts/capture_golf_predictions.py"]))
    results.append(run_step("Attach golf tournament results", ["scripts/attach_golf_tournament_results.py"]))

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} steps succeeded.")
    if failed:
        raise SystemExit(f"{failed} step(s) failed - see log above.")


if __name__ == "__main__":
    main()
