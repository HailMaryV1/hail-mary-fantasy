"""
seed_cloudff_historical_stats.py
-----------------------------------
compute_projections.py projects a player's expected points by shrinking
toward their OWN historical rate - game_player_stats needs a season-
aggregate (gameweek=0) row per Cloud FF game_player for that to work.

Previously this borrowed a real player's historical row from whichever
OTHER game (FanTeam/Dream Team) already had one, since Cloud FF's own
getPlayerStats endpoint wasn't wired into the scraper yet. That's no
longer necessary: scraper_cloudff.py now also pulls
getPlayerStats?startGW=1&endGW=1000, Cloud FF's own real season-cumulative
per-player totals (confirmed live) - including the "Bonus Points System"
tiers (TotalSavesPts/TotalTacklePts/TotalAccuratePassPts/
TotalOnTargetScoringAttPts) cloud-ff.co.uk/stats displays, which no other
game's data could ever substitute for. This script now seeds from THAT
real Cloud FF data directly, joined on game_players.external_id (Cloud
FF's own player id, written by import_cloudff.py) matching getPlayerStats'
own "id" field.

total_points is recomputed here (not copied from TotalPoints) using the
same real per-stat point values seeded into game_scoring_rules for
cloudff - Cloud FF's own TotalPoints reflects THEIR full rules (including
things like the Bonus Points System's real tier ladder, appearance
timing, etc.) which won't exactly match this project's approximations
(see migration 0073's docstring for the two flagged ones: Starting XI/
Substitution Appearance, and the goals-conceded flat-vs-linear
difference) - so recomputing keeps this a meaningful, internally
consistent shrinkage prior rather than a number computed under different
rules.

pt1 (appearance) is real - TotalStartingXI + TotalSubs, since every start
or substitute appearance is at least one minute played. pt60 (played 60+
minutes) has no direct per-match count in this season-aggregate data -
approximated as TotalStartingXI alone (a start being a strong, real-data-
grounded proxy for 60+ minutes, not a guess), the same class of
approximation migration 0073's own docstring already flags for the
appearance/minutes_60_plus scoring rule itself. pt90 isn't used by any
currently-seeded cloudff scoring rule, left at 0.

Idempotent per real cloudff data pull: deletes and re-inserts each Cloud
FF game_player's gameweek=0 row every run (unlike the old cross-game
borrow, which only ever ran once per player - this one should track
Cloud FF's own season total as it grows, same as every other game's
historical row).

RUN:
    python3 scripts/seed_cloudff_historical_stats.py
"""
import json
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

SEASON = "2025/26"

# Cloud FF's real, published per-stat point values (migration 0073) -
# duplicated here (not imported from compute_projections.py) since this
# is a one-off seed of a HISTORICAL total, not a live projection call.
GOAL_POINTS = {"GK": 7, "DEF": 7, "MID": 6, "FWD": 5}
CLEAN_SHEET_POINTS = {"GK": 7, "DEF": 5}
ASSIST_POINTS = 3
OWN_GOAL_POINTS = -2
YELLOW_CARD_POINTS = -1
RED_CARD_POINTS = -3
PENALTY_SAVE_POINTS = 4
PENALTY_MISS_POINTS = -2
GOALS_CONCEDED_PER_2_POINTS = {"GK": -1, "DEF": -1}
APPEARANCE_POINTS = 1
MINUTES_60_PLUS_POINTS = 1
# Cloud FF's own backend already tiers these into point totals - see
# scraper_cloudff.py's getPlayerStats docstring - so they're summed
# straight through at 1.00, same as their game_scoring_rules rows.
BONUS_POINTS_MULTIPLIER = 1.0


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


def compute_cloudff_total_points(position, s):
    goals_conceded_scale = GOALS_CONCEDED_PER_2_POINTS.get(position, 0) * 0.5
    total = (
        s["TotalGoals"] * GOAL_POINTS.get(position, 0)
        + s["TotalAssists"] * ASSIST_POINTS
        + s["TotalCleanSheets"] * CLEAN_SHEET_POINTS.get(position, 0)
        + s["TotalGoalsConceded"] * goals_conceded_scale
        + s["TotalYellowCards"] * YELLOW_CARD_POINTS
        + s["TotalRedCards"] * RED_CARD_POINTS
        + s["TotalOwnGoals"] * OWN_GOAL_POINTS
        + s["TotalMissedPenalties"] * PENALTY_MISS_POINTS
        + (s["TotalPenaltySaves"] * PENALTY_SAVE_POINTS if position == "GK" else 0)
        + (s["TotalStartingXI"] + s["TotalSubs"]) * APPEARANCE_POINTS
        + s["TotalStartingXI"] * MINUTES_60_PLUS_POINTS
        + (s["TotalSavesPts"] + s["TotalTacklePts"] + s["TotalAccuratePassPts"] + s["TotalOnTargetScoringAttPts"])
        * BONUS_POINTS_MULTIPLIER
    )
    return round(total, 2)


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        cur.execute("select id from fantasy_games where slug = 'cloudff'")
        cloudff_game_id = cur.fetchone()["id"]

        stats_data = json.loads((ROOT / "cloudff_player_stats_raw.json").read_text(encoding="utf-8"))
        stats_by_external_id = {str(s["id"]): s for s in stats_data}

        cur.execute(
            """
            select gp.id as game_player_id, gp.external_id, p.position
            from game_players gp
            join players p on p.id = gp.player_id
            where gp.game_id = %s and gp.is_active = true
            """,
            (cloudff_game_id,),
        )
        cloudff_players = cur.fetchall()

        seeded, no_real_stats = 0, 0
        for row in cloudff_players:
            s = stats_by_external_id.get(row["external_id"])
            if not s:
                no_real_stats += 1
                continue

            total_points = compute_cloudff_total_points(row["position"], s)

            cur.execute(
                "delete from game_player_stats where game_player_id = %s and season = %s and gameweek = 0",
                (row["game_player_id"], SEASON),
            )
            cur.execute(
                """
                insert into game_player_stats
                    (game_player_id, season, gameweek, minutes_played, goals, assists, clean_sheets,
                     saves, goals_conceded, yellow_cards, red_cards, total_points, raw_stats)
                values (%s, %s, 0, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    row["game_player_id"], SEASON,
                    s["TotalMinutesPlayed"], s["TotalGoals"], s["TotalAssists"], s["TotalCleanSheets"],
                    s["TotalSaves"], s["TotalGoalsConceded"], s["TotalYellowCards"], s["TotalRedCards"],
                    total_points,
                    psycopg2.extras.Json({
                        "SOT": s["TotalOnTargetAttempts"],
                        "ownGoals": s["TotalOwnGoals"],
                        "penaltySaves": s["TotalPenaltySaves"],
                        "penaltyMisses": s["TotalMissedPenalties"],
                        "PT1": s["TotalStartingXI"] + s["TotalSubs"],
                        "PT60": s["TotalStartingXI"],
                        "PT90": 0,
                        "savePts": s["TotalSavesPts"],
                        "tacklePts": s["TotalTacklePts"],
                        "passPts": s["TotalAccuratePassPts"],
                        "sotPts": s["TotalOnTargetScoringAttPts"],
                        "ownership": s["Ownership"],
                    }),
                ),
            )
            seeded += 1

        conn.commit()
        print(f"Seeded {seeded} real Cloud FF historical rows from Cloud FF's own data, {no_real_stats} had no matching real stats row.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
