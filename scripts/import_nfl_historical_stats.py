"""
import_nfl_historical_stats.py
--------------------------------
Populates players / game_players / nfl_game_player_stats with real 2025
NFL regular season box-score totals, giving the NFL FanTeam game a real
"base of knowledge" before any live tournament exists to scrape.

Source: espn.com's public stats pages. Each page embeds its data as a
JSON blob (window['__espnfitt__']) server-rendered into the HTML - no
auth, no scraping fragility from parsing rendered tables, same idea as
probe_odds_api.py's "confirm the shape before building" pattern (see
probe_nfl_stats_source.py, which explored a different source - nflverse's
CSV releases - before this ESPN-based approach was chosen instead).

Pulls three player stat categories (passing, rushing, receiving) across
their real pagination, merges them per player by ESPN's stable athlete
id, and separately pulls team defense stats (points allowed, sacks,
interceptions) for the 32 DST "players" this game rosters as whole-team
units. Fumble recoveries / safeties / blocked kicks aren't reliably
exposed by ESPN's team defense pages and are left at 0 for this
historical baseline - a known, minor gap (rare events, small point
values) rather than a blocking one.

Every player's season total_points is computed by running their raw
stats through the exact game_scoring_rules seeded in migration 0038,
then used to derive a rough £4m-£20m price band (there's no real
FanTeam price for these players since no NFL FanTeam tournament has
been drafted yet - this price is a placeholder until a live contest
gives real prices to import instead).

Safe to re-run: everything is upserted (players by full_name+position,
game_players by (game_id, external_id), nfl_game_player_stats by
(game_player_id, season, gameweek)).

RUN:
    python3 scripts/import_nfl_historical_stats.py
"""

import json
import os
import re
import sys
import urllib.request
from pathlib import Path

import psycopg2
import psycopg2.extras

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
SEASON = "2025"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

ESPN_TEAM_TO_CANONICAL = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "KC": "Kansas City Chiefs", "LV": "Las Vegas Raiders", "LAC": "Los Angeles Chargers",
    "LAR": "Los Angeles Rams", "MIA": "Miami Dolphins", "MIN": "Minnesota Vikings",
    "NE": "New England Patriots", "NO": "New Orleans Saints", "NYG": "New York Giants",
    "NYJ": "New York Jets", "PHI": "Philadelphia Eagles", "PIT": "Pittsburgh Steelers",
    "SF": "San Francisco 49ers", "SEA": "Seattle Seahawks", "TB": "Tampa Bay Buccaneers",
    "TEN": "Tennessee Titans", "WSH": "Washington Commanders",
}

# ESPN's roster position -> this game's roster positions.
ESPN_POSITION_MAP = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "FB": "RB"}


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def get_espn_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        html = resp.read().decode("utf-8", errors="replace")
    match = re.search(r"window\[.__espnfitt__.\]\s*=\s*(\{.*?\});", html)
    return json.loads(match.group(1))


def num(value):
    if value in (None, "", "-", "--"):
        return 0.0
    return float(str(value).replace(",", ""))


def fetch_player_category(stat_key, sort_key, wanted_fields):
    """Paginates one player stat category (passing/rushing/receiving),
    returns {espn_athlete_id: {"name", "team", "position", **wanted_fields}}."""
    out = {}
    page = 1
    while True:
        url = f"https://www.espn.com/nfl/stats/player/_/stat/{stat_key}/season/{SEASON}/seasontype/2/table/{stat_key}/sort/{sort_key}/dir/desc/page/{page}"
        data = get_espn_json(url)
        block = data["page"]["content"]["statistics"]
        total_pages = block["metadata"]["totalPages"]
        for row in block["playerStats"]:
            athlete = row["athlete"]
            athlete_id_match = re.search(r"/id/(\d+)/", athlete["href"])
            if not athlete_id_match:
                continue
            athlete_id = athlete_id_match.group(1)
            stat_by_name = {s["name"]: s["value"] for s in row["stats"]}
            entry = out.setdefault(athlete_id, {
                "name": athlete["name"],
                "team": athlete["team"].split("/")[0],  # take current/first team for mid-season trades
                "position": athlete["position"],
            })
            for field, espn_name in wanted_fields.items():
                entry[field] = num(stat_by_name.get(espn_name))
        print(f"  {stat_key} page {page}/{total_pages}: {len(block['playerStats'])} rows")
        if page >= total_pages:
            break
        page += 1
    return out


