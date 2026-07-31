"""
seed_cloudff_historical_stats.py
-----------------------------------
compute_projections.py projects a player's expected points by shrinking
toward their OWN historical rate - but game_player_stats is keyed by
game_player_id, not player_id, so a brand-new game (Cloud FF) starts with
zero historical rows even though the SAME real footballers already have
real 2025/26 season data captured under FanTeam's/Dream Team's own
game_player_id space (see migration 0072's docstring). This script closes
that gap: for every Cloud FF game_players row, find that same real
player's existing historical row from whichever other game has one
(preferring FanTeam's, since its raw_stats carries real PT1/PT60/PT90
appearance data Dream Team's CSV doesn't - confirmed live by comparing a
real sample of each), and insert a new game_player_stats row under Cloud
FF's own game_player_id with the same real minutes/goals/assists/etc.

total_points is NOT copied verbatim - it reflects the SOURCE game's own
scoring rules, not Cloud FF's real ones (see migration 0073). Recomputed
here using the same real per-stat point values just seeded into
game_scoring_rules, so it's a meaningful shrinkage prior specifically for
Cloud FF - not Dream Team's or FanTeam's points relabelled.

Idempotent: skips any Cloud FF game_player that already has a
2025/26 row (never overwrites a real sync/import's own data).

RUN:
    python3 scripts/seed_cloudff_historical_stats.py
"""
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
GOALS_CONCEDED_PER_2_POINTS = {"GK": -1, "DEF": -1}
APPEARANCE_POINTS = 1
MINUTES_60_PLUS_POINTS = 1


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


def compute_cloudff_total_points(position, row):
    goals_conceded_scale = GOALS_CONCEDED_PER_2_POINTS.get(position, 0) * 0.5
    total = (
        row["goals"] * GOAL_POINTS.get(position, 0)
        + row["assists"] * ASSIST_POINTS
        + row["clean_sheets"] * CLEAN_SHEET_POINTS.get(position, 0)
        + row["goals_conceded"] * goals_conceded_scale
        + row["yellow_cards"] * YELLOW_CARD_POINTS
        + row["red_cards"] * RED_CARD_POINTS
        + row["own_goals"] * OWN_GOAL_POINTS
        + (row["penalty_saves"] * PENALTY_SAVE_POINTS if position == "GK" else 0)
        + row["pt1"] * APPEARANCE_POINTS
        + row["pt60"] * MINUTES_60_PLUS_POINTS
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

        cur.execute(
            """
            select gp.id as game_player_id, gp.player_id, p.position
            from game_players gp
            join players p on p.id = gp.player_id
            where gp.game_id = %s and gp.is_active = true
            """,
            (cloudff_game_id,),
        )
        cloudff_players = cur.fetchall()

        cur.execute(
            "select game_player_id from game_player_stats where game_player_id in (select id from game_players where game_id = %s) and season = %s",
            (cloudff_game_id, SEASON),
        )
        already_seeded = {r["game_player_id"] for r in cur.fetchall()}

        seeded, skipped_existing, no_history = 0, 0, 0
        for row in cloudff_players:
            if row["game_player_id"] in already_seeded:
                skipped_existing += 1
                continue

            # Prefer FanTeam's historical row - its raw_stats carries real
            # PT1/PT60/PT90 (Dream Team's CSV doesn't, confirmed live) -
            # falling back to whatever else exists for this real player.
            cur.execute(
                """
                select gps.minutes_played, gps.goals, gps.assists, gps.clean_sheets, gps.saves,
                       gps.goals_conceded, gps.yellow_cards, gps.red_cards, gps.raw_stats
                from game_player_stats gps
                join game_players gp on gp.id = gps.game_player_id
                join fantasy_games g on g.id = gp.game_id
                where gp.player_id = %s and gps.season = %s
                order by (g.slug = 'fanteam') desc
                limit 1
                """,
                (row["player_id"], SEASON),
            )
            source = cur.fetchone()
            if not source:
                no_history += 1
                continue

            raw = source["raw_stats"] or {}
            enriched = {
                **source,
                "own_goals": float(raw.get("ownGoals") or 0),
                "penalty_saves": float(raw.get("penaltySaves") or 0),
                "pt1": float(raw.get("PT1") or 0),
                "pt60": float(raw.get("PT60") or 0),
                "pt90": float(raw.get("PT90") or 0),
            }
            total_points = compute_cloudff_total_points(row["position"], enriched)

            cur.execute(
                """
                insert into game_player_stats
                    (game_player_id, season, gameweek, minutes_played, goals, assists, clean_sheets,
                     saves, goals_conceded, yellow_cards, red_cards, total_points, raw_stats)
                values (%s, %s, 0, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    row["game_player_id"], SEASON, source["minutes_played"], source["goals"], source["assists"],
                    source["clean_sheets"], source["saves"], source["goals_conceded"], source["yellow_cards"],
                    source["red_cards"], total_points,
                    psycopg2.extras.Json({
                        "SOT": raw.get("SOT", 0), "ownGoals": raw.get("ownGoals", 0),
                        "penaltySaves": raw.get("penaltySaves", 0), "PT1": raw.get("PT1", 0),
                        "PT60": raw.get("PT60", 0), "PT90": raw.get("PT90", 0),
                    }),
                ),
            )
            seeded += 1

        conn.commit()
        print(f"Seeded {seeded} Cloud FF historical rows, {skipped_existing} already had one, {no_history} had no real historical data anywhere.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
