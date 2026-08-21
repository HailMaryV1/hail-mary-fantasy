"""
import_sportmonks_player_props.py
-----------------------------------
Real player-level bookmaker markets (anytime/first/last goalscorer, and
whatever else bookmakers actually offer once checked against live data -
see PLAYER_PROP_MARKETS below) via SportMonks, which The Odds API's
equivalent markets have never actually populated for us in practice (see
import_fixture_extras.py's own docstring). SportMonks was dropped once
before on this project for fixture/match-odds (see memory
reference_hail_mary_infra.md) - this is a different use case, player
props specifically, not a re-run of that.

Two passes, both safe to run on a schedule:

1. link_fixtures() - resolves our own `fixtures` rows to SportMonks'
   fixture ids, for fixtures in the leagues this subscription is
   entitled to (Premier League, Championship, FA Cup, Carabao Cup -
   confirmed via /v3/football/leagues). Matches by (kickoff date, home
   team, away team) using a team_aliases 'sportmonks' source, same
   bootstrap pattern import_fixtures_odds.py already uses for
   'oddsapi' - except this NEVER auto-creates a new team on a miss
   (unlike that script): every team these leagues could produce already
   exists in our `teams` table from Odds API's own fixture import, so an
   unmatched name here means the resolution logic is wrong, not that a
   new team needs creating - auto-creating one would risk silently
   fragmenting a real club across two team rows.

2. import_player_props() - for fixtures already linked and kicking off
   within PROP_WINDOW_DAYS, fetches real pre-match odds and keeps rows
   whose market is in PLAYER_PROP_MARKETS. Confirmed empirically
   (2026-07-29): odds - including basic match-winner odds, let alone
   player props - simply don't exist for a fixture much further out
   than this, so a run made weeks before kickoff correctly inserts
   nothing. Player is identified by SportMonks as a bare name string
   (no id on the odds row itself) - resolved against `players` scoped
   to ONLY the two teams playing in that fixture (not a global name
   search), which is what makes exact-name matching safe here: a
   ~40-player pool per fixture, not the whole division.

Every REAL row captured also upserts player_prop_baselines (migration
0060) with this fixture's team_fixture_difficulty.attack_score - the
anchor a future fixture with no real props posted yet scales from. Only
written when a real row was actually captured and name-matched - never
fabricated.

3. populate_hub() - the Bookmaker Intelligence Hub write path
   (bookmaker_player_features, migration 0064): every real "Anytime"
   goalscorer row just captured becomes a REAL hub row
   (is_estimated = false); every player with a baseline also gets an
   ESTIMATED hub row (is_estimated = true) for every other upcoming
   fixture their team plays, scaled by that fixture's own team-strength
   signal - resolved once here, game-independently (no game_id at all,
   see migration 0064's own comment), so every fantasy game's scoring
   engine and Ask Mary read one already-resolved value instead of each
   re-deriving this fallback. Never overwrites a real row with an
   estimate.

RUN:
    python3 scripts/import_sportmonks_player_props.py [--window-days N]
"""

import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2
from psycopg2.extras import execute_values

ROOT = Path(__file__).resolve().parent.parent
SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football"

# The leagues this SportMonks subscription is entitled to that overlap
# competitions Hail Mary actually tracks (confirmed via
# /v3/football/leagues - also includes Friendly International, which we
# don't score and skip). Champions League/Europa/Conference are NOT
# included in this plan - The Odds API remains the only source for
# those, unchanged.
#
# League One (12) and League Two (14) re-confirmed entitled 2026-08-06
# (see import_sportmonks_match_odds.py's docstring) - this list was
# stale, missing them even though the subscription already covered both.
ENTITLED_LEAGUE_IDS = [8, 9, 12, 14, 24, 27]  # Premier League, Championship, League One, League Two, FA Cup, Carabao Cup

# Odds only actually populate this close to kickoff (confirmed
# empirically against a real imminent fixture - a Premier League match
# 3+ weeks out had zero rows, one 3 days out had 2,276). Generous
# padding over the observed 3-day case since coverage may start earlier
# for higher-profile fixtures.
DEFAULT_PROP_WINDOW_DAYS = 10