def fetch_team_defense():
    """Returns {team_abbrev: {"points_allowed", "def_sacks", "def_interceptions"}}."""
    out = {}
    data = get_espn_json(f"https://www.espn.com/nfl/stats/team/_/view/defense/season/{SEASON}/seasontype/2")
    for row in data["page"]["content"]["teamStats"]:
        abbrev = row["team"]["abbrev"]
        stat_by_name = {s["name"]: s["value"] for s in row["stats"]}
        out[abbrev] = {"points_allowed": num(stat_by_name.get("totalPoints"))}

    data = get_espn_json(f"https://www.espn.com/nfl/stats/team/_/view/defense/stat/passing/season/{SEASON}/seasontype/2")
    for row in data["page"]["content"]["teamStats"]:
        abbrev = row["team"]["abbrev"]
        stat_by_name = {s["name"]: s["value"] for s in row["stats"]}
        out.setdefault(abbrev, {})
        out[abbrev]["def_sacks"] = num(stat_by_name.get("sacks"))
        out[abbrev]["def_interceptions"] = num(stat_by_name.get("interceptions"))
    return out


def score_offense(rules, stats):
    total = 0.0
    total += stats.get("pass_yards", 0) * rules.get(("all", "pass_yard"), 0)
    total += stats.get("pass_tds", 0) * rules.get(("all", "pass_td"), 0)
    total += stats.get("pass_ints", 0) * rules.get(("all", "interception_thrown"), 0)
    total += stats.get("rush_yards", 0) * rules.get(("all", "rush_yard"), 0)
    total += stats.get("rush_tds", 0) * rules.get(("all", "rush_td"), 0)
    total += stats.get("receptions", 0) * rules.get(("all", "reception"), 0)
    total += stats.get("rec_yards", 0) * rules.get(("all", "rec_yard"), 0)
    total += stats.get("rec_tds", 0) * rules.get(("all", "rec_td"), 0)
    total += stats.get("fumbles_lost", 0) * rules.get(("all", "fumble_lost"), 0)
    return total


def points_allowed_tier(points_allowed_per_game):
    if points_allowed_per_game <= 0:
        return "points_allowed_tier_0"
    if points_allowed_per_game <= 6:
        return "points_allowed_tier_1_6"
    if points_allowed_per_game <= 13:
        return "points_allowed_tier_7_13"
    if points_allowed_per_game <= 20:
        return "points_allowed_tier_14_20"
    if points_allowed_per_game <= 27:
        return "points_allowed_tier_21_27"
    if points_allowed_per_game <= 34:
        return "points_allowed_tier_28_34"
    return "points_allowed_tier_35_plus"


def score_dst(rules, stats, games_played):
    total = 0.0
    total += stats.get("def_sacks", 0) * rules.get(("DST", "sack"), 0)
    total += stats.get("def_interceptions", 0) * rules.get(("DST", "def_interception"), 0)
    # points-allowed tiers are per-game bands; approximate a season total by
    # applying the season's per-game-average tier across every game played.
    per_game = stats.get("points_allowed", 0) / games_played if games_played else 0
    tier_stat = points_allowed_tier(per_game)
    total += games_played * rules.get(("DST", tier_stat), 0)
    return total


