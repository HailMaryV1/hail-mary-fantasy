"""
import_sportmonks_match_odds.py
---------------------------------
Real bookmaker match-winner odds, now for all 6 English competitions
this SportMonks subscription is entitled to: Premier League, FA Cup and
Carabao Cup (added 2026-08-17, at the user's explicit request to source
ALL odds from SportMonks rather than The Odds API - see
import_fixtures_odds.py's docstring for how the two scripts now divide
fixture-sync vs odds-write responsibility for these 3), alongside the
original EFL Fantasy trio below.

Championship/League One/League Two, confirmed live 2026-08-06: all
three are entitled under this project's SportMonks subscription (league
ids 9/12/14 - the player-props script's own ENTITLED_LEAGUE_IDS is
stale, missing 12/14) and, for the real GW1 fixtures (2026-08-14 to
2026-08-17 - NOT the same date as FanTeam's Premier League GW1 on
2026-08-21; EFL's own divisions start a week earlier, confirmed from
this project's own game_fixture_gameweeks data), every fixture checked
is already fully priced (15/15 sampled, 550-620 real odds rows each).

This directly replaces the crude proxy compute_club_scores() has been
running the fixture-adjustment half of its calculation on (last
season's own-division average fantasy points, z-scored - see
seed_team_strength() in import_eflfantasy.py). Real bookmaker odds
already price in exactly what that proxy structurally can't: a promoted
club being a big underdog in its new, harder division (and a relegated
club being a big favourite in its new, easier one). Confirmed live:
Notts County (promoted to League One) was projecting 9.8 pts against
Leicester City purely off inflated League Two form - the real market
(fixture 19728337) has them at ~29% to win that match.

Writes into the exact same `fixture_odds` table (fixture_id, bookmaker,
home_price, draw_price, away_price) that import_fixtures_odds.py already
writes for every Odds-API-covered competition - deliberately reuses that
shape so the existing, fully generic compute_fixture_probabilities.py
(queries ALL fixtures, no competition filter) picks these up
automatically with zero changes needed there. team_fixture_difficulty's
real-odds-first COALESCE (migration 0017) does the rest - no view
changes either.

Team names matched exactly between SportMonks and this project's `teams`
table for every real GW1 EFL fixture when this was first written
(confirmed live: 0 mismatches across 50 distinct team names) - that
confirmation predates the 2026-08-17 Premier League addition and was
never re-run for it. Real user report 2026-08-22: Man City-Bournemouth
and Brighton-Aston Villa were silently dropped every single run since
soccer_epl was added, with zero odds/clean-sheet data for either,
because SportMonks spells them "AFC Bournemouth"/"Brighton & Hove
Albion" while this project's `teams.name` is "Bournemouth"/"Brighton" -
neither was in SPORTMONKS_NAME_OVERRIDES. A silent `continue` on no
match (see the main loop below) meant this had zero visibility until a
screenshot proved bet365 had extensive real markets live for that exact
fixture. Every unmatched SportMonks fixture is now logged loudly at the
end of every run specifically so this class of bug is never silent
again - see the unmatched-fixtures report in main().

Fixture matching: SportMonks fixture -> our fixtures row, by (home team
name, away team name, same calendar date) - not exact kickoff_at, since
lower-league fixtures occasionally get TV-rescheduled by a few hours
between the two feeds without the day itself changing.

Safe to re-run: fixture_odds is append-only (same convention as
import_fixtures_odds.py) - each run adds a fresh snapshot, preserving
odds movement over time rather than overwriting.

RUN:
    python3 scripts/import_sportmonks_match_odds.py
"""
import json
import os
import statistics
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football"

