"""
refresh_odds_for_game.py
--------------------------
Backs the "Update Odds" button (2026-08-08 user request) - the on-
demand counterpart to refresh_data.yml's scheduled odds steps, for
whenever the user wants fresh bookmaker data right now rather than
waiting for the next scheduled run. Dispatched via GitHub Actions
workflow_dispatch (odds_refresh_requested.yml), triggered by
frontend-v2's dispatchOddsRefresh server action.

Re-runs the SAME odds-fetching scripts refresh_all.py already runs on
its own schedule (match odds, player props, team-totals/clean-sheet
market, EFL's own SportMonks match odds) - genuinely shared across
every game (bookmaker_player_features/fixture_probabilities/etc. have
no game_id at all, see those tables' own docstrings), so this always
refreshes all of them regardless of which game's button was clicked.
Only the final recompute step is game-scoped, to the game whose button
was actually pressed - recomputing every other game's projections too
would be wasted work nobody asked for.

Marks odds_refresh_status (migration 0108) 'ok'/'error' with completed_at
set either way, so the frontend's poll loop always has something to
stop on - even a genuine failure needs to unblock the "loading" state,
not spin forever.

RUN:
    python3 scripts/refresh_odds_for_game.py <game_slug>
"""
import os
import subprocess
import sys
import traceback
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from refresh_all import upcoming_gameweeks  # noqa: E402


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


def run_step(label, relative_args):
    print(f"\n=== {label} ===")
    result = subprocess.run([sys.executable, *relative_args], cwd=ROOT)
    if result.returncode != 0:
        raise RuntimeError(f"{label} failed (exit {result.returncode})")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 scripts/refresh_odds_for_game.py <game_slug>")
    game_slug = sys.argv[1]

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor()
    cur.execute("select id from fantasy_games where slug = %s", (game_slug,))
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"Unknown game slug: {game_slug}")
    game_id = row[0]

    def mark_status(status, error_message=None):
        cur.execute(
            "update odds_refresh_status set status = %s, error_message = %s, completed_at = now() where game_id = %s",
            (status, error_message, game_id),
        )
        conn.commit()

    try:
        # Shared, game-independent odds sources - same steps refresh_all.py
        # runs on its own schedule (see that script for why each exists).
        run_step("EFL real match odds (SportMonks)", ["scripts/import_sportmonks_match_odds.py"])
        run_step("Fixture probabilities", ["scripts/compute_fixture_probabilities.py"])
        run_step("Player props (goals/assists, SportMonks)", ["scripts/import_sportmonks_player_props.py"])
        run_step("Team totals / clean-sheet market (Odds API)", ["scripts/import_fixture_extras.py", "--limit", "40"])
        run_step("Clean sheet probabilities", ["scripts/compute_clean_sheet_probabilities.py"])

        gameweeks = upcoming_gameweeks(conn, game_slug)
        if not gameweeks:
            print(f"\nNo upcoming {game_slug} gameweeks found - skipping score recompute.")
        else:
            print(f"\nRecomputing {game_slug} for gameweeks: {gameweeks}")
            for gw in gameweeks:
                run_step(f"Recompute {game_slug} GW{gw}", ["scripts/compute_projections.py", game_slug, "--gameweek", str(gw)])

        mark_status("ok")
        print(f"\nOdds refresh complete for {game_slug}.")
    except Exception as exc:
        traceback.print_exc()
        mark_status("error", str(exc)[:500])
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
