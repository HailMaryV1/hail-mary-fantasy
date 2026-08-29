"""
import_dreamteamtonic_market_odds.py
---------------------------------------
Real bookmaker (Spreadex) match and player odds via DreamTeamTonic's own
"Market Odds" tool (2026-08-29 user request - "we can pull all the odds
etc from tonic... i can rid myself of the sportmonks subscription").

Confirmed live, from inside a paid DTT account, that the tool's own
backing API (dtt-data-api-...run.app/spreadex/*) requires ZERO auth -
every endpoint below returns full real data with `credentials: 'omit'`,
the exact same "public JSON API sitting behind an unlisted paywalled UI
page" shape this project already relies on for player stats
(overall-stats-by-gw-extra) and the fixture ticker. No login, cookie, or
token handling needed here - same as those two.

What this replaces (see import_sportmonks_match_odds.py / import_
sportmonks_player_props.py for the full prior inventory):
  - Real clean sheet probability (SportMonks' Clean Sheet market) - a
    direct drop-in, /spreadex/fixtures gives cleanSheetPercent per team
    per fixture.
  - Real match-winner probability (SportMonks' Fulltime Result market) -
    NOT given directly (Spreadex's own feed has no 1X2 price at all,
    only each team's own expected goals). Derived here via a standard
    independent-Poisson scoreline model from the two teams' real xG -
    arguably a more principled foundation than reverse-engineering a
    vig-included 1X2 price, not a downgrade.
  - Real Anytime Goalscorer / Player to Assist odds (SportMonks' player
    props) - /spreadex/fixture/{id} gives real per-player scorer/assist
    decimal odds. Converted to probability via 1/odds, same fallback
    formula import_sportmonks_player_props.py's own parse_probability()
    already uses when a source has no explicit probability field.

What this does NOT cover (confirmed live 2026-08-29, checked directly
against the real API before writing a line of this script):
  - FA Cup / Carabao Cup - /spreadex/competitions lists zero fixtures for
    either right now (checked: the UI's own filter buttons for these say
    "Not priced up yet"). Per the user, expected to populate closer to
    matchday - not assumed to be a permanent gap, but genuinely absent
    today. SportMonks currently still covers these two.
  - League Two player markets - /spreadex/competitions reports
    hasPlayerMarkets: false for League 2 specifically (team-level xG/
    clean-sheet IS still available there).
  - Player to be Booked / Player Shots On Target - the real fixture
    payload only ever has `scorers`/`assists` arrays, checked directly
    against a live fixture. These two SportMonks markets simply have no
    equivalent here - booking_probability/expected_shots_on_target stay
    whatever import_sportmonks_player_props.py last wrote (or null),
    same "fails safe, never fabricated" posture as every other unwired
    stat in this engine.

Deliberately additive, not a replacement in code: writes into the exact
same fixture_probabilities / fixture_clean_sheet_probabilities /
bookmaker_player_features tables the SportMonks scripts already write,
which all already resolve "latest row wins" per fixture/player - so this
can run alongside SportMonks with zero conflict, for a real side-by-side
comparison before anyone decides to actually cancel that subscription.

Team names come through short-form already ("Bournemouth", not "AFC
Bournemouth") in what's been checked so far, but matched via the same
team_aliases-with-loud-unmatched-report pattern as import_sportmonks_
match_odds.py regardless - never assume a naming gap won't exist just
because today's sample didn't hit one.

RUN:
    python3 scripts/import_dreamteamtonic_market_odds.py
"""

import json
import math
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
SPREADEX_BASE = "https://dtt-data-api-259295136071.europe-west2.run.app/spreadex"
ALIAS_SOURCE = "dreamteamtonic_spreadex"

# Our fixtures.competition string -> Spreadex's own `competition` query
# param value (confirmed live 2026-08-29 via /spreadex/fixtures?competition=...).
# FA Cup/Carabao Cup deliberately excluded - see module docstring, zero
# real fixtures priced there today.
SPREADEX_COMPETITIONS = {
    "soccer_epl": "Premier League",
    "efl_championship": "Championship",
    "efl_league_one": "League 1",
    "efl_league_two": "League 2",
}

LOOKAHEAD_DAYS = 21