# Confirmed live 2026-08-06 via /v3/football/leagues - Championship,
# League One, League Two. Matches EFL Fantasy's 3 synthetic competition
# strings (see migration 0088's docstring) in the same order.
#
# soccer_epl/soccer_fa_cup/soccer_england_efl_cup added 2026-08-17 -
# these 3 match the exact game_competitions.competition strings The Odds
# API used for the same fixtures (see import_fixtures_odds.py), which is
# what makes `fixtures.competition` a valid join key here without a
# separate competition-name crosswalk.
LEAGUE_ID_BY_COMPETITION = {
    "efl_championship": 9,
    "efl_league_one": 12,
    "efl_league_two": 14,
    "soccer_epl": 8,
    "soccer_fa_cup": 24,
    "soccer_england_efl_cup": 27,
}

# How far ahead to pull fixtures/odds for - lower-league odds aren't
# posted far in advance (confirmed live: zero rows 15+ days out for
# Championship/League One, fully priced by ~8 days out), so there's no
# point requesting further ahead than this and burning API quota on
# fixtures nothing has priced yet.
LOOKAHEAD_DAYS = 21

# Fulltime Result (1X2 match-winner market) - confirmed live via a real
# fixture's odds response (market_id=1, label in Home/Draw/Away).
FULLTIME_RESULT_MARKET_ID = 1

# Real user report 2026-08-26 ("we shouldnt be building that probability
# for the market odds page... this isnt good enough") - Premier League's
# Clean Sheet market has a COMPLETELY DIFFERENT row shape than
# Championship/League One/League Two's, confirmed live by pulling a real
# fixture's raw odds (Crystal Palace v Man City, 2026-08-28):
#   Championship-style: market_description "Clean Sheet - Home"/"Clean
#     Sheet - Away", label="Yes"/"No" carries the yes/no split directly.
#   Premier League-style: market_description "Clean Sheet" (one market,
#     both teams), label="1"/"2" is the HOME/AWAY side, `name`
#     ("Yes"/"No", NOT label) carries the yes/no split.
# capture_clean_sheet_probabilities below previously only handled the
# Championship shape - checking `label != "Yes"` on a PL row (where
# label is always "1" or "2") silently matched nothing, every run, since
# soccer_epl was added. This is EXACTLY the "no visibility until a user
# happened to notice" failure mode this file's own docstring already
# warns about for team-name mismatches - same lesson, a different field.
# Confirmed correct against the real market: Palace 15.4% / City 38.1%
# clean sheet on the raw pull, matching the real bookmaker site's own
# displayed 15%/33% far better than the ~30%/70% win-prob-derived
# fallback this bug left the site quietly showing instead.
CLEAN_SHEET_MARKETS = {"Clean Sheet - Home": "home", "Clean Sheet - Away": "away"}
CLEAN_SHEET_SIDE_BY_LABEL = {"1": "home", "2": "away"}

# Known SportMonks spellings that differ from this project's canonical
# `teams.name` - same pattern as import_fixtures_odds.py's
# ODDS_NAME_OVERRIDES. Discovered empirically: SportMonks' own
# /fixtures/between/ endpoint isn't even internally consistent about
# this - the same real fixture ID returned "MK Dons" on one call and
# "Milton Keynes Dons" on another (confirmed live, 2026-08-06) - so this
# is applied defensively to every participant name, not just ones a
# single test happened to catch.
SPORTMONKS_NAME_OVERRIDES = {
    "Milton Keynes Dons": "MK Dons",
    # Added 2026-08-22 - real user report of a silently-dropped Premier
    # League fixture (Man City v Bournemouth) traced to these two never
    # having been checked against SportMonks' own Premier League naming
    # (only EFL Championship/L1/L2 spellings were verified when this
    # dict was first built - see this module's own docstring).
    "AFC Bournemouth": "Bournemouth",
    "Brighton & Hove Albion": "Brighton",
    # Deliberately NOT overriding "Luton Town"/"AFC Wimbledon" here, even
    # though they also show up unmatched in the EFL Cup - this project's
    # own `teams` table has TWO real, separately-used rows for each club
    # (e.g. "Luton" id 62 AND "Luton Town" id 172), and which one a given
    # fixture actually references depends on which importer created that
    # fixture row (EFL Cup fixtures use the short name, League One
    # fixtures use the long name - confirmed live 2026-08-22, adding a
    # blanket override here broke previously-working League One matches
    # while "fixing" EFL Cup ones). A single string rewrite can't resolve
    # this - it needs a real team-identity merge (same shape as this
    # project's existing player-identity-duplicate audit/merge), not a
    # name alias. Tracked separately; left genuinely unmatched (and
    # loudly reported below) until that's done, rather than silently
    # papered over with a fix that regresses a different competition.
}


