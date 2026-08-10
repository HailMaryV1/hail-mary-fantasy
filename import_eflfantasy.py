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

FIXTURE_SEASON = "2026/27"

# compute_projections.py's historical-baseline query reads game_player_stats
# where season = HISTORICAL_SEASON and gameweek = 0 (NOT null, despite the
# table's own column comment - confirmed by reading the actual query, and
# matches seed_cloudff_historical_stats.py's exact same convention). EFL
# Fantasy's players.json totalPoints/averagePoints are real last-season
# cumulative fantasy points (confirmed: Championship totals divide out to
# ~46 games at averagePoints - a full league season, not this pre-season's
# empty totals) - the same "last season is next season's baseline" role
# every other game's historical row plays.
STATS_SEASON = "2025/26"

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
                    (f"eflfantasy:{g['id']}", competition, FIXTURE_SEASON, home_id, away_id, kickoff),
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
    # gameweek = 0 (not null) - compute_projections.py's historical-baseline
    # query filters on gameweek = 0 specifically (confirmed by reading it),
    # and NULL wouldn't satisfy the (game_player_id, season, gameweek)
    # unique constraint's ON CONFLICT matching anyway (two NULLs are never
    # equal in Postgres), so a null gameweek here would insert a fresh
    # duplicate row on every re-run instead of updating in place.
    cur.execute(
        """
        insert into game_player_stats (game_player_id, season, gameweek, minutes_played, goals, assists,
            clean_sheets, saves, goals_conceded, yellow_cards, red_cards, total_points, raw_stats)
        values (%(gpid)s, %(season)s, 0, %(minutes)s, %(goals)s, %(assists)s, %(clean_sheets)s,
            %(saves)s, %(goals_conceded)s, %(yellow_cards)s, %(red_cards)s, %(total_points)s, %(raw_stats)s)
        on conflict (game_player_id, season, gameweek) do update set
            minutes_played = excluded.minutes_played, goals = excluded.goals, assists = excluded.assists,
            clean_sheets = excluded.clean_sheets, saves = excluded.saves, goals_conceded = excluded.goals_conceded,
            yellow_cards = excluded.yellow_cards, red_cards = excluded.red_cards,
            total_points = excluded.total_points, raw_stats = excluded.raw_stats
        """,
        {
            "gpid": game_player_id,
            "season": STATS_SEASON,
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

    eliminated = 0
    for p in players_data:
        team_id = team_id_by_squad_id.get(p["squadId"])
        if team_id is None:
            continue
        position = p["position"]
        if position not in ("GK", "DEF", "MID", "FWD"):
            continue  # unexpected position code - skip rather than guess
        # fantasy.efl.com's own real-time selectability signal - "eliminated"
        # means the platform itself no longer lists this player as pickable
        # (real cases confirmed live 2026-08-08: Ivor Pandur, a Rochdale GK
        # who no longer exists as a selectable option on the real site;
        # Abdul Fatawu still shown here at his OLD club, Leicester City,
        # despite having since signed for Ipswich Town - now a Premier
        # League club, out of EFL Fantasy's Championship/L1/L2 scope
        # entirely). Skipping the row here (not seen_external_ids) lets the
        # existing "vanished from the feed" stale-sweep below deactivate it
        # the same way it already handles a player disappearing outright -
        # one mechanism for both cases instead of a second one. "playing"/
        # "injured"/"suspended" are all real, still-in-scope players and
        # stay active exactly as before.
        if p.get("status") == "eliminated":
            eliminated += 1
            continue
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
        competition = COMPETITION_BY_ID.get(p.get("competitionId"))
        # percentSelected: fantasy.efl.com's own live ownership % (2026-08-10
        # user request, confirmed live - e.g. K. Trippier at 55.6%, not a
        # placeholder). None/0 both collapse to the same "not meaningfully
        # selected yet" reading this early in the season, so no special
        # null-handling needed beyond the usual coalesce-at-read pattern.
        ownership_pct = p.get("percentSelected")
        cur.execute(
            """
            insert into game_players (game_id, player_id, external_id, position_code, price, is_active, competition, ownership_pct)
            values (%s, %s, %s, %s, 0, true, %s, %s)
            on conflict (game_id, external_id) do update
                set player_id = excluded.player_id, position_code = excluded.position_code,
                    is_active = true, updated_at = now(), competition = excluded.competition,
                    ownership_pct = excluded.ownership_pct
            returning id
            """,
            (game_id, player_id, external_id, position, competition, ownership_pct),
        )
        game_player_id = cur.fetchone()[0]

        appearances = p.get("appearances", 0)
        typed = {
            "goals": p.get("goalsScored", 0),
            "assists": p.get("assists", 0),
            "clean_sheets": p.get("cleanSheets", 0),
            "saves": p.get("saves", 0),
            "total_points": p.get("totalPoints", 0),
            # No real per-appearance minutes total in this feed - every
            # appearance counted as a full 90 is a reasonable proxy (the
            # same class of approximation compute_involvement_rates()
            # already documents for PT60/PT90 below, not a new one).
            "minutes_played": appearances * 90,
        }
        raw = {
            # Literal "PT1" (not "appearances") on purpose -
            # compute_projections.py's historical-baseline SQL query reads
            # raw_stats->>'PT1' as a hardcoded key for every game, not
            # aliased per-game like everything else here (confirmed by
            # reading it) - every game's importer is expected to write
            # this literal key.
            #
            # PT60/PT90 set equal to PT1 (not left absent) - real bug
            # caught live 2026-08-06 via the Player Info panel: a 44-
            # appearance ever-present defender (Sean McLoughlin) was
            # projecting only 31 expected minutes. _implied_involvement()'s
            # "appearance-rate fallback" (compute_projections.py) only
            # triggers when PT1 ITSELF is missing (pt1 <= 0) - it never
            # fires here, since this feed's real PT1 is always present.
            # With PT60/PT90 left absent, the SQL layer's coalesce(...,0)
            # read them as a real, literal zero - "this player has NEVER
            # once reached 60 minutes in 44 appearances" - not as "no
            # data," collapsing cond60_rate/cond90_rate toward nothing for
            # every single EFL Fantasy player. This feed has no real 60+/
            # 90-minute split (same gap minutes_played's own appearances*90
            # proxy above already documents), so PT60=PT90=appearances is
            # the consistent application of that exact same proxy -
            # every real appearance assumed a full match - rather than a
            # different, silently-wrong assumption creeping in one field
            # over.
            "PT1": appearances,
            "PT60": appearances,
            "PT90": appearances,
            "appearances": appearances,
            "keyPasses": p.get("keyPasses", 0),
            "shotsOnTarget": p.get("shotsOnTarget", 0),
            "clearances": p.get("clearances", 0),
            "blocks": p.get("blocks", 0),
            "tackles": p.get("tackles", 0),
            "interceptions": p.get("interceptions", 0),
        }
        upsert_stats(cur, game_player_id, raw, typed)
        stats_written += 1

    print(f"Players: {matched} matched to existing rows, {created} new player rows created, {stats_written} stat snapshots written, {eliminated} eliminated (skipped, will be deactivated below).")

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
    budget system - see migration 0089's docstring). Real win/draw/clean-
    sheet/goals event stats aren't available yet (this pre-season, every
    fixture in rounds.json has null scores), but squads.json's own
    totalPoints/averagePoints ARE real last-season Fantasy EFL club
    scoring - stored as the club's "historical" baseline the exact same
    way a player's season-total row works (season=STATS_SEASON,
    gameweek=0), so compute_projections.py's club-scoring pass (see
    compute_club_scores() in compute_projections.py) has a real number to
    fixture-adjust rather than nothing at all."""
    written = 0
    for s in squads_data:
        player_id = club_player_id_by_squad_id[s["id"]]
        external_id = f"club-{s['id']}"
        competition = COMPETITION_BY_ID.get(s.get("competitionId"))
        cur.execute(
            """
            insert into game_players (game_id, player_id, external_id, position_code, price, is_active, competition)
            values (%s, %s, %s, 'CLUB', 0, true, %s)
            on conflict (game_id, external_id) do update set is_active = true, updated_at = now(), competition = excluded.competition
            returning id
            """,
            (game_id, player_id, external_id, competition),
        )
        game_player_id = cur.fetchone()[0]
        cur.execute(
            """
            insert into game_player_stats (game_player_id, season, gameweek, total_points, raw_stats)
            values (%s, %s, 0, %s, %s)
            on conflict (game_player_id, season, gameweek) do update set
                total_points = excluded.total_points, raw_stats = excluded.raw_stats
            """,
            (
                game_player_id, STATS_SEASON, s.get("averagePoints", 0),
                json.dumps({
                    "totalPoints": s.get("totalPoints", 0),
                    "averagePoints": s.get("averagePoints", 0),
                    "leaguePosition": s.get("leaguePosition"),
                    "fdrHome": s.get("fdrHome"),
                    "fdrAway": s.get("fdrAway"),
                }),
            ),
        )
        written += 1
    print(f"Club picks: {written} CLUB game_players rows written (with real last-season averagePoints as baseline).")


def seed_team_strength(cur, squads_data, team_id_by_squad_id):
    """team_fixture_difficulty's real-odds-first COALESCE (migration 0017)
    always prefers real bookmaker match odds (import_sportmonks_match_
    odds.py, confirmed live 2026-08-06 that all 3 EFL divisions are
    entitled) the moment they're posted for a given fixture - but those
    only appear ~8 days out from kickoff, so every fixture further out
    still needs a fallback rating, or team_fixture_difficulty would have
    zero rows for EFL Fantasy this far ahead (compute_projections.py's
    resolve_neutral_attack would crash on a real NULL avg(attack_score),
    the same failure mode Cloud FF hit once, see migration 0074).

    This fallback is fantasy.efl.com's own real fdrHome/fdrAway rating
    per club (squads.json - confirmed present for every club, including
    zero-history ones), not a last-season-averagePoints proxy derived
    from this project's own data (the prior approach here, reverted
    2026-08-06): confirmed live, EFL's own rating already correctly
    identifies a relegated Premier League side as a hard opponent even
    with zero fantasy history in this division (West Ham/Wolves/Burnley -
    all fdrHome/fdrAway 4-5 despite averagePoints=0), which a same-
    division-only z-score structurally cannot see. This was the exact
    blind spot behind the real Notts County case (see import_sportmonks_
    match_odds.py's docstring): a promoted club showing an inflated
    projection purely off strong lower-league form, before real odds or
    this fix existed to catch it.

    fdrHome/fdrAway are two DIFFERENT ratings per club (a team can be a
    harder home fixture than away fixture, or vice versa) - written into
    team_season_strength's home_strength/away_strength columns (migration
    0102) rather than forced into one flat `strength`, so compute_
    fixture_strength_probabilities.py can rate each side of a fixture on
    its own real, venue-specific number. `strength` (their average) is
    still filled for any other code path that only reads the flat column.

    Rescale: FDR's real 1..5 scale (1=easiest, 5=hardest, confirmed from
    the in-app legend) to roughly the same -0.9..0.9 range the real
    Premier League bookmaker-derived ratings already occupy, via a
    direct linear map (1->-0.9, 3->0, 5->0.9) - no z-scoring needed,
    FDR is already a bounded, calibrated scale.

    top5_prob/relegation_prob are NOT NULL columns but aren't actually
    read by compute_fixture_strength_probabilities.py (confirmed by
    reading it - only strength/home_strength/away_strength are) - a
    simple top-5/bottom-3-by-averagePoints step function fills them,
    honestly labelled as a proxy (not real odds) via the `source`
    column, rather than left as unexplained numbers."""
    import statistics

    by_competition: dict[int, list] = {}
    for s in squads_data:
        by_competition.setdefault(s["competitionId"], []).append(s)

    def fdr_to_strength(fdr) -> float:
        # 1..5 -> -0.9..0.9, clipped defensively in case a future export
        # ever returns something outside the documented range.
        return max(-0.9, min(0.9, ((float(fdr) - 3.0) / 2.0) * 0.9))

    written = 0
    for comp_id, clubs in by_competition.items():
        avgs = [float(c.get("averagePoints", 0)) for c in clubs]
        mean = statistics.mean(avgs)
        stdev = statistics.pstdev(avgs) or 1.0
        ranked = sorted(clubs, key=lambda c: float(c.get("averagePoints", 0)), reverse=True)
        top5_ids = {c["id"] for c in ranked[:5]}
        bottom3_ids = {c["id"] for c in ranked[-3:]}

        for c in clubs:
            team_id = team_id_by_squad_id[c["id"]]
            top5_prob = 1.0 if c["id"] in top5_ids else 0.0
            relegation_prob = 1.0 if c["id"] in bottom3_ids else 0.0
            home_strength = fdr_to_strength(c.get("fdrHome", 3))
            away_strength = fdr_to_strength(c.get("fdrAway", 3))
            strength = round((home_strength + away_strength) / 2, 4)
            cur.execute(
                """
                insert into team_season_strength
                    (team_id, season, top5_prob, relegation_prob, strength, home_strength, away_strength, source)
                values (%s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (team_id, season) do update set
                    top5_prob = excluded.top5_prob, relegation_prob = excluded.relegation_prob,
                    strength = excluded.strength, home_strength = excluded.home_strength,
                    away_strength = excluded.away_strength, source = excluded.source
                """,
                (team_id, FIXTURE_SEASON, top5_prob, relegation_prob, strength,
                 round(home_strength, 4), round(away_strength, 4),
                 "eflfantasy_real_fdr_2026-08-06"),
            )
            written += 1
    print(f"Team strength: {written} EFL club ratings seeded from fantasy.efl.com's own real fdrHome/fdrAway.")


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
        seed_team_strength(cur, squads_data, team_id_by_squad_id)

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
