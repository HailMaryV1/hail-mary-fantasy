"""
capture_ffscout_player_status.py
----------------------------------
Live Premier League team news from fantasyfootballscout.co.uk/team-news
(real, public, unauthenticated page - no API, HTML only), 2026-08-19 user
request to close the "zero live signal at all" gap for Dream Team and
Cloud FF - compute_projections.py's fetch_live_status() has always
hard-returned {} for them; only FanTeam and EFL Fantasy have their own
platform live-status feed. FFScout covers the real Premier League, which
in this project's current data is Dream Team/FanTeam/Cloud FF (NOT EFL
Fantasy - Championship/League One/League Two, out of scope for this
source - confirmed 2026-08-19: Burnley/West Ham/Wolves are Championship
this season, Coventry/Hull/Ipswich are Premier League, see memory
feedback_2026_27_relegation_promotion.md).

Real markup confirmed live (2026-08-19): 20 `li.team-news-item[data-team-
code]` sections, each h2-titled by club name (19/20 match teams.name
exactly; "Brighton and Hove Albion" needs FFSCOUT_TEAM_NAME_OVERRIDES).
Inside, `ul.story-parts > li.headers` holds three categories (Out/Doubts/
Banned) via a `<strong>` label - the nested `ul.players` is ABSENT
ENTIRELY when a category is empty, not an empty tag. Doubt rows are
`<li>Name<span class="doubt-percent">75%</span></li>` - name and
percentage are separate DOM nodes, extracted by pulling the span's text
first then reading what's left. A stray HTML-comment-wrapped leftover
narrative block was observed sitting next to live data on one club's
section - BeautifulSoup naturally ignores it as a comment; a whole-page
regex would not.

Player matching reuses scripts/name_matching.py's surname_key/
surname_variants (accent-table transliteration, hyphen-boundary-safe
truncation) - NOT scripts/import_lineup_probability.py's own local
surname_key()/match_player(), confirmed to be an independent, drifted,
strictly worse duplicate (no accent table). Team-scoped candidate query +
exact-match-wins-over-substring cascade. player_id stays NULL on
an ambiguous/no match rather than a guess - raw_name is always kept so a
later re-match never loses information (same discipline as
import_lineup_probability.py).

RUN:
    python3 scripts/capture_ffscout_player_status.py
"""
import os
import subprocess
import sys
import urllib.request
from datetime import date
from pathlib import Path

import psycopg2
import psycopg2.extras
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from name_matching import compact, surname_key, surname_variants  # noqa: E402

TEAM_NEWS_URL = "https://www.fantasyfootballscout.co.uk/team-news"
SOURCE = "ffscout"

# Confirmed live 2026-08-19 - 19/20 club h2 names match teams.name exactly;
# only this one needs an override (same override-table pattern as
# import_sportmonks_player_props.py's SPORTMONKS_TEAM_NAME_OVERRIDES).
FFSCOUT_TEAM_NAME_OVERRIDES = {
    "Brighton and Hove Albion": "Brighton",
}

CATEGORY_BY_LABEL = {"Out:": "out", "Doubts:": "doubt", "Banned:": "banned"}


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


