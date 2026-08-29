"""
scrape_spreadex_shots_on_target.py
--------------------------------------
Real per-player "shots on target" market from Spreadex's own retail
betting site (2026-08-29 user request, after DreamTeamTonic's own
Market Odds tool was confirmed to only surface scorer/assist markets -
"is there anyway we can have a look for the shot on target odds through
spreadex directly?"). This is the one SportMonks player-prop market
DreamTeamTonic doesn't carry at all.

IMPORTANT - read before touching this file. Unlike every other DTT/
Spreadex integration in this project, this one scrapes a licensed
bookmaker's own retail site directly (spreadex.com), not a fantasy-
content site's API. Confirmed live 2026-08-29 that this is genuinely
more fragile than anything else here:
  - spreadex.com is an Angular SPA (auto-generated `_ngcontent-ng-c...`
    class names - NOT stable across deploys) whose live odds stream
    over a SignalR/WebSocket model-hub, not a plain REST API like DTT's
    dtt-data-api. There is no clean JSON snapshot endpoint to call.
  - Fixture pages have real, human-readable URLs (/sports/en-GB/spread-
    betting/football/{competition-slug}/{home}-v-{away}/fo/p{id}), but
    the numeric {id} is NOT derivable from team names alone (confirmed
    live - navigating to a real slug with a wrong id silently redirects
    to the homepage) - there is no sitemap.xml either. The only way to
    get a fixture's real id is to click through the competition's own
    listing page and read the resulting URL, same as a real user would.
  - The one genuinely stable thing found: every price button carries a
    real, semantic aria-label - "{Player Name} - {N}+ Price Button" -
    and its own textContent is the fractional odds (e.g. "2/9"). This
    survives visual/CSS changes far better than class-name or pixel-
    coordinate selectors would, but is still reading a live retail
    betting UI, not a versioned data contract - EXPECT this to need
    repair the next time Spreadex redesigns their site.
  - The user was told this before asking to proceed, and confirmed:
    "Yes, build it anyway."

Scope: Premier League, Championship, League One - matches DreamTeamTonic's
own hasPlayerMarkets:true competitions (efl_league_two has no player
markets on DTT's Spreadex feed either, so not expected to be worth the
extra scrape time here).

Only the "1+" line is used (P(shots on target >= 1)), same as
SportMonks' own "Player Shots On Target" market did - converted to
E[shots on target] via the identical Poisson maths compute_projections.py's
anytime_prob_to_expected_goals already uses (duplicated here, not
imported, matching how import_sportmonks_player_props.py already
duplicated this exact formula rather than cross-importing between
standalone scripts).

RUN:
    python3 scripts/scrape_spreadex_shots_on_target.py
"""

import math
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
LOOKAHEAD_DAYS = 10  # shots-on-target lines, like any player prop, only post close to kickoff - see import_sportmonks_player_props.py's own DEFAULT_PROP_WINDOW_DAYS precedent.

# Competition -> (Spreadex URL slug used in fixture pages, listing page URL
# to click through for real fixture ids). Premier League/Championship have
# their own dedicated league page; League One's real fixture list lives
# inside the "football-popular" page's own expandable accordion (confirmed
# live 2026-08-29 - no separate league/{id}/fo/c66 URL was found for it).
COMPETITIONS = {
    "soccer_epl": {"slug": "premier-league", "listing_url": "https://www.spreadex.com/sports/en-GB/spread-betting/football/league/47/fo/c66"},
    "efl_championship": {"slug": "championship", "listing_url": "https://www.spreadex.com/sports/en-GB/spread-betting/football/league/2532/fo/c66"},
    "efl_league_one": {"slug": "league-1", "listing_url": "https://www.spreadex.com/sports/en-GB/spread-betting/football/footballpopular/fo/c66"},
}