def canonical_name(name: str) -> str:
    return SPORTMONKS_NAME_OVERRIDES.get(name, name)


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return  # CI sets real env vars directly - no .env file there.
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def fetch_json(url, retries=3, backoff_seconds=5):
    # 2026-08-17: a single slow SportMonks response (TimeoutError, not an
    # HTTPError - so the caller's own except clauses never saw it) killed
    # a real run outright mid-pipeline. Same fix already proven for
    # scraper_fanteam.py's own fetch_json - retry a transient blip a
    # few times with a short pause before giving up for real, instead of
    # one bad request taking down the whole run.
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


def fetch_fixtures(api_key, league_ids, start_date, end_date):
    ids = ",".join(str(i) for i in league_ids)
    url = (
        f"{SPORTMONKS_BASE}/fixtures/between/{start_date}/{end_date}"
        f"?api_token={api_key}&filters=fixtureLeagues:{ids}&include=participants&per_page=100"
    )
    fixtures = []
    while url:
        data = fetch_json(url)
        fixtures.extend(data.get("data", []))
        pagination = data.get("pagination") or {}
        url = pagination.get("next_page") if pagination.get("has_more") else None
        if url and "api_token=" not in url:
            url = f"{url}&api_token={api_key}"
    return fixtures


def fetch_odds(api_key, sportmonks_fixture_id):
    url = f"{SPORTMONKS_BASE}/odds/pre-match/fixtures/{sportmonks_fixture_id}?api_token={api_key}"
    try:
        data = fetch_json(url)
    except urllib.error.HTTPError as e:
        print(f"  [warn] fixture {sportmonks_fixture_id}: HTTP {e.code}")
        return []
    return data.get("data", [])


def insert_odds(cur, fixture_id, bookmaker, home_price, draw_price, away_price):
    cur.execute(
        """
        insert into fixture_odds (fixture_id, bookmaker, home_price, draw_price, away_price)
        values (%s, %s, %s, %s, %s)
        on conflict (fixture_id, bookmaker, fetched_at) do nothing
        """,
        (fixture_id, bookmaker, home_price, draw_price, away_price),
    )


def _parse_probability_field(row):
    """SportMonks odds rows carry a ready-made `probability` string
    (e.g. "27.78%") - simpler and more direct than reconstructing one
    from `value` (the decimal price), which is what import_sportmonks_
    player_props.py's parse_probability() falls back to only when this
    field is missing. Every Clean Sheet row observed live has it, so no
    fallback is needed here."""
    prob = row.get("probability")
    if not prob:
        return None
    try:
        return float(prob.strip("%")) / 100.0
    except ValueError:
        return None


