"""
seed_dreamteam_historical_stats.py
-------------------------------------
compute_projections.py projects a player's expected points by shrinking
toward their OWN historical rate - game_player_stats needs a season-
aggregate (gameweek=0) row per Dream Team game_player for that to work.

Previously this came from a one-off historical CSV
(import_historical_data.py, no longer in this repo) - a stale, one-time
snapshot with no live source at all. That's no longer necessary:
scraper_dreamteam_stats.py now pulls Dream Team's own real
api/players/stats endpoint - real, live, season-cumulative per-player
totals (confirmed live 2026-08-22), matched via game_players.external_id
against that endpoint's own "playerId" field (the SAME uuid space as
/api/players' "id", already used by import_dreamteam.py - no name-
matching needed, a first among this project's provider integrations).
This script now seeds from THAT real Dream Team data directly, following
seed_cloudff_historical_stats.py's exact established pattern (self-
contained point-value constants, no import from compute_projections.py,
idempotent delete+reinsert every run so the real season total keeps
growing as more gameweeks complete).

total_points is recomputed here (not copied from totalPoints) using the
same real per-stat point values seeded into game_scoring_rules for
dreamteam (migration matching Section 3.2.4 of Dream Team's rules) -
Dream Team's own totalPoints reflects THEIR exact scoring engine
(including the tiered Bonus Points/PPM system), which this project only
approximates - see compute_bonus_points()'s own docstring in
compute_projections.py for the accepted v1 simplifications (fixture-flat
PPM components, Jensen's-inequality gap on the tier step function).
Recomputing keeps this a meaningful, internally consistent shrinkage
prior rather than a number computed under Dream Team's own undisclosed
exact rules. The bonus-points component below reuses the same
pass_completion_ppm/bonus_tier step functions compute_projections.py
itself uses (duplicated here rather than imported, matching this
script's sibling's self-contained-constants convention) - applied to a
season-AVERAGE PPM rate (raw counts / games_played) rather than per-
match, then multiplied back out by games_played, since only season
totals exist at this granularity.

No real minutes-played or starts/appearances COUNT field exists
anywhere in this endpoint (52 keys inspected live, confirmed by
scraper_dreamteam_stats.py's own docstring) - a genuine, permanent
upstream gap, same class as FanTeam's missing per-gameweek minutes.
games_played is instead derived as round(totalPoints / averagePoints)
- both real fields, and averagePoints is presumably exactly totalPoints
/ games_played on Dream Team's own side, so this recovers a real
(rounded) games-played count rather than guessing one outright. From
that, minutes_played is set to games_played * ASSUMED_MINUTES_PER_
APPEARANCE (Dream Team's own existing Premier League-wide fallback
constant in compute_projections.py, duplicated here) and PT1/PT60/PT90
are deliberately left at 0 - compute_projections.py's own
_implied_involvement() already has a minutes_played-only fallback path
for exactly this "no real PT1/60/90 export" situation (previously
triggered by the stale CSV's minutes_played; now triggered by this
real, live, growing-every-gameweek derived figure instead - strictly an
improvement, not a new mechanism).

Idempotent per real Dream Team data pull: deletes and re-inserts each
Dream Team game_player's gameweek=0 row every run (same as Cloud FF's
own script), written to season=HISTORICAL_SEASON (compute_projections.
py's "2025/26" constant, repurposed the same way seed_cloudff_
historical_stats.py already repurposes it - as "the shrinkage-prior
slot", not literally last calendar year - since neither game has a real
prior-season row to seed separately).

RUN:
    python3 scripts/seed_dreamteam_historical_stats.py
"""
import json
import os
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
SEASON = "2025/26"

ASSUMED_MINUTES_PER_APPEARANCE = 75.0
ASSUMED_COND60_RATE = 0.82

# Dream Team's real Section 3.2.4 per-stat point values - see the
# migration that seeded game_scoring_rules for dreamteam.
GOAL_POINTS = 6.00
ASSIST_POINTS = 3.00
BIG_CHANCE_CREATED_POINTS = 1.00
SHOT_ON_TARGET_POINTS = 1.00
TACKLE_POINTS = 0.50  # "1 point per 2 successful tackles"
YELLOW_CARD_POINTS = -1.00
RED_CARD_POINTS = -3.00
OWN_GOAL_POINTS = -2.00
PENALTY_MISS_POINTS = -3.00
APPEARANCE_POINTS = 1.00
MINUTES_60_PLUS_POINTS = 1.00
CLEAN_SHEET_POINTS = {"GK": 5.00, "DEF": 5.00}
GOALS_CONCEDED_PER_2_POINTS = -1.00  # applied at 0.5x per goal below
PENALTY_SAVE_POINTS = 3.00  # GK only
SAVE_POINTS = 0.50  # GK only, "1 point per 2 saves"

# Bonus Points (Section 3.2.4.3/3.2.4.4) - the same 12-component PPM +
# pass-completion-tier system compute_projections.py's compute_bonus_
# points() implements for live projections, duplicated here in its pure,
# unshrunk form (no weights/position_avg exist at seed time - this
# script only has one real player's own season totals to work with).
PPM_WEIGHTS = {
    "dribbles": 1, "crosses": 1, "offsides": -1, "interceptions": 1,
    "blocks": 1, "goalsOutsideArea": 1, "foulsWon": 1, "foulsMade": -1,
    "errorsLeadingToGoal": -2,
}
PPM_GK_WEIGHTS = {"claims": 1, "punches": 1, "keeperSweeps": 1}


def pass_completion_ppm(rate_pct):
    if rate_pct >= 90:
        return 3
    if rate_pct >= 80:
        return 2
    if rate_pct >= 70:
        return 1
    return 0