# Bookmaker market names confirmed to carry a real player name in `name`
# (checked against a real live fixture's full market list - see session
# notes). "Anytime Goalscorer" specifically hasn't been observed yet
# (the test fixture only offered First/Last, common for lower-profile
# games) - Premier League fixtures should offer richer markets once
# real data exists; extend this set then rather than guessing now.
#
# "Player to Assist" (SportMonks market id 332, confirmed to exist in
# this subscription's global /v3/odds/markets catalog) added 2026-07-30 -
# NOT yet observed on any real fixture's odds response (only entitled
# fixtures within the pricing window so far are lower-profile Carabao Cup
# ties, which - like the Goalscorers precedent above - don't necessarily
# carry every market a top-flight fixture would). Fails safe if the real
# market_description string turns out to differ: zero rows match, exactly
# like any other unrecognised market, never a fabricated probability.
#
# "Player to be booked" and "Player Shots On Target" added 2026-08-17,
# per the user's explicit request that "as many markets that can be used
# to build points for a player should be the absolute fundamentals" of
# this project's scoring model - and, unlike Player to Assist above,
# BOTH confirmed live against two real near-kickoff fixtures (Arsenal v
# Coventry, 4 days out; Cardiff v Wrexham, same day) before being wired
# in here:
#   - "Player to be booked": single binary market (label="Booked"),
#     same shape as "Player to Assist" - real P(booked) directly.
#   - "Player Shots On Target": an over/under-style market with several
#     lines per player (label="1+"/"2+"/"3+"/...) - only the "1+" line is
#     used (see import_player_props()'s shots-on-target branch), the
#     same P(count >= 1) shape "Goalscorers"' Anytime label already
#     provides, so it converts to E[shots on target] via the identical
#     Poisson-implied maths (duplicated here, not imported, since
#     compute_projections.py's anytime_prob_to_expected_goals lives in a
#     separate standalone script).
#   - A real per-player "sent off" market was searched for on both test
#     fixtures and does not exist (only a match-level, non-attributable
#     "Red Card in the Match" yes/no) - sending_off_probability is left
#     unwired this pass, not guessed at.
PLAYER_PROP_MARKETS = {"Goalscorers", "Player to Assist", "Player to be booked", "Player Shots On Target"}

# The "1+" line of "Player Shots On Target" is the only one written into
# the hub (see PLAYER_PROP_MARKETS comment above) - the other lines
# (2+, 3+, ...) are still captured into fixture_player_props as raw data
# but deliberately not used for the hub write.
SHOTS_ON_TARGET_ANYTIME_LABEL = "1+"

# Labels within PLAYER_PROP_MARKETS that don't name an actual player -
# these show up as an "outcome" of the same market and must be filtered
# out, not stored as a player prop.
NON_PLAYER_LABELS = {"No Goalscorer"}

SPORTMONKS_TEAM_NAME_OVERRIDES = {
    "AFC Bournemouth": "Bournemouth",
    "Brighton & Hove Albion": "Brighton",
}


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


def fetch_json(url, api_key, params=None, retries=3, backoff_seconds=5):
    # 2026-08-17: a real run crashed outright on a plain TimeoutError from
    # this exact call (not an HTTPError, so the except clause below never
    # saw it) - one slow response took down the whole player-props import.
    # Same fix already proven for scraper_fanteam.py's own fetch_json:
    # retry a transient blip a few times before soft-failing to None,
    # which every call site here already treats as "nothing to do" rather
    # than a fatal error.
    query = dict(params or {})
    query["api_token"] = api_key
    full_url = f"{url}?{urllib.parse.urlencode(query)}"
    req = urllib.request.Request(full_url, headers={"User-Agent": "Mozilla/5.0"})
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            print(f"  [warn] {full_url}: HTTP {e.code} - {e.read()[:200]}")
            return None
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < retries:
                print(f"  [retry] {full_url}: attempt {attempt}/{retries} failed ({e}) - retrying in {backoff_seconds}s ...")
                time.sleep(backoff_seconds)
            else:
                print(f"  [warn] {full_url}: gave up after {retries} attempts ({e})")
                return None


