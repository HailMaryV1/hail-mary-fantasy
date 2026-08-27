"""
recompute_team_strength_for_game.py
--------------------------------------
Backs the Team Strength admin page (2026-08-26 user request - "build
our own adjustable fixture difficulty scale... when adjusted and saved
it should recompute all our projections"). Dispatched via GitHub
Actions workflow_dispatch (team_strength_adjusted.yml), triggered by
frontend-v2's saveTeamStrengthOverride server action.

Deliberately a NEW, narrower script - not an addition to refresh_odds_
for_game.py, which re-fetches real market odds from 4 external
providers on every run. A strength adjustment changes nothing about
what the bookmakers are offering; it only needs to regenerate the
FALLBACK model derived from team_season_strength and reprice:

  1. compute_fixture_strength_probabilities.py - regenerates
     fixture_strength_model_probabilities fresh from team_season_
     strength (picks up the just-written manual_strength_override
     automatically, see that script's own docstring - it's a pure
     function of that table, no other change needed).
  2. compute_projections.py, looped over this game's own upcoming
     gameweeks (same refresh_all.upcoming_gameweeks scoping refresh_
     odds_for_game.py already uses) - hail_mary_score/rating.
  3. compute_target_scores.py, same gameweeks - Target Score's own
     Fixture Difficulty/Live Odds also read team_fixture_difficulty,
     and this session's own history shows skipping this step leaves it
     silently stale.

Reuses odds_refresh_status (migration 0108) rather than a new status
table - already keyed by game_id, already has exactly the
running/ok/error/completed_at shape this needs.

RUN:
    python3 scripts/recompute_team_strength_for_game.py <game_slug>
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
        raise SystemExit("Usage: python3 scripts/recompute_team_strength_for_game.py <game_slug>")
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
        mark_status("running")

        run_step("Fixture strength model (from team_season_strength)", ["scripts/compute_fixture_strength_probabilities.py"])

        gameweeks = upcoming_gameweeks(conn, game_slug)
        if not gameweeks:
            print(f"\nNo upcoming {game_slug} gameweeks found - skipping score recompute.")
        else:
            print(f"\nRecomputing {game_slug} for gameweeks: {gameweeks}")
            for gw in gameweeks:
                run_step(f"Recompute {game_slug} GW{gw}", ["scripts/compute_projections.py", game_slug, "--gameweek", str(gw)])
                run_step(f"Recompute target scores {game_slug} GW{gw}", ["scripts/compute_target_scores.py", game_slug, "--gameweek", str(gw)])

        mark_status("ok")
        print(f"\nTeam strength recompute complete for {game_slug}.")
    except Exception as exc:
        traceback.print_exc()
        mark_status("error", str(exc)[:500])
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