def bonus_tier(ppm):
    if ppm >= 12:
        return 5
    if ppm >= 8:
        return 3
    if ppm >= 5:
        return 1
    return 0


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


def compute_dreamteam_total_points(position, s, games_played):
    total = (
        s["goals"] * GOAL_POINTS
        + s["assists"] * ASSIST_POINTS
        + s["chancesCreated"] * BIG_CHANCE_CREATED_POINTS
        + s["shotsOnTarget"] * SHOT_ON_TARGET_POINTS
        + s["tackles"] * TACKLE_POINTS
        + s["yellowCards"] * YELLOW_CARD_POINTS
        + s["redCards"] * RED_CARD_POINTS
        + s["ownGoals"] * OWN_GOAL_POINTS
        + s["penaltyMisses"] * PENALTY_MISS_POINTS
        + s["cleanSheet"] * CLEAN_SHEET_POINTS.get(position, 0)
        + s["goalsConceded"] * GOALS_CONCEDED_PER_2_POINTS * 0.5
        + (s["penaltySaves"] * PENALTY_SAVE_POINTS if position == "GK" else 0)
        + (s["saves"] * SAVE_POINTS if position == "GK" else 0)
        + games_played * APPEARANCE_POINTS
        + games_played * ASSUMED_COND60_RATE * MINUTES_60_PLUS_POINTS
        + compute_bonus_points_total(position, s, games_played)
    )
    return round(total, 2)


def compute_bonus_points_total(position, s, games_played):
    """Season-average PPM (raw counts / games_played) through the same
    tiered bonus_tier() step function real per-fixture projections use,
    multiplied back out by games_played - the only granularity available
    from a season-aggregate endpoint. Same Jensen's-inequality caveat
    compute_bonus_points()'s own docstring already flags: averaging then
    tiering slightly underestimates true total bonus for a player who
    straddles a tier boundary match to match."""
    if games_played <= 0:
        return 0.0
    ppm = 0.0
    for stat, weight in PPM_WEIGHTS.items():
        ppm += (s.get(stat, 0) / games_played) * weight
    if position == "GK":
        for stat, weight in PPM_GK_WEIGHTS.items():
            ppm += (s.get(stat, 0) / games_played) * weight
    ppm += pass_completion_ppm(s.get("passCompletionRate", 0) or 0)
    return bonus_tier(ppm) * games_played


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    try:
        cur.execute("select id from fantasy_games where slug = 'dreamteam'")
        row = cur.fetchone()
        if not row:
            print("No dreamteam fantasy_games row - skipping.")
            return
        dreamteam_game_id = row["id"]

        raw_path = ROOT / "dreamteam_player_stats_raw.json"
        if not raw_path.exists():
            print("No dreamteam_player_stats_raw.json found - run scraper_dreamteam_stats.py first. Skipping.")
            return
        stats_data = json.loads(raw_path.read_text(encoding="utf-8"))
        stats_by_external_id = {str(s["playerId"]): s for s in stats_data}

        cur.execute(
            """
            select gp.id as game_player_id, gp.external_id, gp.position_code as position
            from game_players gp
            join players p on p.id = gp.player_id
            where gp.game_id = %s and gp.is_active = true
            """,
            (dreamteam_game_id,),
        )
        dreamteam_players = cur.fetchall()

        seeded, no_real_stats = 0, 0
        for row in dreamteam_players:
            s = stats_by_external_id.get(row["external_id"])
            if not s:
                no_real_stats += 1
                continue

            total_points_ref = s.get("totalPoints") or 0
            average_points_ref = s.get("averagePoints") or 0
            games_played = round(total_points_ref / average_points_ref) if average_points_ref else 0
            minutes_played = games_played * ASSUMED_MINUTES_PER_APPEARANCE

            total_points = compute_dreamteam_total_points(row["position"], s, games_played)

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
                    minutes_played, s["goals"], s["assists"], s["cleanSheet"],
                    s["saves"], s["goalsConceded"], s["yellowCards"], s["redCards"],
                    total_points,
                    psycopg2.extras.Json({
                        "shotsOnTarget": s["shotsOnTarget"],
                        "ownGoals": s["ownGoals"],
                        "penaltySaves": s["penaltySaves"],
                        "chancesCreated": s["chancesCreated"],
                        "tackles": s["tackles"],
                        "penaltyMisses": s["penaltyMisses"],
                        "dribbles": s["dribbles"],
                        "crosses": s["crosses"],
                        "offsides": s["offsides"],
                        "passCompletionRate": s["passCompletionRate"],
                        "interceptions": s["interceptions"],
                        "blocks": s["blocks"],
                        "goalsOutsideArea": s["goalsOutsideArea"],
                        "foulsWon": s["foulsWon"],
                        "foulsMade": s["foulsMade"],
                        "errorsLeadingToGoal": s["errorsLeadingToGoal"],
                        "claims": s["claims"],
                        "punches": s["punches"],
                        "keeperSweeps": s["keeperSweeps"],
                        # Deliberately 0 - no real per-match PT1/PT60/PT90
                        # export exists for Dream Team (see this script's
                        # own docstring); compute_projections.py's
                        # _implied_involvement() falls back to the real
                        # minutes_played derived above instead.
                        "PT1": 0,
                        "PT60": 0,
                        "PT90": 0,
                        "games_played_derived": games_played,
                    }),
                ),
            )
            seeded += 1

        conn.commit()
        print(f"Seeded {seeded} real Dream Team historical rows from Dream Team's own live data, {no_real_stats} had no matching real stats row.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