# Same short-name convention as import_dreamteamtonic_market_odds.py's
# TEAM_NAME_OVERRIDES (Spreadex/DTT share the same underlying odds
# provider naming) - kept as its own copy here since this is a genuinely
# separate scrape mechanism (browser automation, not a JSON fetch), not
# because the names are expected to differ.
TEAM_NAME_OVERRIDES = {
    "Blackburn Rovers": "Blackburn", "Queens Park Rangers": "QPR", "Bolton Wanderers": "Bolton",
    "Lincoln City": "Lincoln", "Cardiff City": "Cardiff", "Sheffield United": "Sheff Utd",
    "Charlton Athletic": "Charlton", "Preston North End": "Preston", "Norwich City": "Norwich",
    "West Ham United": "West Ham", "West Bromwich Albion": "West Brom", "Derby County": "Derby",
    "Swansea City": "Swansea", "Wolverhampton Wanderers": "Wolves", "Stoke City": "Stoke",
    "Peterborough United": "Peterborough", "Leicester City": "Leicester", "Cambridge United": "Cambridge",
    "Huddersfield Town": "Huddersfield", "Burton Albion": "Burton", "Plymouth Argyle": "Plymouth",
    "Bradford City": "Bradford", "Sheffield Wednesday": "Sheff Wed", "Doncaster Rovers": "Doncaster",
    "Stockport County": "Stockport", "Wycombe Wanderers": "Wycombe", "AFC Wimbledon": "Wimbledon",
    "Wigan Athletic": "Wigan", "Mansfield Town": "Mansfield", "Luton Town": "Luton",
    "Cheltenham Town": "Cheltenham", "Crewe Alexandra": "Crewe", "Rotherham United": "Rotherham",
    "Colchester United": "Colchester", "Crawley Town": "Crawley", "Northampton Town": "Northampton",
    "Grimsby Town": "Grimsby", "Fleetwood Town": "Fleetwood", "Newport County": "Newport",
    "Tranmere Rovers": "Tranmere", "Oldham Athletic": "Oldham", "Swindon Town": "Swindon",
    "Shrewsbury Town": "Shrewsbury", "Salford City": "Salford", "Accrington Stanley": "Accrington",
    "Exeter City": "Exeter", "Coventry City": "Coventry", "Hull City": "Hull",
    "Tottenham Hotspur": "Tottenham", "Newcastle United": "Newcastle", "Leeds United": "Leeds",
    "Manchester United": "Man Utd", "Ipswich Town": "Ipswich", "Manchester City": "Man City",
    "Bournemouth": "Bournemouth", "Brighton": "Brighton", "MK Dons": "MK Dons",
}


def spreadex_name(our_name):
    return TEAM_NAME_OVERRIDES.get(our_name, our_name)


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


def fractional_to_probability(fractional_odds):
    """'2/9' -> decimal odds 1 + 2/9 -> raw implied probability 1/decimal.
    Same "1/price" fallback shape import_sportmonks_player_props.py's own
    parse_probability() already uses when no explicit probability field
    exists - includes bookmaker margin, same known/accepted limitation."""
    if fractional_odds.strip().lower() == "evs":
        numerator, denominator = 1, 1
    else:
        parts = fractional_odds.strip().split("/")
        if len(parts) != 2:
            return None
        try:
            numerator, denominator = float(parts[0]), float(parts[1])
        except ValueError:
            return None
    if denominator <= 0:
        return None
    decimal_odds = 1 + numerator / denominator
    return 1.0 / decimal_odds


def anytime_prob_to_expected_count(p):
    """Identical maths to compute_projections.py's anytime_prob_to_expected_goals."""
    p = max(0.0, min(0.99, p))
    return -math.log(1 - p) if p > 0 else 0.0


def resolve_player_id(cur, name, team_ids):
    cur.execute("select id from players where full_name = %s and team_id = any(%s)", (name, list(team_ids)))
    rows = cur.fetchall()
    return rows[0][0] if len(rows) == 1 else None


def extract_shots_on_target(page):
    """Runs inside the fixture page - finds the real "Player Shots On
    Target" panel (NOT "Player Shots", a different market that also has
    a "1+" line) by walking up from its own header text, then reads every
    "{Player} - 1+ Price Button" element inside just that panel. See this
    module's own docstring for why aria-label + textContent, not CSS
    classes or text position, is used here."""
    return page.evaluate(
        """
        () => {
            const header = [...document.querySelectorAll('*')].find(
                el => el.children.length === 0 && el.textContent.trim() === 'Player Shots On Target'
            );
            if (!header) return [];
            let container = header;
            for (let i = 0; i < 12 && container; i++) {
                if (container.querySelectorAll('fo-price-wrapper-button').length > 5) break;
                container = container.parentElement;
            }
            if (!container) return [];
            const buttons = [...container.querySelectorAll('fo-price-wrapper-button[aria-label*=" - 1+ Price Button"]')];
            return buttons.map(b => ({
                label: b.getAttribute('aria-label'),
                price: b.textContent.trim(),
            }));
        }
        """
    )


def scrape_fixture(page, url, our_fixture_id, home_team_id, away_team_id, cur):
    page.goto(url, wait_until="networkidle", timeout=30000)
    # "Shots" tab isn't the default view - the market only renders once
    # selected. Confirmed live: the tab is a plain text button.
    try:
        page.get_by_text("Shots", exact=True).first.click(timeout=10000)
        page.wait_for_timeout(1500)
    except Exception:
        return 0, []

    rows = extract_shots_on_target(page)
    written = 0
    unmatched = []
    for row in rows:
        m = re.match(r"^(.*) - 1\+ Price Button$", row["label"] or "")
        if not m:
            continue
        player_name = m.group(1).strip()
        probability = fractional_to_probability(row["price"])
        if probability is None:
            continue
        player_id = resolve_player_id(cur, player_name, (home_team_id, away_team_id))
        if player_id is None:
            unmatched.append(player_name)
            continue
        expected_sot = anytime_prob_to_expected_count(probability)
        cur.execute(
            """
            insert into bookmaker_player_features
                (player_id, fixture_id, expected_shots_on_target, is_estimated, source, confidence,
                 shots_on_target_is_estimated, shots_on_target_source, shots_on_target_confidence,
                 shots_on_target_market_observed_at)
            values (%s, %s, %s, false, 'spreadex_scrape', 1.0, false, 'spreadex_scrape', 1.0, now())
            on conflict (player_id, fixture_id) do update set
                expected_shots_on_target = excluded.expected_shots_on_target,
                shots_on_target_is_estimated = false,
                shots_on_target_source = excluded.shots_on_target_source,
                shots_on_target_confidence = excluded.shots_on_target_confidence,
                shots_on_target_market_observed_at = excluded.shots_on_target_market_observed_at,
                computed_at = now()
            """,
            (player_id, our_fixture_id, round(expected_sot, 4)),
        )
        written += 1
    return written, unmatched


