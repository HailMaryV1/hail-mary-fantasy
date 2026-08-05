"""
import_eflfantasy.py
----------------------
Loads live EFL Fantasy data (scraper_eflfantasy.py output) into Supabase.

Unlike Cloud FF/FanTeam's importers (which only ever MATCH existing
players - Championship/League One/League Two are almost entirely new
territory for this database, they don't already exist from an earlier
Premier League seed), this one CREATES a new `players`/`teams` row on a
genuine miss rather than skipping it - closer to how the very first
Dream Team/FanTeam seed import worked. Many EFL clubs (Barnsley, Cardiff
City, Hull City, ...) already exist here from FA Cup/Carabao Cup opponent
imports (SportMonks entitles those competitions - see migration 0087's
docstring), so teams are matched by exact canonical name first and only
created on a genuine miss.

Player matching is exact, not fuzzy: fantasy.efl.com's players.json gives
real, separate firstName/lastName fields (unlike FanTeam's mononym
problem or Cloud FF's surname-only field) - matched by
(compact(full_name), team_id), created on a miss.

CLUB picks (see migration 0087's docstring) are synthesized one per real
EFL club - position='CLUB', full_name="{Club} Team" - following the exact
same synthetic-player template already shipped for NFL's DST units
(scripts/import_nfl_historical_stats.py). Club match-result stats
(win/draw/away-win/clean-sheet/goals) are derived here from rounds.json's
real fixture results and stored the same way individual player stats are
- game_player_stats.raw_stats, not a parallel table - since they fit the
existing shared shape (one row per game_player per season/gameweek)
without needing NFL DST's dedicated table (that was needed there for
NFL-specific typed columns like sacks/points-allowed that don't fit
soccer's schema at all; win/draw/clean-sheet/goals do).

Safe to re-run: everything is upserted (teams/players by name+team,
game_players by (game_id, external_id), fixtures by (home,away,kickoff),
game_player_stats by (game_player_id, season, gameweek)).

RUN:
    python3 import_eflfantasy.py
"""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "scripts"))
from activity_log import log_event  # noqa: E402
from name_matching import compact  # noqa: E402

SEASON = "2026/27"

COMPETITION_BY_ID = {10: "efl_championship", 11: "efl_league_one", 12: "efl_league_two"}


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


def resolve_or_create_team(cur, name: str) -> int:
    cur.execute("select id from teams where name = %s", (name,))
    row = cur.fetchone()
    if row:
        return row[0]
    cur.execute("insert into teams (name) values (%s) returning id", (name,))
    return cur.fetchone()[0]


def import_clubs(cur, squads_data):
    """Real teams.id for every EFL club, plus one synthetic CLUB
    `players` row per club for the "pick a club" squad slot."""
    team_id_by_squad_id = {}
    club_player_id_by_squad_id = {}
    created_teams, created_clubs = 0, 0

    for s in squads_data:
        team_id = resolve_or_create_team(cur, s["name"])
        team_id_by_squad_id[s["id"]] = team_id

        club_name = f"{s['name']} Team"
        cur.execute("select id from players where full_name = %s and position = 'CLUB'", (club_name,))
        row = cur.fetchone()
        if row:
            player_id = row[0]
        else:
            cur.execute(
                "insert into players (full_name, team_id, position) values (%s, %s, 'CLUB') returning id",
                (club_name, team_id),
            )
            player_id = cur.fetchone()[0]
            created_clubs += 1
        club_player_id_by_squad_id[s["id"]] = player_id

    print(f"Clubs: {len(squads_data)} real EFL clubs resolved ({created_clubs} new CLUB player rows created).")
    return team_id_by_squad_id, club_player_id_by_squad_id