def price_from_points(points, min_points, max_points, min_price=4.0, max_price=20.0):
    if max_points <= min_points:
        return min_price
    ratio = max(0.0, min(1.0, (points - min_points) / (max_points - min_points)))
    return round(min_price + ratio * (max_price - min_price), 1)


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        with conn.cursor() as cur:
            cur.execute("select id from fantasy_games where slug = 'nfl-fanteam'")
            game_id = cur.fetchone()[0]

            cur.execute("select applies_to, stat, points from game_scoring_rules where game_id = %s", (game_id,))
            rules = {(applies_to, stat): float(points) for applies_to, stat, points in cur.fetchall()}

            cur.execute("select id, name from teams where name = any(%s)", (list(ESPN_TEAM_TO_CANONICAL.values()),))
            team_id_by_name = {name: tid for tid, name in cur.fetchall()}

        print("Fetching passing stats...")
        passing = fetch_player_category("passing", "passingYards", {
            "pass_yards": "passingYards", "pass_tds": "passingTouchdowns",
            "pass_ints": "interceptions", "games": "gamesPlayed",
        })
        print("Fetching rushing stats...")
        rushing = fetch_player_category("rushing", "rushingYards", {
            "rush_yards": "rushingYards", "rush_tds": "rushingTouchdowns",
            "rush_fumbles_lost": "rushingFumblesLost", "games": "gamesPlayed",
        })
        print("Fetching receiving stats...")
        receiving = fetch_player_category("receiving", "receivingYards", {
            "receptions": "receptions", "rec_yards": "receivingYards",
            "rec_tds": "receivingTouchdowns", "rec_fumbles_lost": "receivingFumblesLost",
            "games": "gamesPlayed",
        })
        print("Fetching team defense stats...")
        defense = fetch_team_defense()

        merged = {}
        for source in (passing, rushing, receiving):
            for athlete_id, entry in source.items():
                merged.setdefault(athlete_id, {"name": entry["name"], "team": entry["team"], "position": entry["position"]})
                existing_games = merged[athlete_id].get("games", 0)
                merged[athlete_id].update({k: v for k, v in entry.items() if k not in ("name", "team", "position")})
                # games-played should agree across categories, but a player may be
                # missing from one (e.g. a WR who never rushed) - keep the max seen.
                merged[athlete_id]["games"] = max(existing_games, entry.get("games", 0))

        players_to_import = []
        for athlete_id, entry in merged.items():
            position = ESPN_POSITION_MAP.get(entry["position"])
            if not position:
                continue  # not a fantasy-relevant offensive position (K, OL, DEF/ST individuals, etc.)
            canonical_team = ESPN_TEAM_TO_CANONICAL.get(entry["team"])
            if not canonical_team:
                continue  # free agent / no current team listed
            stats = {
                "pass_yards": entry.get("pass_yards", 0), "pass_tds": entry.get("pass_tds", 0),
                "pass_ints": entry.get("pass_ints", 0), "rush_yards": entry.get("rush_yards", 0),
                "rush_tds": entry.get("rush_tds", 0), "receptions": entry.get("receptions", 0),
                "rec_yards": entry.get("rec_yards", 0), "rec_tds": entry.get("rec_tds", 0),
                "fumbles_lost": entry.get("rush_fumbles_lost", 0) + entry.get("rec_fumbles_lost", 0),
            }
            total_points = score_offense(rules, stats)
            players_to_import.append({
                "athlete_id": athlete_id, "name": entry["name"], "position": position,
                "team_name": canonical_team, "stats": stats, "total_points": total_points,
                "games_played": int(entry.get("games", 0)),
            })

        offense_points = [p["total_points"] for p in players_to_import]
        min_pts, max_pts = (min(offense_points), max(offense_points)) if offense_points else (0, 1)

        print(f"\nImporting {len(players_to_import)} offensive players...")
        with conn.cursor() as cur:
            for p in players_to_import:
                team_id = team_id_by_name.get(p["team_name"])
                cur.execute(
                    "select id from players where full_name = %s and position = %s",
                    (p["name"], p["position"]),
                )
                row = cur.fetchone()
                if row:
                    player_id = row[0]
                    cur.execute("update players set team_id = %s where id = %s", (team_id, player_id))
                else:
                    cur.execute(
                        "insert into players (full_name, team_id, position) values (%s, %s, %s) returning id",
                        (p["name"], team_id, p["position"]),
                    )
                    player_id = cur.fetchone()[0]

                price = price_from_points(p["total_points"], min_pts, max_pts)
                cur.execute(
                    """
                    insert into game_players (game_id, player_id, external_id, position_code, price, is_active)
                    values (%s, %s, %s, %s, %s, true)
                    on conflict (game_id, external_id) do update set price = excluded.price, is_active = true
                    returning id
                    """,
                    (game_id, player_id, f"espn-{p['athlete_id']}", p["position"], price),
                )
                game_player_id = cur.fetchone()[0]

                s = p["stats"]
                cur.execute(
                    """
                    insert into nfl_game_player_stats (
                        game_player_id, season, gameweek, pass_yards, pass_tds, pass_ints,
                        rush_yards, rush_tds, receptions, rec_yards, rec_tds, fumbles_lost, total_points,
                        games_played
                    ) values (%s, %s, null, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    on conflict (game_player_id, season) where gameweek is null do update set
                        pass_yards = excluded.pass_yards, pass_tds = excluded.pass_tds,
                        pass_ints = excluded.pass_ints, rush_yards = excluded.rush_yards,
                        rush_tds = excluded.rush_tds, receptions = excluded.receptions,
                        rec_yards = excluded.rec_yards, rec_tds = excluded.rec_tds,
                        fumbles_lost = excluded.fumbles_lost, total_points = excluded.total_points,
                        games_played = excluded.games_played
                    """,
                    (
                        game_player_id, SEASON, s["pass_yards"], s["pass_tds"], s["pass_ints"],
                        s["rush_yards"], s["rush_tds"], s["receptions"], s["rec_yards"], s["rec_tds"],
                        s["fumbles_lost"], round(p["total_points"], 2), p["games_played"],
                    ),
                )
        conn.commit()
        print("Offensive players committed.")

        print(f"\nImporting {len(defense)} DST units...")
        dst_totals = {}
        with conn.cursor() as cur:
            for abbrev, stats in defense.items():
                canonical_team = ESPN_TEAM_TO_CANONICAL.get(abbrev)
                if not canonical_team:
                    continue
                games_played = 17  # NFL regular season length
                total_points = score_dst(rules, stats, games_played)
                dst_totals[abbrev] = total_points
            min_dst, max_dst = (min(dst_totals.values()), max(dst_totals.values())) if dst_totals else (0, 1)

            for abbrev, stats in defense.items():
                canonical_team = ESPN_TEAM_TO_CANONICAL.get(abbrev)
                if not canonical_team:
                    continue
                team_id = team_id_by_name.get(canonical_team)
                dst_name = f"{canonical_team} Defense"
                cur.execute("select id from players where full_name = %s and position = 'DST'", (dst_name,))
                row = cur.fetchone()
                if row:
                    player_id = row[0]
                else:
                    cur.execute(
                        "insert into players (full_name, team_id, position) values (%s, %s, 'DST') returning id",
                        (dst_name, team_id),
                    )
                    player_id = cur.fetchone()[0]

                total_points = dst_totals[abbrev]
                games_played = 17  # NFL regular season length
                price = price_from_points(total_points, min_dst, max_dst, min_price=4.0, max_price=14.0)
                cur.execute(
                    """
                    insert into game_players (game_id, player_id, external_id, position_code, price, is_active)
                    values (%s, %s, %s, 'DST', %s, true)
                    on conflict (game_id, external_id) do update set price = excluded.price, is_active = true
                    returning id
                    """,
                    (game_id, player_id, f"espn-dst-{abbrev}", price),
                )
                game_player_id = cur.fetchone()[0]

                cur.execute(
                    """
                    insert into nfl_game_player_stats (
                        game_player_id, season, gameweek, def_sacks, def_interceptions,
                        points_allowed, total_points, games_played
                    ) values (%s, %s, null, %s, %s, %s, %s, %s)
                    on conflict (game_player_id, season) where gameweek is null do update set
                        def_sacks = excluded.def_sacks, def_interceptions = excluded.def_interceptions,
                        points_allowed = excluded.points_allowed, total_points = excluded.total_points,
                        games_played = excluded.games_played
                    """,
                    (
                        game_player_id, SEASON, stats.get("def_sacks", 0), stats.get("def_interceptions", 0),
                        int(stats.get("points_allowed", 0)), round(total_points, 2), games_played,
                    ),
                )
        conn.commit()
        print("DST units committed.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
