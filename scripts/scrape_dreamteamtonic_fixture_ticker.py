"""
scrape_dreamteamtonic_fixture_ticker.py
-------------------------------------------
Real per-team projected cup/Europe fixtures (2026-08-27 user request:
"the fixture tickers show all the double gameweeks coming up... it
would massively help our fixture QUANTITY even when the game is not
populated themselves"). Target Score's Fixture Quantity sub-rating
(compute_target_scores.py's fetch_window_fixture_counts) only ever
counts REAL fixtures already in game_fixture_gameweeks - for a team
still alive in a cup or European competition, that row usually doesn't
exist until close to matchday (the opponent needs to be drawn, or -
for Europe's league phase - even though UEFA fixes the DATE well in
advance, the opponent isn't known until the draw).

Dream Team Tonic's own fixture ticker (/tools/sdt-fixtures) already
projects this - a cell shows TBA (date real/confirmed, opponent not
yet drawn) or IF (contingent on the team progressing past the current
round - genuinely uncertain). Dream Team only: confirmed directly by
the user that FanTeam/Cloud FF both only ever score Premier League
matches, regardless of what any other game's own ticker page displays.

This is a client-rendered React SPA - the raw fixture files behind it
(storage.googleapis.com/dttfixturelists/*.json, confirmed live) only
contain matches that are ALREADY confirmed/scored; the TBA/IF
projection itself is computed client-side from a calendar + "which
teams are still alive" logic never exposed as fetchable data. Hence
Playwright here, not a plain urllib fetch like this session's other
two scrapers (import_dreamteamtonic_starts.py, import_fixtures_odds.py)
- a real, heavier dependency, confirmed acceptable with the user.

Real DOM structure, confirmed live 2026-08-27:
  - <table><thead> has a "GW" row whose cells carry colspan (colspan=2
    on gameweek 3's header cell means gameweek 3 spans 2 real fixture
    columns - a real double gameweek, already reflected structurally).
  - <tbody> has one <tr> per team, each <td> aligned 1:1 with the flat
    per-column gameweek list the header's colspans expand into.
  - An empty/bye cell (no inner <span> at all) - not a real column for
    that team's competitions that week, skipped.
  - A real cell has <span>{text}</span>, optionally followed by a
    second small <span>{tag}</span> badge. {text} is a team code (a
    confirmed opponent) OR the literal "TBA" OR the literal "IF".
    {tag} (CL/EL/ECL/LC/FA) is present on BOTH confirmed cup cells and
    TBA/IF cells alike - only TBA/IF cells are new information here.

Team names already match this project's canonical teams.name almost
exactly (same finding as the tff/cloud GW-points sources) - resolved
via team_aliases (source 'dreamteamtonic_ticker'), same read-check-
then-insert pattern import_fixtures_odds.py's resolve_team_id uses.
Never auto-creates a team row - every name here is a current PL club.

Self-gates on its own last capture (skips if under STALENESS_HOURS
old) - team competition participation changes slowly, so this doesn't
need the twice-daily wrapup cadence; called unconditionally from
refresh_all.py's run_wrapup(), the gate keeps it a no-op on the second
daily cycle.

RUN:
    python3 scripts/scrape_dreamteamtonic_fixture_ticker.py
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
GAME_SLUG = "dreamteam"
TICKER_URL = "https://dreamteamtonic.co.uk/tools/sdt-fixtures"
ALIAS_SOURCE = "dreamteamtonic_ticker"
STALENESS_HOURS = 12

# Same one-off spelling gap found in import_dreamteamtonic_starts.py's
# own tff/cloud sources - this project's canonical teams.name is just
# "Brighton", the ticker's own full team-name column uses the longer
# real club name.
TEAM_NAME_OVERRIDES = {"Brighton & Hove Albion": "Brighton"}

COMP_TAG_MAP = {
    "CL": "soccer_uefa_champs_league",
    "EL": "soccer_uefa_europa_league",
    "ECL": "soccer_uefa_europa_conference_league",
    "LC": "soccer_england_efl_cup",
    "FA": "soccer_fa_cup",
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


def resolve_team_id(cur, raw_name):
    cur.execute("select team_id from team_aliases where source = %s and external_name = %s", (ALIAS_SOURCE, raw_name))
    row = cur.fetchone()
    if row:
        return row[0]
    canonical_name = TEAM_NAME_OVERRIDES.get(raw_name, raw_name)
    cur.execute("select id from teams where name = %s", (canonical_name,))
    row = cur.fetchone()
    if not row:
        return None
    team_id = row[0]
    cur.execute(
        "insert into team_aliases (team_id, source, external_name) values (%s, %s, %s) on conflict do nothing",
        (team_id, ALIAS_SOURCE, raw_name),
    )
    return team_id


def scrape_ticker():
    """Returns [{team_name, gameweek, competition, confidence}, ...] -
    pure browser automation, no DB access, so it's independently
    testable/inspectable against the real page."""
    from playwright.sync_api import sync_playwright

    rows = []
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        page.goto(TICKER_URL, wait_until="networkidle")
        page.wait_for_selector("table tbody tr")

        # Expand the header GW row's colspans into a flat per-column
        # gameweek number list - the SAME columns every team <tr>'s
        # <td> cells align to 1:1. The header row carrying real GW
        # numbers is identifiable by having plain integer text content,
        # unlike the sticky corner cells (blank) or the "GW" label cell.
        gw_columns = []
        for cell in page.query_selector_all("table thead th"):
            text = (cell.inner_text() or "").strip()
            colspan = int(cell.get_attribute("colspan") or "1")
            if text.isdigit():
                gw_columns.extend([int(text)] * colspan)

        team_rows = page.query_selector_all("table tbody tr")
        for tr in team_rows:
            cells = tr.query_selector_all("td")
            # First 3 <td>s are structural (checkbox, team name, real
            # fixture count) - confirmed live via the row's own outerHTML.
            name_cell = cells[1]
            full_name_span = name_cell.query_selector("span.hidden")
            team_name = (full_name_span.inner_text() if full_name_span else name_cell.inner_text()).strip()
            data_cells = cells[3:]

            for i, td in enumerate(data_cells):
                if i >= len(gw_columns):
                    break
                spans = td.query_selector_all("span")
                if not spans:
                    continue
                main_text = (spans[0].inner_text() or "").strip()
                if not main_text:
                    continue
                tag_text = (spans[1].inner_text() or "").strip() if len(spans) > 1 else None
                competition = COMP_TAG_MAP.get(tag_text)
                if competition is None:
                    continue
                # A real opponent code (e.g. "mil"), not just TBA/IF, is
                # ALSO real signal worth capturing here: the real opponent
                # being drawn doesn't mean our own fixtures table has the
                # fixture row yet (2026-08-27 user report - Newcastle's
                # confirmed GW3 League Cup tie v Millwall showing on this
                # ticker as "mil LC", not "TBA", days before our fixtures
                # table picked it up). Safe to widen past TBA/IF: fetch_
                # window_projected_fixtures (compute_target_scores.py)
                # only ever counts a row here when there's NO matching
                # real fixture in game_fixture_gameweeks yet, so once the
                # real importer catches up this stops contributing on its
                # own - no double-counting risk. Only "IF" stays half-
                # confidence (genuinely contingent on cup progression);
                # TBA and a confirmed opponent code are both a real,
                # date-fixed fixture from here.
                rows.append(
                    {
                        "team_name": team_name,
                        "gameweek": gw_columns[i],
                        "competition": competition,
                        "confidence": 0.5 if main_text == "IF" else 1.0,
                    }
                )
        browser.close()
    return rows


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select id from fantasy_games where slug = %s", (GAME_SLUG,))
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"Unknown game slug: {GAME_SLUG}")
        game_id = row[0]

        cur.execute("select max(captured_at) from dreamteamtonic_projected_fixtures where game_id = %s", (game_id,))
        latest = cur.fetchone()[0]
        if latest is not None and (datetime.now(timezone.utc) - latest) < timedelta(hours=STALENESS_HOURS):
            print(f"Last captured {latest.isoformat()} - under {STALENESS_HOURS}h old, skipping.")
            return

        entries = scrape_ticker()
        print(f"Scraped {len(entries)} TBA/IF cells from the ticker.")

        matched, unmatched = 0, 0
        seen = set()
        for e in entries:
            team_id = resolve_team_id(cur, e["team_name"])
            if team_id is None:
                unmatched += 1
                print(f"  [unmatched team] {e['team_name']!r}")
                continue
            matched += 1
            seen.add((team_id, e["gameweek"], e["competition"]))
            cur.execute(
                """
                insert into dreamteamtonic_projected_fixtures (game_id, team_id, gameweek, competition, confidence, captured_at)
                values (%s, %s, %s, %s, %s, now())
                on conflict (game_id, team_id, gameweek, competition) do update
                    set confidence = excluded.confidence, captured_at = now()
                """,
                (game_id, team_id, e["gameweek"], e["competition"], e["confidence"]),
            )

        # A cell that's flipped from TBA/IF to a real confirmed fixture
        # (or resolved out of the ticker entirely) must stop being
        # counted - same "must not silently survive" principle
        # clear_stale_target_scores already follows elsewhere in this
        # engine. Only prunes rows for gameweeks this run actually saw
        # entries for or already held data on, never a gameweek outside
        # the ticker's own displayed window.
        cur.execute("select distinct gameweek from dreamteamtonic_projected_fixtures where game_id = %s", (game_id,))
        known_gameweeks = {r[0] for r in cur.fetchall()}
        for gw in known_gameweeks:
            cur.execute(
                "select team_id, competition from dreamteamtonic_projected_fixtures where game_id = %s and gameweek = %s",
                (game_id, gw),
            )
            for team_id, competition in cur.fetchall():
                if (team_id, gw, competition) not in seen:
                    cur.execute(
                        "delete from dreamteamtonic_projected_fixtures where game_id = %s and team_id = %s and gameweek = %s and competition = %s",
                        (game_id, team_id, gw, competition),
                    )

        conn.commit()
        print(f"{matched} matched, {unmatched} unmatched.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