def capture_clean_sheet_probabilities(cur, fixture_id, odds_rows, home_team_id, away_team_id):
    """Writes real fixture_clean_sheet_probabilities rows straight from
    SportMonks' "Clean Sheet - Home"/"Clean Sheet - Away" markets (see
    CLEAN_SHEET_MARKETS's own comment for why this exists) - reuses the
    SAME odds_rows already fetched for the match-winner market above, no
    extra API call. Append-only, same convention as
    compute_clean_sheet_probabilities.py's own writes (and fixture_odds
    itself) - team_fixture_difficulty's view always reads the latest
    row per (fixture_id, team_id) by computed_at, so a fresh snapshot
    each run is exactly what's needed, not an update-in-place.

    One row per team, median across whichever bookmakers offered the
    market this run - same "de-noise across bookmakers" approach
    compute_clean_sheet_probabilities.py already uses via
    statistics.median."""
    team_id_by_side = {"home": home_team_id, "away": away_team_id}
    probs_by_side = {"home": [], "away": []}

    for r in odds_rows:
        desc = r.get("market_description")
        if desc in CLEAN_SHEET_MARKETS:
            # Championship/League One/League Two shape - see
            # CLEAN_SHEET_MARKETS' own comment.
            side = CLEAN_SHEET_MARKETS[desc]
            is_yes = r.get("label") == "Yes"
        elif desc == "Clean Sheet":
            # Premier League shape - see CLEAN_SHEET_SIDE_BY_LABEL's own
            # comment. label is the side ("1"/"2"), name carries yes/no.
            side = CLEAN_SHEET_SIDE_BY_LABEL.get(r.get("label"))
            is_yes = r.get("name") == "Yes"
        else:
            continue
        if side is None or not is_yes:
            continue
        prob = _parse_probability_field(r)
        if prob is not None:
            probs_by_side[side].append(prob)

    written = 0
    for side, probs in probs_by_side.items():
        if not probs:
            continue
        cur.execute(
            """
            insert into fixture_clean_sheet_probabilities (fixture_id, team_id, clean_sheet_prob, bookmaker_count)
            values (%s, %s, %s, %s)
            """,
            (fixture_id, team_id_by_side[side], statistics.median(probs), len(probs)),
        )
        written += 1
    return written