def import_fixtures(cur, game_id, rounds_data, team_id_by_squad_id):
    written, created, matched = 0, 0, 0
    for round_row in rounds_data:
        gameweek = round_row["roundNumber"]
        for g in round_row.get("games", []):
            home_id = team_id_by_squad_id.get(g["homeId"])
            away_id = team_id_by_squad_id.get(g["awayId"])
            if home_id is None or away_id is None:
                continue  # a club not in squads.json - shouldn't happen, but never guess
            kickoff = datetime.fromisoformat(g["date"])
            competition = COMPETITION_BY_ID.get(g["competitionId"])
            if competition is None:
                continue

            cur.execute(
                "select id from fixtures where home_team_id = %s and away_team_id = %s and kickoff_at = %s",
                (home_id, away_id, kickoff),
            )
            row = cur.fetchone()
            if row:
                fixture_id = row[0]
                matched += 1
            else:
                cur.execute(
                    """
                    insert into fixtures (external_id, competition, season, home_team_id, away_team_id, kickoff_at)
                    values (%s, %s, %s, %s, %s, %s)
                    on conflict (external_id) do update set home_team_id = excluded.home_team_id
                    returning id
                    """,
                    (f"eflfantasy:{g['id']}", competition, SEASON, home_id, away_id, kickoff),
                )
                fixture_id = cur.fetchone()[0]
                created += 1

            cur.execute(
                """
                insert into game_fixture_gameweeks (game_id, fixture_id, gameweek)
                values (%s, %s, %s)
                on conflict (game_id, fixture_id) do update set gameweek = excluded.gameweek
                """,
                (game_id, fixture_id, gameweek),
            )
            written += 1

    print(f"Fixtures: {written} gameweek mappings written ({matched} matched existing, {created} newly created).")


def upsert_stats(cur, game_player_id, season_total: dict, typed: dict):
    cur.execute(
        """
        insert into game_player_stats (game_player_id, season, gameweek, minutes_played, goals, assists,
            clean_sheets, saves, goals_conceded, yellow_cards, red_cards, total_points, raw_stats)
        values (%(gpid)s, %(season)s, null, %(minutes)s, %(goals)s, %(assists)s, %(clean_sheets)s,
            %(saves)s, %(goals_conceded)s, %(yellow_cards)s, %(red_cards)s, %(total_points)s, %(raw_stats)s)
        on conflict (game_player_id, season, gameweek) do update set
            minutes_played = excluded.minutes_played, goals = excluded.goals, assists = excluded.assists,
            clean_sheets = excluded.clean_sheets, saves = excluded.saves, goals_conceded = excluded.goals_conceded,
            yellow_cards = excluded.yellow_cards, red_cards = excluded.red_cards,
            total_points = excluded.total_points, raw_stats = excluded.raw_stats
        """,
        {
            "gpid": game_player_id,
            "season": SEASON,
            "minutes": typed.get("minutes_played", 0),
            "goals": typed.get("goals", 0),
            "assists": typed.get("assists", 0),
            "clean_sheets": typed.get("clean_sheets", 0),
            "saves": typed.get("saves", 0),
            "goals_conceded": typed.get("goals_conceded", 0),
            "yellow_cards": typed.get("yellow_cards", 0),
            "red_cards": typed.get("red_cards", 0),
            "total_points": typed.get("total_points", 0),
            "raw_stats": json.dumps(season_total),
        },
    )