# Real gap found live 2026-08-29 on the first run: unlike SportMonks
# (which uses full club names), Spreadex/DTT uses short/colloquial club
# names for EVERY EFL club with a longer official name - confirmed
# systematic, not a one-off, by the first live run's own loud-unmatched
# report (25+ Championship/League One/League Two fixtures, every single
# one a short-name mismatch, zero actual naming disagreements). Keys are
# Spreadex's own short names; values are this project's canonical
# teams.name. Premier League names came through already matching our own
# short-form convention (Bournemouth, Brighton, etc) - no override needed
# there.
TEAM_NAME_OVERRIDES = {
    # Championship
    "Blackburn": "Blackburn Rovers",
    "QPR": "Queens Park Rangers",
    "Bolton": "Bolton Wanderers",
    "Lincoln": "Lincoln City",
    "Cardiff": "Cardiff City",
    "Sheff Utd": "Sheffield United",
    "Charlton": "Charlton Athletic",
    "Preston": "Preston North End",
    "Norwich": "Norwich City",
    "West Ham": "West Ham United",
    "West Brom": "West Bromwich Albion",
    # League One
    "Peterborough": "Peterborough United",
    "Leicester": "Leicester City",
    "Cambridge": "Cambridge United",
    "Huddersfield": "Huddersfield Town",
    "Burton": "Burton Albion",
    "Plymouth": "Plymouth Argyle",
    "Bradford": "Bradford City",
    "Sheff Wed": "Sheffield Wednesday",
    "Doncaster": "Doncaster Rovers",
    "Stockport": "Stockport County",
    "Wycombe": "Wycombe Wanderers",
    "Wimbledon": "AFC Wimbledon",
    "Wigan": "Wigan Athletic",
    "Mansfield": "Mansfield Town",
    "Luton": "Luton Town",
    # League Two
    "Cheltenham": "Cheltenham Town",
    "Crewe": "Crewe Alexandra",
    "Rotherham": "Rotherham United",
    "Colchester": "Colchester United",
    "Crawley": "Crawley Town",
    "Northampton": "Northampton Town",
    "Grimsby": "Grimsby Town",
    "Fleetwood": "Fleetwood Town",
    "Newport": "Newport County",
    "Tranmere": "Tranmere Rovers",
    "Oldham": "Oldham Athletic",
    "Swindon": "Swindon Town",
    "Shrewsbury": "Shrewsbury Town",
    "Salford": "Salford City",
    "Accrington": "Accrington Stanley",
    "Exeter": "Exeter City",
    # Championship (rest)
    "Derby": "Derby County",
    "Swansea": "Swansea City",
    "Wolves": "Wolverhampton Wanderers",
    "Stoke": "Stoke City",
    # Premier League - wrong to assume these came through matching just
    # because the first handful checked (Bournemouth/Brighton/Liverpool)
    # happened to; confirmed on the second live run they mostly don't.
    "Coventry": "Coventry City",
    "Hull": "Hull City",
    "Tottenham": "Tottenham Hotspur",
    "Newcastle": "Newcastle United",
    "Leeds": "Leeds United",
    "Man Utd": "Manchester United",
    "Ipswich": "Ipswich Town",
    "Man City": "Manchester City",
    # General one-off gaps already known from the sibling SportMonks
    # scripts - kept defensively.
    "AFC Bournemouth": "Bournemouth",
    "Brighton & Hove Albion": "Brighton",
    "Milton Keynes Dons": "MK Dons",
}


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


def fetch_json(url, retries=3, backoff_seconds=5):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read())
        except (urllib.error.URLError, TimeoutError) as e:
            last_error = e
            if attempt < retries:
                print(f"  [retry] {url}: attempt {attempt}/{retries} failed ({e}) - retrying in {backoff_seconds}s ...")
                time.sleep(backoff_seconds)
    raise last_error


def canonical_name(name):
    return TEAM_NAME_OVERRIDES.get(name, name)


def resolve_team_id(cur, name):
    cur.execute("select team_id from team_aliases where source = %s and external_name = %s", (ALIAS_SOURCE, name))
    row = cur.fetchone()
    if row:
        return row[0]
    cur.execute("select id from teams where name = %s", (canonical_name(name),))
    row = cur.fetchone()
    if not row:
        return None
    team_id = row[0]
    cur.execute(
        "insert into team_aliases (team_id, source, external_name) values (%s, %s, %s) on conflict do nothing",
        (team_id, ALIAS_SOURCE, name),
    )
    return team_id


def resolve_player_id(cur, name, team_ids):
    """Scoped to ONLY the two teams in this fixture, same safety
    reasoning as import_sportmonks_player_props.py's resolve_player_id -
    a ~40-player pool, not a global name search."""
    cur.execute("select id from players where full_name = %s and team_id = any(%s)", (name, list(team_ids)))
    rows = cur.fetchall()
    return rows[0][0] if len(rows) == 1 else None


