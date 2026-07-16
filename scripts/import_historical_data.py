"""
import_historical_data.py
--------------------------
Loads last season's Dream Team + FanTeam player CSVs into Supabase,
using the matching logic from match_players.py to link the same
real-world player across both games into one canonical `players` row.

Season-total snapshots (this data) are stored with gameweek = 0.
Real gameweek-by-gameweek scraping (once each season is live) will use
gameweek = 1, 2, 3... - 0 is reserved specifically for "season aggregate".

Safe to re-run: every insert is an upsert keyed on the same natural key
(game + external_id for game_players, game_player_id + season + gameweek
for stats), so running this twice updates rather than duplicates.

RUN:
    python3 scripts/import_historical_data.py "path/to/dreamteam.csv" "path/to/fanteam.csv"
"""

import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

sys.path.insert(0, str(Path(__file__).resolve().parent))
from match_players import CANONICAL_TEAMS, load_dreamteam, load_fanteam, match  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
SEASON = "2025/26"
SEASON_TOTAL_GAMEWEEK = 0

# CSV column -> typed game_player_stats column, per game.
# Everything else in the row goes into raw_stats as jsonb.
DT_STAT_MAP = {
    "minutesPlayed": "minutes_played",
    "goals": "goals",
    "assists": "assists",
    "cleanSheet": "clean_sheets",
    "saves": "saves",
    "goalsConceded": "goals_conceded",
    "yellowCards": "yellow_cards",
    "redCards": "red_cards",
    "totalPoints": "total_points",
}
FT_STAT_MAP = {
    "minutesPlayed": "minutes_played",
    "goals": "goals",
    "assists": "assists",
    "fullCleanSheets": "clean_sheets",
    "saves": "saves",
    "goalsConceded": "goals_conceded",
    "yellowCards": "yellow_cards",
    "redCards": "red_cards",
    "totalPoints": "total_points",
}
# Columns identity/price info already lives elsewhere - don't duplicate into raw_stats.
COMMON_EXCLUDE = {"playerId", "displayName", "squadName", "position", "price"}


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def to_number(value: str):
    try:
        if "." in value:
            return float(value)
        return int(value)
    except (TypeError, ValueError):
        return value


def build_stats_row(raw: dict, stat_map: dict):
    typed = {col: to_number(raw[csv_key]) for csv_key, col in stat_map.items()}
    mapped_csv_keys = set(stat_map) | COMMON_EXCLUDE
    raw_stats = {k: to_number(v) for k, v in raw.items() if k not in mapped_csv_keys}
    return typed, raw_stats


def upsert_team(cur, name):
    cur.execute(
        """
        insert into teams (name) values (%s)
        on conflict (name) do update set name = excluded.name
        returning id
        """,
        (name,),
    )
    return cur.fetchone()[0]


def upsert_team_alias(cur, team_id, source, external_name):
    cur.execute(
        """
        insert into team_aliases (team_id, source, external_name) values (%s, %s, %s)
        on conflict (source, external_name) do update set team_id = excluded.team_id
        """,
        (team_id, source, external_name),
    )


def upsert_game(cur, slug, display_name):
    cur.execute(
        """
        insert into fantasy_games (slug, display_name) values (%s, %s)
        on conflict (slug) do update set display_name = excluded.display_name
        returning id
        """,
        (slug, display_name),
    )
    return cur.fetchone()[0]


def find_existing_player_id(cur, game_id, external_id):
    cur.execute(
        "select player_id from game_players where game_id = %s and external_id = %s",
        (game_id, external_id),
    )
    row = cur.fetchone()
    return row[0] if row else None


def insert_player(cur, full_name, team_id, position):
    cur.execute(
        "insert into players (full_name, team_id, position) values (%s, %s, %s) returning id",
        (full_name, team_id, position),
    )
    return cur.fetchone()[0]


def upsert_game_player(cur, game_id, player_id, external_id, position_raw, price):
    cur.execute(
        """
        insert into game_players (game_id, player_id, external_id, position_code, price)
        values (%s, %s, %s, %s, %s)
        on conflict (game_id, external_id) do update
            set player_id = excluded.player_id,
                position_code = excluded.position_code,
                price = excluded.price,
                updated_at = now()
        returning id
        """,
        (game_id, player_id, external_id, position_raw, price),
    )
    return cur.fetchone()[0]