def find_and_click_fixture(page, home_spreadex_name, away_spreadex_name):
    """Clicks the real fixture row on a listing/accordion page and
    returns the resulting fixture URL - the only way to discover
    Spreadex's own numeric fixture id (see module docstring)."""
    pattern = re.compile(rf"^{re.escape(home_spreadex_name)}\s+v\s+{re.escape(away_spreadex_name)}", re.IGNORECASE)
    locator = page.get_by_text(pattern).first
    if locator.count() == 0:
        return None
    locator.click(timeout=10000)
    page.wait_for_url(re.compile(r"/fo/p\d+"), timeout=10000)
    return page.url


def main():
    from playwright.sync_api import sync_playwright

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        now = datetime.now(timezone.utc)
        cur.execute(
            """
            select f.id, ht.name, at.name, f.competition, f.home_team_id, f.away_team_id
            from fixtures f
            join teams ht on ht.id = f.home_team_id
            join teams at on at.id = f.away_team_id
            where f.competition in %s and f.kickoff_at >= %s and f.kickoff_at < %s
            order by f.kickoff_at
            """,
            (tuple(COMPETITIONS.keys()), now, now + timedelta(days=LOOKAHEAD_DAYS)),
        )
        our_fixtures = cur.fetchall()
        print(f"{len(our_fixtures)} upcoming fixtures across {len(COMPETITIONS)} competitions to try against Spreadex.")

        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()

            total_written, total_unmatched = 0, []
            no_fixture_found = []

            for competition, cfg in COMPETITIONS.items():
                comp_fixtures = [f for f in our_fixtures if f[3] == competition]
                if not comp_fixtures:
                    continue
                page.goto(cfg["listing_url"], wait_until="networkidle", timeout=30000)
                # League One's real fixtures live inside a collapsed
                # accordion on the shared "football-popular" page -
                # confirmed live, needs an explicit expand click; Premier
                # League/Championship's own dedicated pages show fixtures
                # already expanded.
                if competition == "efl_league_one":
                    try:
                        page.get_by_text("League 1", exact=True).first.click(timeout=10000)
                        page.wait_for_timeout(1000)
                    except Exception:
                        pass

                for fixture_id, home_name, away_name, _comp, home_team_id, away_team_id in comp_fixtures:
                    home_sx, away_sx = spreadex_name(home_name), spreadex_name(away_name)
                    fixture_url = find_and_click_fixture(page, home_sx, away_sx)
                    if fixture_url is None:
                        no_fixture_found.append((competition, home_sx, away_sx))
                        # Re-open the listing page for the next fixture -
                        # a failed click leaves us wherever we ended up.
                        page.goto(cfg["listing_url"], wait_until="networkidle", timeout=30000)
                        if competition == "efl_league_one":
                            try:
                                page.get_by_text("League 1", exact=True).first.click(timeout=10000)
                                page.wait_for_timeout(1000)
                            except Exception:
                                pass
                        continue

                    written, unmatched = scrape_fixture(page, fixture_url, fixture_id, home_team_id, away_team_id, cur)
                    total_written += written
                    total_unmatched.extend(unmatched)
                    print(f"  {home_sx} v {away_sx}: {written} shots-on-target rows written" + (f" ({len(unmatched)} unmatched player name(s))" if unmatched else ""))
                    conn.commit()

                    # Real courtesy delay between fixture pages - this is
                    # a live retail betting site, not a versioned API;
                    # scraping it politely matters more here than
                    # anywhere else in this project.
                    time.sleep(2)

                    page.goto(cfg["listing_url"], wait_until="networkidle", timeout=30000)
                    if competition == "efl_league_one":
                        try:
                            page.get_by_text("League 1", exact=True).first.click(timeout=10000)
                            page.wait_for_timeout(1000)
                        except Exception:
                            pass

            browser.close()

        print(f"\nDone: {total_written} shots-on-target rows written.")
        if no_fixture_found:
            print(f"\n{len(no_fixture_found)} fixture(s) not found on Spreadex's own listing (name mismatch or not posted yet):")
            for competition, home_sx, away_sx in no_fixture_found:
                print(f"    [{competition}] {home_sx} v {away_sx}")
        if total_unmatched:
            unique_unmatched = sorted(set(total_unmatched))
            print(f"\n{len(unique_unmatched)} distinct player name(s) didn't resolve to exactly one player_id:")
            for name in unique_unmatched[:30]:
                print(f"    '{name}'")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