def import_players(cur, game_id, players_data, team_id_by_squad_id):
    cur.execute("select id, full_name, team_id from players where position in ('GK','DEF','MID','FWD')")
    by_team: dict[int, dict[str, int]] = {}
    for pid, full_name, team_id in cur.fetchall():
        by_team.setdefault(team_id, {})[compact(full_name)] = pid

    matched, created, stats_written = 0, 0, 0
    seen_external_ids = set()

    for p in players_data:
        team_id = team_id_by_squad_id.get(p["squadId"])
        if team_id is None:
            continue
        position = p["position"]
        if position not in ("GK", "DEF", "MID", "FWD"):
            continue  # unexpected position code - skip rather than guess
        full_name = f"{p['firstName']} {p['lastName']}".strip()
        key = compact(full_name)

        player_id = by_team.get(team_id, {}).get(key)
        if player_id:
            matched += 1
        else:
            cur.execute(
                "insert into players (full_name, team_id, position) values (%s, %s, %s) returning id",
                (full_name, team_id, position),
            )
            player_id = cur.fetchone()[0]
            by_team.setdefault(team_id, {})[key] = player_id
            created += 1
            log_event(
                cur, "player_added", f"{full_name} added to EFL Fantasy ({position})",
                game_id=game_id, details={"player_id": player_id, "position": position, "team_id": team_id},
            )

        external_id = str(p["id"])
        seen_external_ids.add(external_id)
        cur.execute(
            """
            insert into game_players (game_id, player_id, external_id, position_code, price, is_active)
            values (%s, %s, %s, %s, 0, true)
            on conflict (game_id, external_id) do update
                set player_id = excluded.player_id, position_code = excluded.position_code,
                    is_active = true, updated_at = now()
            returning id
            """,
            (game_id, player_id, external_id, position),
        )
        game_player_id = cur.fetchone()[0]

        typed = {
            "goals": p.get("goalsScored", 0),
            "assists": p.get("assists", 0),
            "clean_sheets": p.get("cleanSheets", 0),
            "saves": p.get("saves", 0),
            "total_points": p.get("totalPoints", 0),
        }
        raw = {
            "appearances": p.get("appearances", 0),
            "keyPasses": p.get("keyPasses", 0),
            "shotsOnTarget": p.get("shotsOnTarget", 0),
            "clearances": p.get("clearances", 0),
            "blocks": p.get("blocks", 0),
            "tackles": p.get("tackles", 0),
            "interceptions": p.get("interceptions", 0),
        }
        upsert_stats(cur, game_player_id, raw, typed)
        stats_written += 1

    print(f"Players: {matched} matched to existing rows, {created} new player rows created, {stats_written} stat snapshots written.")

    # Scoped to position_code != 'CLUB' - CLUB rows are a completely
    # separate set written by import_club_game_players, never present in
    # players_data/seen_external_ids, and would otherwise get incorrectly
    # swept up as "stale" here (confirmed live - this bug shipped once).
    cur.execute(
        "select external_id from game_players where game_id = %s and is_active = true and position_code != 'CLUB'",
        (game_id,),
    )
    currently_active = {row[0] for row in cur.fetchall()}
    stale_ids = currently_active - seen_external_ids
    if stale_ids:
        cur.execute(
            "update game_players set is_active = false, updated_at = now() where game_id = %s and external_id = any(%s)",
            (game_id, list(stale_ids)),
        )
        print(f"Deactivated {len(stale_ids)} players no longer in EFL Fantasy's live list.")


def import_club_game_players(cur, game_id, squads_data, club_player_id_by_squad_id):
    """CLUB game_players rows - one per real EFL club, price 0 (no
    budget system - see migration 0089's docstring). Match-result stats
    (win/draw/clean-sheet/goals) aren't computed here from the season
    totals endpoint (squads.json is a snapshot, not per-fixture results)
    - left for Stage 3's compute_projections.py wiring to derive directly
    from rounds.json's real fixture results instead."""
    written = 0
    for s in squads_data:
        player_id = club_player_id_by_squad_id[s["id"]]
        external_id = f"club-{s['id']}"
        cur.execute(
            """
            insert into game_players (game_id, player_id, external_id, position_code, price, is_active)
            values (%s, %s, %s, 'CLUB', 0, true)
            on conflict (game_id, external_id) do update set is_active = true, updated_at = now()
            """,
            (game_id, player_id, external_id),
        )
        written += 1
    print(f"Club picks: {written} CLUB game_players rows written.")


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select id from fantasy_games where slug = 'eflfantasy'")
        row = cur.fetchone()
        if not row:
            raise SystemExit("No fantasy_games row for slug='eflfantasy' - run migration 0086 first.")
        game_id = row[0]

        competitions_data = json.loads((ROOT / "eflfantasy_competitions_raw.json").read_text(encoding="utf-8"))
        squads_data = json.loads((ROOT / "eflfantasy_squads_raw.json").read_text(encoding="utf-8"))
        players_data = json.loads((ROOT / "eflfantasy_players_raw.json").read_text(encoding="utf-8"))
        rounds_data = json.loads((ROOT / "eflfantasy_rounds_raw.json").read_text(encoding="utf-8"))
        print(f"Loaded {len(competitions_data)} competitions, {len(squads_data)} squads, "
              f"{len(players_data)} players, {len(rounds_data)} rounds from raw JSON.")

        team_id_by_squad_id, club_player_id_by_squad_id = import_clubs(cur, squads_data)
        import_club_game_players(cur, game_id, squads_data, club_player_id_by_squad_id)
        import_fixtures(cur, game_id, rounds_data, team_id_by_squad_id)
        import_players(cur, game_id, players_data, team_id_by_squad_id)

        conn.commit()
        print("\nDone.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