def upsert_stats(cur, game_player_id, typed, raw_stats):
    cur.execute(
        """
        insert into game_player_stats
            (game_player_id, season, gameweek, minutes_played, goals, assists,
             clean_sheets, saves, goals_conceded, yellow_cards, red_cards,
             total_points, raw_stats)
        values (%(game_player_id)s, %(season)s, %(gameweek)s, %(minutes_played)s,
                %(goals)s, %(assists)s, %(clean_sheets)s, %(saves)s,
                %(goals_conceded)s, %(yellow_cards)s, %(red_cards)s,
                %(total_points)s, %(raw_stats)s)
        on conflict (game_player_id, season, gameweek) do update
            set minutes_played = excluded.minutes_played,
                goals = excluded.goals,
                assists = excluded.assists,
                clean_sheets = excluded.clean_sheets,
                saves = excluded.saves,
                goals_conceded = excluded.goals_conceded,
                yellow_cards = excluded.yellow_cards,
                red_cards = excluded.red_cards,
                total_points = excluded.total_points,
                raw_stats = excluded.raw_stats
        """,
        {
            "game_player_id": game_player_id,
            "season": SEASON,
            "gameweek": SEASON_TOTAL_GAMEWEEK,
            "raw_stats": psycopg2.extras.Json(raw_stats),
            **typed,
        },
    )


def import_side(cur, game_id, source, row, team_lookup, player_id, stat_map):
    game_player_id = upsert_game_player(
        cur, game_id, player_id, row["external_id"], row["position_raw"], row["price"]
    )
    typed, raw_stats = build_stats_row(row["raw"], stat_map)
    upsert_stats(cur, game_player_id, typed, raw_stats)


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 import_historical_data.py <dreamteam.csv> <fanteam.csv>")
        sys.exit(1)

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        team_lookup = {}
        for canon, dt_name, ft_name in CANONICAL_TEAMS:
            team_id = upsert_team(cur, canon)
            upsert_team_alias(cur, team_id, "dreamteam", dt_name)
            upsert_team_alias(cur, team_id, "fanteam", ft_name)
            team_lookup[canon] = team_id

        dreamteam_game_id = upsert_game(cur, "dreamteam", "Dream Team")
        fanteam_game_id = upsert_game(cur, "fanteam", "FanTeam")

        dt_rows = load_dreamteam(sys.argv[1])
        ft_rows = load_fanteam(sys.argv[2])
        matched, dt_only, ft_only, ambiguous = match(dt_rows, ft_rows)

        if ambiguous:
            print(f"[warn] {len(ambiguous)} ambiguous matches skipped - see match_players.py output")

        for dt, ft in matched:
            player_id = find_existing_player_id(cur, dreamteam_game_id, dt["external_id"])
            if player_id is None:
                player_id = find_existing_player_id(cur, fanteam_game_id, ft["external_id"])
            if player_id is None:
                player_id = insert_player(cur, ft["display_name"], team_lookup[ft["team"]], ft["position"])
            import_side(cur, dreamteam_game_id, "dreamteam", dt, team_lookup, player_id, DT_STAT_MAP)
            import_side(cur, fanteam_game_id, "fanteam", ft, team_lookup, player_id, FT_STAT_MAP)

        for dt in dt_only:
            player_id = find_existing_player_id(cur, dreamteam_game_id, dt["external_id"])
            if player_id is None:
                player_id = insert_player(cur, dt["display_name"], team_lookup[dt["team"]], dt["position"])
            import_side(cur, dreamteam_game_id, "dreamteam", dt, team_lookup, player_id, DT_STAT_MAP)

        for ft in ft_only:
            player_id = find_existing_player_id(cur, fanteam_game_id, ft["external_id"])
            if player_id is None:
                player_id = insert_player(cur, ft["display_name"], team_lookup[ft["team"]], ft["position"])
            import_side(cur, fanteam_game_id, "fanteam", ft, team_lookup, player_id, FT_STAT_MAP)

        conn.commit()
        print(f"Imported {len(matched)} matched, {len(dt_only)} dreamteam-only, {len(ft_only)} fanteam-only players.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