def poisson_pmf(k, lam):
    return math.exp(-lam) * (lam**k) / math.factorial(k)


def match_outcome_probs(home_xg, away_xg, max_goals=12):
    """Standard independent-Poisson scoreline model - the two teams'
    real, market-implied expected goals are the only inputs Spreadex's
    own feed actually gives (no direct 1X2 price exists here at all).
    Truncated at max_goals each side - real xG in this feed tops out
    well under 3.0, so 12 leaves a negligible, deliberately generous
    tail (P(13+) is astronomically small for any realistic xG)."""
    home_pmf = [poisson_pmf(k, home_xg) for k in range(max_goals + 1)]
    away_pmf = [poisson_pmf(k, away_xg) for k in range(max_goals + 1)]
    home_win = draw = away_win = 0.0
    for h in range(max_goals + 1):
        for a in range(max_goals + 1):
            p = home_pmf[h] * away_pmf[a]
            if h > a:
                home_win += p
            elif h == a:
                draw += p
            else:
                away_win += p
    total = home_win + draw + away_win
    return home_win / total, draw / total, away_win / total


def fetch_spreadex_fixtures(competition):
    url = f"{SPREADEX_BASE}/fixtures?{urllib.parse.urlencode({'competition': competition})}"
    data = fetch_json(url)
    return data.get("fixtures", [])