def main():
    load_env()
    api_key = os.environ["SPORTMONKS_API_KEY"]
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        now = datetime.now(timezone.utc)

        # Our own upcoming eflfantasy fixtures, keyed by (home name, away
        # name, calendar date) - matched below against SportMonks'
        # equivalent, not by external_id (ours are
        # "eflfantasy:{roundGameId}", SportMonks has its own unrelated
        # numbering with no crosswalk).
        cur.execute(
            """
            select f.id, ht.name as home_name, at.name as away_name, f.kickoff_at, f.home_team_id, f.away_team_id, f.competition
            from fixtures f
            join teams ht on ht.id = f.home_team_id
            join teams at on at.id = f.away_team_id
            where f.competition in %s and f.kickoff_at >= %s and f.kickoff_at < %s
            """,
            (tuple(LEAGUE_ID_BY_COMPETITION.keys()), now, now + timedelta(days=LOOKAHEAD_DAYS)),
        )
        our_fixtures = cur.fetchall()
        by_key = {
            (home_name, away_name, kickoff_at.date()): (fid, home_team_id, away_team_id)
            for fid, home_name, away_name, kickoff_at, home_team_id, away_team_id, _competition in our_fixtures
        }
        print(f"{len(our_fixtures)} upcoming fixtures (all 6 covered competitions) to match against SportMonks.")

        start_date = now.date().isoformat()
        end_date = (now + timedelta(days=LOOKAHEAD_DAYS)).date().isoformat()
        sm_fixtures = fetch_fixtures(api_key, LEAGUE_ID_BY_COMPETITION.values(), start_date, end_date)
        print(f"{len(sm_fixtures)} SportMonks fixtures found in that window across Championship/L1/L2.")

        # Real user report 2026-08-22 ("NO FIXTURE SHOULD EVER GET
        # SKIPPED - EVER"): a name-match miss here used to just `continue`
        # silently, with no visibility until a user happened to notice
        # real odds were missing. Every SportMonks fixture that fails to
        # match now gets collected and reported loudly at the end of the
        # run, distinguishing "same date/competition has a DIFFERENT-
        # named fixture in our own data" (almost certainly a real naming
        # gap needing a SPORTMONKS_NAME_OVERRIDES entry, like the
        # Bournemouth/Brighton case that prompted this) from "we have no
        # fixture at all yet for that date/competition" (normal sync lag
        # for fixtures further out than our own fixture importers have
        # reached - not a bug, just not yet due).
        our_fixtures_by_date_comp: dict[tuple, list] = {}
        for fid, home_name, away_name, kickoff_at, home_team_id, away_team_id, competition in our_fixtures:
            our_fixtures_by_date_comp.setdefault((kickoff_at.date(), competition), []).append((home_name, away_name, fid))
        comp_by_league_id = {v: k for k, v in LEAGUE_ID_BY_COMPETITION.items()}

        matched, priced, odds_written, clean_sheet_written = 0, 0, 0, 0
        unmatched = []
        for f in sm_fixtures:
            participants = f.get("participants", [])
            home = next((p for p in participants if (p.get("meta") or {}).get("location") == "home"), None)
            away = next((p for p in participants if (p.get("meta") or {}).get("location") == "away"), None)
            starting_at = f.get("starting_at")
            if not home or not away or not starting_at:
                continue

            match_date = datetime.fromisoformat(starting_at.replace(" ", "T")).date()
            home_name, away_name = canonical_name(home.get("name")), canonical_name(away.get("name"))
            match = by_key.get((home_name, away_name, match_date))
            if match is None:
                sm_competition = comp_by_league_id.get(f.get("league_id"))
                same_date_comp_candidates = our_fixtures_by_date_comp.get((match_date, sm_competition), [])
                unmatched.append((match_date, sm_competition, home.get("name"), away.get("name"), same_date_comp_candidates))
                continue
            our_fixture_id, our_home_team_id, our_away_team_id = match
            matched += 1

            odds_rows = fetch_odds(api_key, f["id"])
            fulltime = [r for r in odds_rows if r.get("market_id") == FULLTIME_RESULT_MARKET_ID]
            if not fulltime:
                continue
            priced += 1

            by_bookmaker: dict[int, dict[str, float]] = {}
            for r in fulltime:
                bookmaker_id = r.get("bookmaker_id")
                label = r.get("label")
                value = r.get("value")
                if bookmaker_id is None or label not in ("Home", "Draw", "Away") or value is None:
                    continue
                by_bookmaker.setdefault(bookmaker_id, {})[label] = float(value)

            for bookmaker_id, prices in by_bookmaker.items():
                if "Home" in prices and "Draw" in prices and "Away" in prices:
                    insert_odds(cur, our_fixture_id, f"sportmonks_{bookmaker_id}", prices["Home"], prices["Draw"], prices["Away"])
                    odds_written += 1

            clean_sheet_written += capture_clean_sheet_probabilities(cur, our_fixture_id, odds_rows, our_home_team_id, our_away_team_id)

        conn.commit()
        print(f"\nDone: {matched} fixtures matched, {priced} already priced, {odds_written} bookmaker odds rows written, "
              f"{clean_sheet_written} clean-sheet-probability rows written.")

        likely_naming_gaps = [u for u in unmatched if u[4]]
        no_fixture_yet = [u for u in unmatched if not u[4]]
        if likely_naming_gaps:
            print(
                f"\n[!!!] {len(likely_naming_gaps)} SportMonks fixture(s) had a DIFFERENT fixture on the "
                f"same date AND competition in our own data - almost certainly a real "
                f"SPORTMONKS_NAME_OVERRIDES gap (exactly the class of bug that silently dropped Man "
                f"City-Bournemouth/Brighton-Aston Villa until a user caught it live). Every one of these "
                f"means missing real odds RIGHT NOW for that fixture:"
            )
            for match_date, competition, home_name, away_name, candidates in likely_naming_gaps:
                print(f"    {match_date} [{competition}]: SportMonks '{home_name}' v '{away_name}' - our fixtures: {candidates}")
        if no_fixture_yet:
            print(
                f"\n{len(no_fixture_yet)} SportMonks fixture(s) had no fixture at all in our own data yet on "
                f"that date/competition - normal sync lag for dates further out than our own fixture "
                f"importers have reached, not a naming bug."
            )
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