def resolve_team_id(cur, name):
    """Same 'sportmonks' source pattern as import_fixtures_odds.py's
    'oddsapi' aliasing, EXCEPT this never inserts a new team row on a
    miss - every team a top-4-tier English competition could produce
    already exists here from Odds API's own import, so a miss means the
    name needs an override entry, not a new team."""
    cur.execute(
        "select team_id from team_aliases where source = 'sportmonks' and external_name = %s",
        (name,),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    canonical_name = SPORTMONKS_TEAM_NAME_OVERRIDES.get(name, name)
    cur.execute("select id from teams where name = %s", (canonical_name,))
    row = cur.fetchone()
    if not row:
        return None
    team_id = row[0]
    cur.execute(
        "insert into team_aliases (team_id, source, external_name) values (%s, 'sportmonks', %s) on conflict do nothing",
        (team_id, name),
    )
    return team_id


def link_fixtures(cur, api_key, window_days):
    """Resolves fixtures.sportmonks_fixture_id for unlinked fixtures
    within the lookahead window, matching SportMonks fixtures (in our
    entitled leagues) to our own rows by (date, home team, away team)."""
    start = datetime.now(timezone.utc).date()
    end = start + timedelta(days=window_days + 45)  # link further ahead than we'll fetch odds for - linking itself costs nothing

    linked, unmatched = 0, 0
    for league_id in ENTITLED_LEAGUE_IDS:
        data = fetch_json(
            f"{SPORTMONKS_BASE}/fixtures/between/{start.isoformat()}/{end.isoformat()}",
            api_key,
            {"filters": f"fixtureLeagues:{league_id}", "include": "participants"},
        )
        if not data:
            continue
        for fx in data.get("data", []):
            participants = fx.get("participants", [])
            home = next((p for p in participants if p.get("meta", {}).get("location") == "home"), None)
            away = next((p for p in participants if p.get("meta", {}).get("location") == "away"), None)
            if not home or not away:
                continue
            home_id = resolve_team_id(cur, home["name"])
            away_id = resolve_team_id(cur, away["name"])
            if not home_id or not away_id:
                unmatched += 1
                print(f"  [unmatched teams] {home.get('name')} vs {away.get('name')} - add a SPORTMONKS_TEAM_NAME_OVERRIDES entry")
                continue

            starting_at = fx.get("starting_at")
            if not starting_at:
                continue
            fixture_date = starting_at[:10]

            # Real failure 2026-08-20 (Refresh - shared odds, twice): our
            # own fixtures table can carry more than one row for the same
            # real match - a placeholder-kickoff import and a later one
            # with the real confirmed broadcast time, sometimes even on
            # DIFFERENT calendar dates (a real Bradford City vs Burnley
            # EFL Cup tie held rows dated both Aug 25 and Aug 26) - same
            # duplication compute_projections.py already dedupes at read
            # time for scoring, just not caught by a same-date check here.
            # Whichever duplicate the live feed matched first already
            # holds this SportMonks id from an earlier run; a later run
            # matching against the OTHER duplicate (different date, so a
            # single UPDATE's own row-scoping can't see both at once)
            # would violate fixtures_sportmonks_fixture_id_key. Skip
            # outright once any row already holds this id - a plain
            # SELECT can't itself violate a constraint, so this can't
            # abort the transaction the way a failed UPDATE would.
            cur.execute("select 1 from fixtures where sportmonks_fixture_id = %s", (fx["id"],))
            if cur.fetchone():
                continue

            # Still scoped to exactly one row via a subquery, not a bare
            # multi-row WHERE, in case two same-dated duplicates remain -
            # see the block comment above for why duplicates exist at all.
            cur.execute(
                """
                update fixtures set sportmonks_fixture_id = %s
                where id = (
                    select id from fixtures
                    where home_team_id = %s and away_team_id = %s
                      and kickoff_at::date = %s and sportmonks_fixture_id is null
                    order by created_at desc
                    limit 1
                )
                """,
                (fx["id"], home_id, away_id, fixture_date),
            )
            if cur.rowcount > 0:
                linked += 1

    print(f"Linked {linked} fixtures to SportMonks ids ({unmatched} team-name misses).")


def team_attack_score(cur, fixture_id, team_id):
    cur.execute(
        "select attack_score from team_fixture_difficulty where fixture_id = %s and team_id = %s limit 1",
        (fixture_id, team_id),
    )
    row = cur.fetchone()
    return float(row[0]) if row else None


def resolve_player_id(cur, name, team_ids):
    """Scoped to ONLY the two teams in this fixture - a ~40-player pool,
    not a global name search, which is what makes exact matching safe
    here (see this project's own surname-collision incident earlier
    this season). Returns (player_id, team_id) so the caller doesn't
    need a second lookup to know whose attack_score applies."""
    cur.execute(
        "select id, team_id from players where full_name = %s and team_id = any(%s)",
        (name, list(team_ids)),
    )
    rows = cur.fetchall()
    return rows[0] if len(rows) == 1 else (None, None)


def parse_probability(row):
    prob = row.get("probability")
    if prob:
        try:
            return float(prob.strip("%")) / 100.0
        except ValueError:
            pass
    price = row.get("value")
    try:
        price = float(price)
        return 1.0 / price if price > 0 else None
    except (TypeError, ValueError):
        return None


def anytime_prob_to_expected_count(p):
    """Identical maths to compute_projections.py's
    anytime_prob_to_expected_goals - duplicated here (not imported)
    since this is a standalone script. Converts a real P(count >= 1)
    market probability to E[count] assuming a Poisson process:
    P(0) = e^-lambda, so lambda = -ln(1 - p)."""
    p = max(0.0, min(0.99, p))
    return -math.log(1 - p) if p > 0 else 0.0


def import_player_props(cur, api_key, window_days):
    cutoff = datetime.now(timezone.utc) + timedelta(days=window_days)
    cur.execute(
        """
        select f.id, f.sportmonks_fixture_id, f.home_team_id, f.away_team_id
        from fixtures f
        where f.sportmonks_fixture_id is not null
          and f.kickoff_at >= now() and f.kickoff_at <= %s
        """,
        (cutoff,),
    )
    fixtures = cur.fetchall()

    bookmaker_names = {}
    total_props, matched = 0, 0

    for fixture_id, sm_fixture_id, home_team_id, away_team_id in fixtures:
        data = fetch_json(f"{SPORTMONKS_BASE}/odds/pre-match/fixtures/{sm_fixture_id}", api_key)
        if not data:
            continue
        rows = [r for r in data.get("data", []) if r.get("market_description") in PLAYER_PROP_MARKETS]
        if not rows:
            continue

        for row in rows:
            player_name = row.get("name")
            label = row.get("label")
            if not player_name or player_name in NON_PLAYER_LABELS or label in NON_PLAYER_LABELS:
                continue
            probability = parse_probability(row)
            price = row.get("value")
            if probability is None or price is None:
                continue

            bookmaker_id = row.get("bookmaker_id")
            if bookmaker_id not in bookmaker_names:
                bm = fetch_json(f"https://api.sportmonks.com/v3/odds/bookmakers/{bookmaker_id}", api_key)
                bookmaker_names[bookmaker_id] = (bm or {}).get("data", {}).get("name", f"sportmonks_bookmaker_{bookmaker_id}")
            bookmaker = bookmaker_names[bookmaker_id]

            market_key = f"{row.get('market_description')} ({label})"
            cur.execute(
                """
                insert into fixture_player_props (fixture_id, player_name_raw, market, bookmaker, price)
                values (%s, %s, %s, %s, %s)
                """,
                (fixture_id, player_name, market_key, bookmaker, price),
            )
            total_props += 1

            player_id, player_team_id = resolve_player_id(cur, player_name, (home_team_id, away_team_id))
            if player_id is None:
                continue
            matched += 1
            attack_score = team_attack_score(cur, fixture_id, player_team_id)
            if attack_score is None:
                continue
            cur.execute(
                """
                insert into player_prop_baselines (player_id, market, fixture_id, observed_probability, team_attack_score)
                values (%s, %s, %s, %s, %s)
                on conflict (player_id, market) do update set
                    fixture_id = excluded.fixture_id,
                    observed_probability = excluded.observed_probability,
                    team_attack_score = excluded.team_attack_score,
                    observed_at = now()
                """,
                (player_id, market_key, fixture_id, probability, attack_score),
            )

            market_description = row.get("market_description")

            # Real "Anytime" goalscorer odds go straight into the hub as a
            # REAL row - "First"/"Last" alone don't give P(scores >= 1),
            # so only this specific label populates score_probability. The
            # is_estimated/source/confidence/market_observed_at columns
            # here are - in practice - goal's own provenance (see migration
            # 0069's comment); the assist branch below never reads them.
            if market_description == "Goalscorers" and label == "Anytime":
                cur.execute(
                    """
                    insert into bookmaker_player_features
                        (player_id, fixture_id, score_probability, is_estimated, source, confidence, market_observed_at)
                    values (%s, %s, %s, false, 'sportmonks_real', 1.0, now())
                    on conflict (player_id, fixture_id) do update set
                        score_probability = excluded.score_probability,
                        is_estimated = false,
                        source = excluded.source,
                        confidence = excluded.confidence,
                        market_observed_at = excluded.market_observed_at,
                        computed_at = now()
                    """,
                    (player_id, fixture_id, probability),
                )
                # Append-only log (migration 0120) - see its own comment
                # for why the hub upsert above alone can't detect a swing.
                cur.execute(
                    "insert into bookmaker_player_probability_history (player_id, fixture_id, market, value) values (%s, %s, 'goal', %s)",
                    (player_id, fixture_id, probability),
                )
            # "Player to Assist" is a single binary market, unlike
            # Goalscorers - no Anytime/First/Last split, so every real row
            # here is P(assists >= 1) directly. Writes its own
            # assist_is_estimated/assist_source/assist_confidence/
            # assist_market_observed_at columns (migration 0069) rather
            # than the shared ones above, so a fixture with real assist
            # data but no goal data yet (or vice versa) never has one
            # market's provenance silently overwritten by the other's.
            # The shared is_estimated/source/confidence columns still get
            # populated here only because they're NOT NULL on a brand-new
            # row - compute_projections.py's goal pathway is unaffected
            # regardless of their value, since it always checks
            # score_probability IS NULL first, not is_estimated.
            elif market_description == "Player to Assist":
                cur.execute(
                    """
                    insert into bookmaker_player_features
                        (player_id, fixture_id, assist_probability, is_estimated, source, confidence,
                         assist_is_estimated, assist_source, assist_confidence, assist_market_observed_at)
                    values (%s, %s, %s, false, 'sportmonks_real', 1.0, false, 'sportmonks_real', 1.0, now())
                    on conflict (player_id, fixture_id) do update set
                        assist_probability = excluded.assist_probability,
                        assist_is_estimated = false,
                        assist_source = excluded.assist_source,
                        assist_confidence = excluded.assist_confidence,
                        assist_market_observed_at = excluded.assist_market_observed_at,
                        computed_at = now()
                    """,
                    (player_id, fixture_id, probability),
                )
                cur.execute(
                    "insert into bookmaker_player_probability_history (player_id, fixture_id, market, value) values (%s, %s, 'assist', %s)",
                    (player_id, fixture_id, probability),
                )
            # "Player to be booked" is a single binary market, same shape
            # as "Player to Assist" above - real P(booked) directly, its
            # own booking_is_estimated/booking_source/booking_confidence/
            # booking_market_observed_at provenance quad (migration 0117)
            # so it never shares or overwrites goal's/assist's. Written
            # as-is (no Poisson conversion) - a 2nd booking in the same
            # match ends with the player sent off (scored separately as
            # red_card), so P(booked >= 1) is already a good proxy for
            # E[yellow_card] in practice.
            elif market_description == "Player to be booked":
                cur.execute(
                    """
                    insert into bookmaker_player_features
                        (player_id, fixture_id, booking_probability, is_estimated, source, confidence,
                         booking_is_estimated, booking_source, booking_confidence, booking_market_observed_at)
                    values (%s, %s, %s, false, 'sportmonks_real', 1.0, false, 'sportmonks_real', 1.0, now())
                    on conflict (player_id, fixture_id) do update set
                        booking_probability = excluded.booking_probability,
                        booking_is_estimated = false,
                        booking_source = excluded.booking_source,
                        booking_confidence = excluded.booking_confidence,
                        booking_market_observed_at = excluded.booking_market_observed_at,
                        computed_at = now()
                    """,
                    (player_id, fixture_id, probability),
                )
                cur.execute(
                    "insert into bookmaker_player_probability_history (player_id, fixture_id, market, value) values (%s, %s, 'booking', %s)",
                    (player_id, fixture_id, probability),
                )
            # "Player Shots On Target" carries several lines per player
            # (1+/2+/3+/...) - only the 1+ line gives P(count >= 1), the
            # same shape Goalscorers' Anytime label gives for goals, so it
            # converts to E[shots on target] via the identical Poisson
            # maths (anytime_prob_to_expected_count) rather than storing
            # the raw probability - unlike score_probability/
            # assist_probability/booking_probability, which store the raw
            # market probability and let compute_projections.py convert
            # at read time, expected_shots_on_target's own name already
            # promises an expected COUNT, so the conversion happens here
            # instead, once, at write time.
            elif market_description == "Player Shots On Target" and label == SHOTS_ON_TARGET_ANYTIME_LABEL:
                expected_sot = anytime_prob_to_expected_count(probability)
                cur.execute(
                    """
                    insert into bookmaker_player_features
                        (player_id, fixture_id, expected_shots_on_target, is_estimated, source, confidence,
                         shots_on_target_is_estimated, shots_on_target_source, shots_on_target_confidence,
                         shots_on_target_market_observed_at)
                    values (%s, %s, %s, false, 'sportmonks_real', 1.0, false, 'sportmonks_real', 1.0, now())
                    on conflict (player_id, fixture_id) do update set
                        expected_shots_on_target = excluded.expected_shots_on_target,
                        shots_on_target_is_estimated = false,
                        shots_on_target_source = excluded.shots_on_target_source,
                        shots_on_target_confidence = excluded.shots_on_target_confidence,
                        shots_on_target_market_observed_at = excluded.shots_on_target_market_observed_at,
                        computed_at = now()
                    """,
                    (player_id, fixture_id, expected_sot),
                )
                cur.execute(
                    "insert into bookmaker_player_probability_history (player_id, fixture_id, market, value) values (%s, %s, 'shot_on_target', %s)",
                    (player_id, fixture_id, expected_sot),
                )

        print(f"  fixture {fixture_id}: {len(rows)} player-prop rows")

    print(f"\nCaptured {total_props} player-prop rows across {len(fixtures)} linked fixtures due within {window_days} days; {matched} name-matched to a real player_id.")
    if not fixtures:
        print("(No fixtures linked and due within the window yet - expected pre-season / far from kickoff.)")
    elif total_props == 0:
        print("(Expected this far from kickoff - bookmakers haven't posted player markets yet.)")


def _upcoming_team_fixtures(cur, team_id):
    """(fixture_id, home_team_id, home_win_prob, away_win_prob) for every
    upcoming fixture team_id plays with a resolved (real-or-model) win
    probability - shared by the goal and assist estimated-hub-row passes
    below, since which fixtures exist and their win probabilities don't
    depend on which market is being scaled.

    Deliberately game-independent: reads fixture_probabilities (real
    odds) COALESCEd with fixture_strength_model_probabilities (the
    season-strength fallback) directly, NOT through team_fixture_difficulty
    (which is joined per-game purely for competition scoping, not a
    different computation) - so this never depends on which fantasy game
    happens to call it, matching bookmaker_player_features having no
    game_id column at all (migration 0064).
    """
    cur.execute(
        """
        select
            f.id as fixture_id, f.home_team_id,
            coalesce(rp.home_win_prob, mp.home_win_prob) as home_win_prob,
            coalesce(rp.away_win_prob, mp.away_win_prob) as away_win_prob
        from fixtures f
        left join lateral (
            select home_win_prob, away_win_prob from fixture_probabilities
            where fixture_id = f.id order by computed_at desc limit 1
        ) rp on true
        left join lateral (
            select home_win_prob, away_win_prob from fixture_strength_model_probabilities
            where fixture_id = f.id order by computed_at desc limit 1
        ) mp on true
        where (f.home_team_id = %s or f.away_team_id = %s) and f.kickoff_at >= now()
          and coalesce(rp.home_win_prob, mp.home_win_prob) is not null
        """,
        (team_id, team_id),
    )
    return cur.fetchall()


def _fetch_existing_flags(cur, pairs, column):
    """Batch lookup of bookmaker_player_features.<column> for a set of
    (player_id, fixture_id) pairs, in one round trip via unnest - shared
    by both estimated-hub-row passes below.

    Real bottleneck found live 2026-08-21 investigating the "shared
    odds" refresh timing out past its 2hr CI limit: a real run wrote
    123,464 hub rows, and the old code before this fix did 2 sequential
    round trips PER row (a SELECT to check for an existing real
    observation, then an upsert) plus re-ran _upcoming_team_fixtures()
    once per BASELINE PLAYER instead of once per team - together good
    for a quarter-million+ round trips against a remote DB, easily
    accounting for the whole multi-hour runtime on its own. This
    collapses the existence check to one query for the whole batch."""
    if not pairs:
        return {}
    player_ids = [p for p, _ in pairs]
    fixture_ids = [f for _, f in pairs]
    cur.execute(
        f"""
        select bpf.player_id, bpf.fixture_id, bpf.{column}
        from bookmaker_player_features bpf
        join unnest(%s::bigint[], %s::bigint[]) as pairs(player_id, fixture_id)
          on bpf.player_id = pairs.player_id and bpf.fixture_id = pairs.fixture_id
        """,
        (player_ids, fixture_ids),
    )
    return {(player_id, fixture_id): value for player_id, fixture_id, value in cur.fetchall()}


def _populate_estimated_goal_rows(cur):
    """For every player with a real observed 'Anytime' goalscorer
    baseline, upserts an ESTIMATED score_probability row for every
    upcoming fixture their team plays that doesn't already have a REAL
    one - scaled by how that fixture's own team-strength signal compares
    to the one the baseline was observed under."""
    cur.execute(
        """
        select ppb.player_id, ppb.observed_probability, ppb.team_attack_score, p.team_id
        from player_prop_baselines ppb
        join players p on p.id = ppb.player_id
        where ppb.market ilike '%%Anytime%%'
        """
    )
    baselines = cur.fetchall()

    # Fetch each team's upcoming fixtures once (not once per baseline
    # player sharing that team) - see _fetch_existing_flags docstring.
    team_ids = {team_id for _, _, _, team_id in baselines}
    fixtures_by_team = {team_id: _upcoming_team_fixtures(cur, team_id) for team_id in team_ids}

    candidates = []
    for player_id, observed_prob, baseline_attack, team_id in baselines:
        baseline_attack = float(baseline_attack)
        if baseline_attack <= 0:
            continue
        for fixture_id, home_team_id, home_win_prob, away_win_prob in fixtures_by_team[team_id]:
            attack_score = float(home_win_prob) if team_id == home_team_id else float(away_win_prob)
            candidates.append((player_id, fixture_id, observed_prob, baseline_attack, attack_score))

    existing = _fetch_existing_flags(cur, [(c[0], c[1]) for c in candidates], "is_estimated")

    # Keyed by (player_id, fixture_id), not appended - execute_values'
    # single multi-row INSERT hard-errors ("ON CONFLICT DO UPDATE command
    # cannot affect row a second time") if the same conflict key appears
    # twice in one statement, unlike the old per-row loop this replaced,
    # which just upserted each in its own statement. A player could in
    # principle carry more than one baseline row matching this market
    # filter - last one wins, same as the old loop's overwrite order.
    by_key = {}
    for player_id, fixture_id, observed_prob, baseline_attack, attack_score in candidates:
        is_estimated = existing.get((player_id, fixture_id))
        if is_estimated is not None and not is_estimated:
            continue  # never overwrite a real observation with an estimate
        scaled = max(0.01, min(0.9, float(observed_prob) * (attack_score / baseline_attack)))
        by_key[(player_id, fixture_id)] = (player_id, fixture_id, scaled)
    rows_to_upsert = list(by_key.values())

    if rows_to_upsert:
        execute_values(
            cur,
            """
            insert into bookmaker_player_features
                (player_id, fixture_id, score_probability, is_estimated, source, confidence, market_observed_at)
            values %s
            on conflict (player_id, fixture_id) do update set
                score_probability = excluded.score_probability,
                is_estimated = true,
                source = excluded.source,
                confidence = excluded.confidence,
                computed_at = now()
            """,
            rows_to_upsert,
            template="(%s, %s, %s, true, 'sportmonks_baseline_scaled', 0.5, now())",
        )

    return len(rows_to_upsert)


def _populate_estimated_assist_rows(cur):
    """Mirrors _populate_estimated_goal_rows exactly, scaling
    assist_probability from a 'Player to Assist%' baseline instead of an
    'Anytime' goalscorer one, and gating/writing the assist_* provenance
    columns (migration 0069) instead of the shared is_estimated/source/
    confidence ones - so this pass never touches a fixture's goal
    provenance, or vice versa. assist_is_estimated is nullable (unlike
    is_estimated), so 'no row yet' (None) and 'a real value already
    exists' (False) are distinguishable - `is False` below is deliberate,
    not `not existing[0]`."""
    cur.execute(
        """
        select ppb.player_id, ppb.observed_probability, ppb.team_attack_score, p.team_id
        from player_prop_baselines ppb
        join players p on p.id = ppb.player_id
        where ppb.market ilike 'Player to Assist%%'
        """
    )
    baselines = cur.fetchall()

    team_ids = {team_id for _, _, _, team_id in baselines}
    fixtures_by_team = {team_id: _upcoming_team_fixtures(cur, team_id) for team_id in team_ids}

    candidates = []
    for player_id, observed_prob, baseline_attack, team_id in baselines:
        baseline_attack = float(baseline_attack)
        if baseline_attack <= 0:
            continue
        for fixture_id, home_team_id, home_win_prob, away_win_prob in fixtures_by_team[team_id]:
            attack_score = float(home_win_prob) if team_id == home_team_id else float(away_win_prob)
            candidates.append((player_id, fixture_id, observed_prob, baseline_attack, attack_score))

    # assist_is_estimated is nullable (unlike is_estimated) - "no row
    # yet" (None) and "a real value already exists" (False) are
    # distinguishable - `is False` below is deliberate, not `not`.
    existing = _fetch_existing_flags(cur, [(c[0], c[1]) for c in candidates], "assist_is_estimated")

    # Keyed by (player_id, fixture_id) - see the goal-rows function above
    # for why a plain list would risk a duplicate-conflict-key crash.
    by_key = {}
    for player_id, fixture_id, observed_prob, baseline_attack, attack_score in candidates:
        if existing.get((player_id, fixture_id)) is False:
            continue  # never overwrite a real observation with an estimate
        scaled = max(0.01, min(0.9, float(observed_prob) * (attack_score / baseline_attack)))
        by_key[(player_id, fixture_id)] = (player_id, fixture_id, scaled)
    rows_to_upsert = list(by_key.values())

    if rows_to_upsert:
        execute_values(
            cur,
            """
            insert into bookmaker_player_features
                (player_id, fixture_id, assist_probability, is_estimated, source, confidence,
                 assist_is_estimated, assist_source, assist_confidence, assist_market_observed_at)
            values %s
            on conflict (player_id, fixture_id) do update set
                assist_probability = excluded.assist_probability,
                assist_is_estimated = true,
                assist_source = excluded.assist_source,
                assist_confidence = excluded.assist_confidence,
                assist_market_observed_at = excluded.assist_market_observed_at,
                computed_at = now()
            """,
            rows_to_upsert,
            template="(%s, %s, %s, true, 'sportmonks_baseline_scaled', 0.5, true, 'sportmonks_baseline_scaled', 0.5, now())",
        )

    return len(rows_to_upsert)


def populate_estimated_hub_rows(cur):
    """The hub's fallback half - see _populate_estimated_goal_rows and
    _populate_estimated_assist_rows for the goal/assist-specific scaling
    logic they share the mechanics of. Returns the combined row count.

    Deliberately goal/assist only - booking_probability and
    expected_shots_on_target (added 2026-08-17) get NO estimated-fallback
    pass here: the team-attack-score scaling this uses is specifically an
    attacking-output signal, which is the wrong driver for booking
    probability (a discipline/referee-tendency signal, not an attacking
    one) and an unproven one for shots-on-target scaling this pass
    intentionally didn't build - both stay real-observation-only for now,
    same "fails safe as None, never a fabricated estimate" posture as
    every other unwired stat in compute_module_rate_bookmaker."""
    return _populate_estimated_goal_rows(cur) + _populate_estimated_assist_rows(cur)


def main():
    window_days = DEFAULT_PROP_WINDOW_DAYS
    if "--window-days" in sys.argv:
        window_days = int(sys.argv[sys.argv.index("--window-days") + 1])

    load_env()
    api_key = os.environ["SPORTMONKS_API_KEY"]
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        link_fixtures(cur, api_key, window_days)
        conn.commit()

        import_player_props(cur, api_key, window_days)
        conn.commit()

        hub_written = populate_estimated_hub_rows(cur)
        conn.commit()
        print(f"Hub: wrote {hub_written} estimated bookmaker_player_features row(s).")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