def fetch_spreadex_fixture_detail(fixture_id):
    return fetch_json(f"{SPREADEX_BASE}/fixture/{fixture_id}")


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        now = datetime.now(timezone.utc)
        cur.execute(
            """
            select f.id, ht.name, at.name, f.kickoff_at, f.home_team_id, f.away_team_id
            from fixtures f
            join teams ht on ht.id = f.home_team_id
            join teams at on at.id = f.away_team_id
            where f.competition in %s and f.kickoff_at >= %s and f.kickoff_at < %s
            """,
            (tuple(SPREADEX_COMPETITIONS.keys()), now, now + timedelta(days=LOOKAHEAD_DAYS)),
        )
        our_fixtures = cur.fetchall()
        by_key = {
            (home_name, away_name, kickoff_at.date()): (fid, home_team_id, away_team_id)
            for fid, home_name, away_name, kickoff_at, home_team_id, away_team_id in our_fixtures
        }
        our_fixtures_by_date: dict = {}
        for fid, home_name, away_name, kickoff_at, _h, _a in our_fixtures:
            our_fixtures_by_date.setdefault(kickoff_at.date(), []).append((home_name, away_name, fid))
        print(f"{len(our_fixtures)} upcoming fixtures across {len(SPREADEX_COMPETITIONS)} competitions to match against DreamTeamTonic/Spreadex.")

        matched_fixtures, prob_rows_written, cs_rows_written = 0, 0, 0
        unmatched_fixtures = []
        total_player_props, matched_players = 0, 0
        unmatched_players = []

        for our_competition, spreadex_competition in SPREADEX_COMPETITIONS.items():
            sx_fixtures = fetch_spreadex_fixtures(spreadex_competition)
            for f in sx_fixtures:
                home_team_name = canonical_name(f["home"]["team"])
                away_team_name = canonical_name(f["away"]["team"])
                kickoff = f.get("kickoff")
                if not kickoff:
                    continue
                match_date = datetime.fromisoformat(kickoff).date()

                match = by_key.get((home_team_name, away_team_name, match_date))
                if match is None:
                    candidates = our_fixtures_by_date.get(match_date, [])
                    unmatched_fixtures.append((match_date, our_competition, home_team_name, away_team_name, candidates))
                    continue
                our_fixture_id, our_home_team_id, our_away_team_id = match
                matched_fixtures += 1

                home_xg = float(f["home"]["xG"])
                away_xg = float(f["away"]["xG"])
                home_win_prob, draw_prob, away_win_prob = match_outcome_probs(home_xg, away_xg)
                cur.execute(
                    """
                    insert into fixture_probabilities (fixture_id, home_win_prob, draw_prob, away_win_prob, bookmaker_count)
                    values (%s, %s, %s, %s, 1)
                    """,
                    (our_fixture_id, round(home_win_prob, 4), round(draw_prob, 4), round(away_win_prob, 4)),
                )
                prob_rows_written += 1

                for side, team_id in (("home", our_home_team_id), ("away", our_away_team_id)):
                    cs_percent = f[side].get("cleanSheetPercent")
                    if cs_percent is None:
                        continue
                    cur.execute(
                        """
                        insert into fixture_clean_sheet_probabilities (fixture_id, team_id, clean_sheet_prob, bookmaker_count)
                        values (%s, %s, %s, 1)
                        """,
                        (our_fixture_id, team_id, round(float(cs_percent) / 100.0, 4)),
                    )
                    cs_rows_written += 1

                # Player-level scorer/assist odds - only worth the extra
                # call for fixtures we actually matched.
                detail = fetch_spreadex_fixture_detail(f["fixtureId"])
                if not detail:
                    continue
                team_ids = (our_home_team_id, our_away_team_id)

                for market_key, rows in (("score_probability", detail.get("scorers") or []), ("assist_probability", detail.get("assists") or [])):
                    for row in rows:
                        player_name = row.get("name")
                        odds = row.get("odds")
                        if not player_name or not odds:
                            continue
                        total_player_props += 1
                        player_id = resolve_player_id(cur, player_name, team_ids)
                        if player_id is None:
                            unmatched_players.append((player_name, row.get("team")))
                            continue
                        matched_players += 1
                        probability = round(1.0 / float(odds), 4)
                        if market_key == "score_probability":
                            cur.execute(
                                """
                                insert into bookmaker_player_features
                                    (player_id, fixture_id, score_probability, is_estimated, source, confidence, market_observed_at)
                                values (%s, %s, %s, false, %s, 1.0, now())
                                on conflict (player_id, fixture_id) do update set
                                    score_probability = excluded.score_probability,
                                    is_estimated = false,
                                    source = excluded.source,
                                    confidence = excluded.confidence,
                                    market_observed_at = excluded.market_observed_at,
                                    computed_at = now()
                                """,
                                (player_id, our_fixture_id, probability, ALIAS_SOURCE),
                            )
                            cur.execute(
                                "insert into bookmaker_player_probability_history (player_id, fixture_id, market, value) values (%s, %s, 'goal', %s)",
                                (player_id, our_fixture_id, probability),
                            )
                        else:
                            cur.execute(
                                """
                                insert into bookmaker_player_features
                                    (player_id, fixture_id, assist_probability, is_estimated, source, confidence,
                                     assist_is_estimated, assist_source, assist_confidence, assist_market_observed_at)
                                values (%s, %s, %s, false, %s, 1.0, false, %s, 1.0, now())
                                on conflict (player_id, fixture_id) do update set
                                    assist_probability = excluded.assist_probability,
                                    assist_is_estimated = false,
                                    assist_source = excluded.assist_source,
                                    assist_confidence = excluded.assist_confidence,
                                    assist_market_observed_at = excluded.assist_market_observed_at,
                                    computed_at = now()
                                """,
                                (player_id, our_fixture_id, probability, ALIAS_SOURCE, ALIAS_SOURCE),
                            )
                            cur.execute(
                                "insert into bookmaker_player_probability_history (player_id, fixture_id, market, value) values (%s, %s, 'assist', %s)",
                                (player_id, our_fixture_id, probability),
                            )

        conn.commit()
        print(
            f"\nDone: {matched_fixtures} fixtures matched, {prob_rows_written} fixture_probabilities rows written, "
            f"{cs_rows_written} clean-sheet rows written, {total_player_props} player-prop rows seen "
            f"({matched_players} name-matched to a real player_id)."
        )

        likely_naming_gaps = [u for u in unmatched_fixtures if u[4]]
        no_fixture_yet = [u for u in unmatched_fixtures if not u[4]]
        if likely_naming_gaps:
            print(f"\n[!!!] {len(likely_naming_gaps)} Spreadex fixture(s) had a DIFFERENT fixture on the same date in our own data - likely a real TEAM_NAME_OVERRIDES gap:")
            for match_date, competition, home_name, away_name, candidates in likely_naming_gaps:
                print(f"    {match_date} [{competition}]: Spreadex '{home_name}' v '{away_name}' - our fixtures: {candidates}")
        if no_fixture_yet:
            print(f"\n{len(no_fixture_yet)} Spreadex fixture(s) had no fixture at all in our own data yet that date - normal sync lag, not a naming bug.")
        if unmatched_players:
            unique_unmatched = sorted(set(unmatched_players))
            print(f"\n{len(unique_unmatched)} distinct player name(s) in real Spreadex markets didn't resolve to exactly one player_id:")
            for name, team in unique_unmatched[:30]:
                print(f"    '{name}' ({team})")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