def fetch_page():
    req = urllib.request.Request(TEAM_NEWS_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    return raw.decode("utf-8")


def parse_team_news(html):
    """[(club_name, [(raw_name, status, start_probability_or_None), ...])]
    - one entry per club section, one row per Out/Doubt/Banned player."""
    soup = BeautifulSoup(html, "html.parser")
    clubs = []
    for section in soup.select("li.team-news-item"):
        h2 = section.find("h2")
        if not h2:
            continue
        club_name = h2.get_text(strip=True)
        story = section.select_one("ul.story-parts")
        if not story:
            clubs.append((club_name, []))
            continue
        rows = []
        for header_li in story.select("li.headers"):
            strong = header_li.find("strong")
            if not strong:
                continue
            status = CATEGORY_BY_LABEL.get(strong.get_text(strip=True))
            if status is None:
                continue
            players_ul = header_li.find("ul", class_="players")
            if not players_ul:
                continue
            for li in players_ul.find_all("li"):
                pct = None
                span = li.find("span", class_="doubt-percent")
                if span:
                    pct_text = span.get_text(strip=True).rstrip("%")
                    span.extract()
                    try:
                        pct = float(pct_text)
                    except ValueError:
                        pct = None
                raw_name = li.get_text(strip=True)
                if raw_name:
                    rows.append((raw_name, status, pct))
        clubs.append((club_name, rows))
    return clubs


def resolve_team_id(cur, ffscout_name):
    """Same 'source' aliasing pattern as import_sportmonks_player_props.py's
    resolve_team_id - never inserts a new team row on a miss (every
    Premier League club already exists here), a miss means the name needs
    an override entry."""
    cur.execute(
        "select team_id from team_aliases where source = %s and external_name = %s",
        (SOURCE, ffscout_name),
    )
    row = cur.fetchone()
    if row:
        return row["team_id"]

    canonical_name = FFSCOUT_TEAM_NAME_OVERRIDES.get(ffscout_name, ffscout_name)
    cur.execute("select id from teams where name = %s", (canonical_name,))
    row = cur.fetchone()
    if not row:
        return None
    team_id = row["id"]
    cur.execute(
        "insert into team_aliases (team_id, source, external_name) values (%s, %s, %s) on conflict do nothing",
        (team_id, SOURCE, ffscout_name),
    )
    return team_id


def match_player(cur, team_id, raw_name):
    """Exactly one confident player_id, or None - never a guess among
    several candidates (see module docstring).

    FFScout's raw_name is already a bare surname ("van den Berg",
    "Fatawu"), not "Firstname Surname" - so it's compared directly
    (compact(raw_name)) against each candidate's real surname_key/
    surname_variants, rather than running raw_name itself through
    name_matching's surname_key()/surname_variants(). Those two assume a
    first-name prefix IS present and strip the first word off before
    keying - correct for the candidate's own full_name, but would wrongly
    treat "van" as a first name in "van den Berg" and mangle it to "den
    Berg" (confirmed live: this exact case silently failed to match
    Brentford's real Sepp van den Berg before this was caught)."""
    cur.execute("select id, full_name from players where team_id = %s", (team_id,))
    pool = cur.fetchall()

    raw_compact = compact(raw_name)
    if not raw_compact:
        return None

    for row in pool:
        if compact(row["full_name"]) == raw_compact:
            return row["id"]

    candidates = [row for row in pool if surname_key(row["full_name"]) == raw_compact]
    if len(candidates) == 1:
        return candidates[0]["id"]
    if len(candidates) > 1:
        return None

    candidates = [row for row in pool if raw_compact in surname_variants(row["full_name"])]
    if len(candidates) == 1:
        return candidates[0]["id"]
    return None


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"], cursor_factory=psycopg2.extras.RealDictCursor)
    cur = conn.cursor()
    snapshot_date = date.today()

    try:
        html = fetch_page()
        clubs = parse_team_news(html)

        written, matched, unmatched, skipped_clubs = 0, 0, 0, 0
        unmatched_rows = []
        for club_name, rows in clubs:
            try:
                team_id = resolve_team_id(cur, club_name)
            except Exception as e:
                print(f"  [skip club] {club_name}: {e}")
                skipped_clubs += 1
                continue
            if not team_id:
                print(f"  [skip club] unknown team: {club_name!r} - add a FFSCOUT_TEAM_NAME_OVERRIDES entry")
                skipped_clubs += 1
                continue
            for raw_name, status, pct in rows:
                try:
                    player_id = match_player(cur, team_id, raw_name)
                except Exception as e:
                    print(f"  [skip row] {club_name} {raw_name!r}: {e}")
                    continue
                if player_id:
                    matched += 1
                else:
                    unmatched += 1
                    unmatched_rows.append((club_name, raw_name, status))
                cur.execute(
                    """
                    insert into ffscout_player_status
                        (player_id, team_id, raw_name, status, start_probability, snapshot_date, source, captured_at)
                    values (%s, %s, %s, %s, %s, %s, %s, now())
                    on conflict (team_id, raw_name, snapshot_date, source) do update
                        set player_id = excluded.player_id, status = excluded.status,
                            start_probability = excluded.start_probability, captured_at = excluded.captured_at
                    """,
                    (player_id, team_id, raw_name, status, pct, snapshot_date, SOURCE),
                )
                written += 1

        conn.commit()
        print(
            f"\nFFScout team news captured for {snapshot_date}: {written} rows written "
            f"({matched} matched to a real player_id, {unmatched} unmatched, {skipped_clubs} clubs skipped)."
        )
        if unmatched_rows:
            print("\nUnmatched (left as player_id = NULL, raw_name preserved):")
            for club_name, raw_name, status in unmatched_rows:
                print(f"  [{club_name} {status}] {raw_name!r}")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()

    # A newly-captured status only reaches real projected scores once
    # compute_projections.py re-runs for the affected games - same
    # "capture updates the table, recompute applies it to scores" split as
    # capture_eflfantasy_player_status.py. Only the NEAREST upcoming
    # gameweek per game, not refresh_all.py's full recompute_section()
    # (up to MAX_GAMEWEEKS_AHEAD=5 gameweeks) - team news is inherently
    # about who plays THIS week; a gameweek 5 weeks out will get entirely
    # different news by the time it matters, and this app-generated
    # signal has no business overriding pure historical shrinkage that
    # far ahead anyway. Real incident 2026-08-19: recomputing 3 games x 5
    # gameweeks each (up to 15 full compute_projections.py runs) blew
    # through this workflow's timeout and got cancelled mid-run - each
    # game's own recompute alone routinely takes 15-20+ minutes (see
    # refresh_fanteam.yml/refresh_cloudff.yml's own real run durations).
    # This also shrinks the collision window against the regular
    # twice-daily per-game refresh workflows recomputing the same tables.
    sys.path.insert(0, str(ROOT / "scripts"))
    from refresh_all import run_step, upcoming_gameweeks  # noqa: E402

    # upcoming_gameweeks() needs its own live connection - the one used
    # for scraping/matching above is already closed by this point.
    recompute_conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        for game_slug, label in (("dreamteam", "Dream Team"), ("fanteam", "FanTeam"), ("cloudff", "Cloud FF")):
            gameweeks = upcoming_gameweeks(recompute_conn, game_slug)[:1]
            if not gameweeks:
                print(f"\nNo upcoming {label} gameweek found - skipping score recompute.")
                continue
            run_step(f"Recompute {label} GW{gameweeks[0]}", ["scripts/compute_projections.py", game_slug, "--gameweek", str(gameweeks[0])])
    finally:
        recompute_conn.close()


if __name__ == "__main__":
    main()
