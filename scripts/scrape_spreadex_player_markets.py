"""
scrape_spreadex_player_markets.py
--------------------------------------
Real per-player betting markets from Spreadex's own retail site
(spreadex.com) - shots on target, fouls committed, tackles, real
confirmed lineups/formations, and the match-level Total Cards
Over/Under market (used to derive the bookmaker's own margin). One
page visit per fixture covers all of it.

2026-08-29: started as shots-on-target only (DreamTeamTonic's own
Market Odds tool was confirmed to only carry scorer/assist markets).
2026-08-30: extended for the Fouls board (real user request - "switch
the pipeline for the fouls board to bring from spreadex... I want the
Tackles and Fouls prices and markets to indicate players likely to be
in the battle and higher chance of committing fouls"). SportMonks'
"Player To Be Fouled" market (the reciprocal side the old tool used for
a cross-board conservation check) has NO Spreadex equivalent - checked
directly, a full scroll-through of a real fixture page found only
"Player Fouls Committed". That's not treated as a blocker: the
existing per-player historical model (frontend-v2/src/lib/foulModel.ts)
already estimates fouls SUFFERED independently of any bookmaker market,
and its own crosswise opponent-adjustment (a player's suffered rate
scales with the OPPONENT's committed rate) is exactly where a live,
match-specific signal plugs in - real Fouls Committed and Tackles data
for tonight's actual opponent lineup, not a stale season average. See
frontend-v2/src/lib/spreadexFouls.ts for the read side of this.

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

Lineups come from TWO views on the same page, joined by shirt number -
neither is complete alone. "List View" (sx-mc-team-line-ups-player)
gives the real full player name, position letter (G/D/M/F starters,
S subs) and shirt number, but no pitch position. "Pitch View"
(sx-mc-pitch-view-player) gives the real formation grid (which "line"
from goal to attack, and index within that line - see
extract_lineups()'s own comment) but TRUNCATES long names (confirmed
live: "Jeremie Frimpong" renders as "Frimpon'" there) - unusable for
player-id matching on its own. Shirt number is the only reliable key
between the two.

Scope: Premier League, Championship, League One - matches DreamTeamTonic's
own hasPlayerMarkets:true competitions (efl_league_two has no player
markets on DTT's Spreadex feed either, so not expected to be worth the
extra scrape time here).

Only the "1+" line of Shots On Target is used (P(shots on target >= 1)),
converted to E[shots on target] via the identical Poisson maths
compute_projections.py's anytime_prob_to_expected_goals already uses.
Fouls Committed and Tackles keep every priced line (1+ through 4+) -
the fouls tool wants the whole ladder shape, not just a single expected
count.

RUN:
    python3 scripts/scrape_spreadex_player_markets.py
"""

import math
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
LOOKAHEAD_DAYS = 10  # player props, like any bookmaker market, only post close to kickoff - see import_sportmonks_player_props.py's own DEFAULT_PROP_WINDOW_DAYS precedent.

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

# market label used in the page's own section header -> (fixture_player_props
# market name, max line to keep). Shots On Target only ever kept the 1+ line
# (converted to an expected count, see anytime_prob_to_expected_count); Fouls
# Committed and Tackles keep the whole ladder, which is what the fouls tool's
# own PlayerLadder shape wants.
LADDER_MARKETS = {
    "Player Shots On Target": {"db_market": "Shots On Target", "max_line": 1},
    "Player Fouls Committed": {"db_market": "Fouls Committed", "max_line": 4},
    "Player Tackles": {"db_market": "Tackles", "max_line": 4},
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


def fractional_to_decimal(fractional_odds):
    """'2/9' -> 1.222. Same conversion used throughout this file."""
    text = (fractional_odds or "").strip()
    if text.lower() == "evs":
        numerator, denominator = 1.0, 1.0
    else:
        parts = text.split("/")
        if len(parts) != 2:
            return None
        try:
            numerator, denominator = float(parts[0]), float(parts[1])
        except ValueError:
            return None
    if denominator <= 0:
        return None
    return 1 + numerator / denominator


def fractional_to_probability(fractional_odds):
    """'2/9' -> decimal odds 1 + 2/9 -> raw implied probability 1/decimal.
    Same "1/price" fallback shape import_sportmonks_player_props.py's own
    parse_probability() already uses when no explicit probability field
    exists - includes bookmaker margin, same known/accepted limitation."""
    dec = fractional_to_decimal(fractional_odds)
    return 1.0 / dec if dec else None


def anytime_prob_to_expected_count(p):
    """Identical maths to compute_projections.py's anytime_prob_to_expected_goals."""
    p = max(0.0, min(0.99, p))
    return -math.log(1 - p) if p > 0 else 0.0


def resolve_player_id(cur, name, team_ids):
    cur.execute("select id from players where full_name = %s and team_id = any(%s)", (name, list(team_ids)))
    rows = cur.fetchall()
    return rows[0][0] if len(rows) == 1 else None


def extract_ladder_market(page, header_text):
    """Runs inside the fixture page - finds a real "Player {X}" panel by
    walking up from its own header text, then reads every real
    "{Player} - {N}+ Price Button" element inside just that panel (never
    a same-named market elsewhere on the page - e.g. "Player Shots" vs
    "Player Shots On Target" both have "1+" lines with an otherwise
    identical aria-label shape, see this module's own docstring).

    The panel truncates to a preview and shows a real "See N more markets"
    link rather than rendering every priced player - confirmed live
    2026-08-30 on Sunderland v Fulham: the correct "Player Fouls Committed"
    panel container had 29 price buttons already rendered (~7-8 players'
    worth of rungs) plus a literal "See 72 more markets" link sitting
    inside the same container. (An earlier fix wrongly assumed this was a
    virtual-scrolled list and added a scroll loop, which changed nothing -
    scrolling never triggers a click-to-expand link.) Clicks it, and keeps
    clicking whatever "See N more" link remains, until no more link text is
    found or a real cap is hit."""
    return page.evaluate(
        """
        async (headerText) => {
            const header = [...document.querySelectorAll('*')].find(
                el => el.children.length === 0 && el.textContent.trim() === headerText
            );
            if (!header) return [];
            let container = header;
            for (let i = 0; i < 12 && container; i++) {
                if (container.querySelectorAll('fo-price-wrapper-button').length > 5) break;
                container = container.parentElement;
            }
            if (!container) return [];

            const findSeeMore = () => [...container.querySelectorAll('*')].find(
                el => el.children.length === 0 && /^see \\d+ more/i.test(el.textContent.trim())
            );

            for (let i = 0; i < 10; i++) {
                const link = findSeeMore();
                if (!link) break;
                const clickable = link.closest('button, a, [role="button"]') || link;
                clickable.click();
                await new Promise(r => setTimeout(r, 500));
            }

            const seen = new Map();
            for (const b of container.querySelectorAll('fo-price-wrapper-button[aria-label*=" - "][aria-label*="+ Price Button"]')) {
                const label = b.getAttribute('aria-label');
                if (!seen.has(label)) seen.set(label, b.textContent.trim());
            }
            return [...seen.entries()].map(([label, price]) => ({ label, price }));
        }
        """,
        header_text,
    )


def ensure_panel_expanded(page, header_text):
    """Some market panels render already expanded (Shots On Target,
    confirmed live), others render collapsed and need an explicit click
    (Fouls Committed and Tackles under the "Cards" tab, confirmed live
    2026-08-30 - the first version of this script got 0 rows for both
    because it never opened them). Checks whether the panel already has
    real price buttons before clicking anything - blindly clicking an
    ALREADY-expanded panel toggles it shut instead (the exact bug
    expand_league_one_accordion's own docstring documents for a
    different panel), so this must never click unconditionally."""
    if extract_ladder_market(page, header_text):
        return  # already expanded, nothing to do
    try:
        header = page.get_by_text(header_text, exact=True).first
        header.scroll_into_view_if_needed(timeout=8000)
        page.wait_for_timeout(500)
        header.click(timeout=8000)
        page.wait_for_timeout(1200)
    except Exception:
        pass


def extract_total_cards_ou(page):
    """Match-level "Total Cards - Over/Under" ladder - a genuine two-way
    market (both an Over AND an Under price at each line), unlike the
    player ladders above which only ever publish the "yes" side. Used to
    derive the bookmaker's own margin the same way sportmonksFouls.ts's
    old deriveOverround() did from SportMonks' two-way player-prop
    markets - see spreadexFouls.ts's own deriveOverround for the maths."""
    return page.evaluate(
        """
        () => {
            const buttons = [...document.querySelectorAll('fo-price-wrapper-button[aria-label*=" Cards Price Button"]')];
            return buttons.map(b => ({
                label: b.getAttribute('aria-label'),
                price: b.textContent.trim(),
            }));
        }
        """
    )


def extract_list_view(page):
    """Real full player name, position letter (G/D/M/F starters, S
    subs) and shirt number, from the "List View" toggle of Team-Line-
    Ups. Returns [[{halfIdx, name, positionLetter, shirt}, ...], ...]
    (one inner list per team) - half 0/1 order matches the page's own
    home/away layout (confirmed live: the left-hand team is always the
    fixture's home side). MUST be called while List View is the active
    toggle - see scrape_fixture for why this and extract_pitch_view
    can't be called back to back without re-selecting each view first,
    Angular unmounts the other one's elements on switch."""
    return page.evaluate(
        """
        () => {
            const halves = [...document.querySelectorAll('div.football.w-\\\\[50\\\\%\\\\]')].slice(0, 2);
            return halves.map((half, halfIdx) => {
                const players = [...half.querySelectorAll('sx-mc-team-line-ups-player')];
                return players.map(p => {
                    const text = p.textContent.replace(/\\s+/g, ' ').trim();
                    const m = text.match(/^(.*)\\s+\\(([GDMF S])\\)\\s+(\\d+)$/);
                    if (!m) return null;
                    return { halfIdx, name: m[1].trim(), positionLetter: m[2].trim(), shirt: parseInt(m[3], 10) };
                }).filter(Boolean);
            });
        }
        """
    )


def extract_pitch_view(page):
    """Real formation grid position per shirt number - lineIdx is the
    "line" from goal (0) to attack (highest), pos is the index within
    that line (used for lateral positioning), rowWidth is how many
    players share that line (needed to normalise pos into a 0-1 lateral
    coordinate the same way sportmonksFouls.ts's own lateralOf() already
    does). Names here are TRUNCATED for long surnames (confirmed live:
    "Jeremie Frimpong" renders as "Frimpon'") - shirt number, not name,
    is the only safe join key back to extract_list_view's real names.
    MUST be called while Pitch View is the active toggle."""
    return page.evaluate(
        """
        () => {
            const halves = [...document.querySelectorAll('.football-pitch > div')].slice(0, 2);
            return halves.map((half, halfIdx) => {
                const lines = [...half.querySelectorAll(':scope > div')];
                return lines.map((line, lineIdx) => {
                    const players = [...line.querySelectorAll('sx-mc-pitch-view-player')];
                    const rowWidth = players.length;
                    return players.map(p => {
                        const posMatch = (p.className || '').match(/pos-(\\d+)/);
                        const text = p.textContent.replace(/\\s+/g, ' ').trim();
                        const shirtMatch = text.match(/^(\\d+)/);
                        if (!shirtMatch) return null;
                        return {
                            halfIdx, lineIdx, rowWidth,
                            pos: posMatch ? parseInt(posMatch[1], 10) : null,
                            shirt: parseInt(shirtMatch[1], 10),
                        };
                    }).filter(Boolean);
                }).flat();
            }).flat();
        }
        """
    )


def join_lineup_views(list_view, pitch_view):
    """Combine extract_list_view's real names with extract_pitch_view's
    formation grid, by (team half, shirt number) - see each function's
    own docstring for why neither view alone is enough."""
    pitch_by_key = {(p["halfIdx"], p["shirt"]): p for p in pitch_view}

    result = []
    for half in list_view:
        for row in half:
            if row["positionLetter"] == "S":
                continue  # substitute, not in the confirmed starting XI
            key = (row["halfIdx"], row["shirt"])
            pitch = pitch_by_key.get(key)
            result.append({
                "half": row["halfIdx"],
                "name": row["name"],
                "shirt": row["shirt"],
                "position_letter": row["positionLetter"],
                "formation_row": pitch["lineIdx"] if pitch else None,
                "formation_col": pitch["pos"] if pitch else None,
                "row_width": pitch["rowWidth"] if pitch else None,
            })
    return result


def scrape_fixture(page, url, our_fixture_id, home_team_id, away_team_id, cur):
    page.goto(url, wait_until="networkidle", timeout=30000)

    written = {"Shots On Target": 0, "Fouls Committed": 0, "Tackles": 0}
    unmatched = []

    # --- player ladders --------------------------------------------------
    # Fouls Committed/Tackles live under the "Players" sub-tab, NOT "Cards"
    # - "Cards" only has Total/team Cards O/U and card-SCORER props (who
    # gets booked), a different market entirely. Wrongly routed to "Cards"
    # from this script's first version onward; caught live 2026-08-29,
    # 40 minutes before Bournemouth v Everton kickoff, by dumping every
    # panel header text on both tabs and finding "Player Fouls Committed"/
    # "Player Tackles" only appeared under "Players" - this is why every
    # run all day reported Fouls=0 Tackles=0 regardless of how close to
    # kickoff, on fixtures whose lineups had already landed: it was never a
    # timing issue, the scraper was reading the wrong tab from the start.
    for tab_name, headers in (("Shots", ["Player Shots On Target"]), ("Players", ["Player Fouls Committed", "Player Tackles"])):
        try:
            page.get_by_text(tab_name, exact=True).first.click(timeout=10000)
            page.wait_for_timeout(1500)
        except Exception:
            continue
        for header_text in headers:
            cfg = LADDER_MARKETS[header_text]
            ensure_panel_expanded(page, header_text)
            rows = extract_ladder_market(page, header_text)
            for row in rows:
                m = re.match(r"^(.*) - (\d+)\+ Price Button$", row["label"] or "")
                if not m:
                    continue
                player_name, line = m.group(1).strip(), int(m.group(2))
                if line > cfg["max_line"]:
                    continue
                player_id = resolve_player_id(cur, player_name, (home_team_id, away_team_id))
                if player_id is None:
                    unmatched.append(player_name)
                    continue
                decimal_odds = fractional_to_decimal(row["price"])
                if decimal_odds is None:
                    continue

                if cfg["db_market"] == "Shots On Target":
                    # Kept in bookmaker_player_features too, as an expected
                    # count - unchanged from this script's original scope.
                    expected = anytime_prob_to_expected_count(1.0 / decimal_odds)
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
                        (player_id, our_fixture_id, round(expected, 4)),
                    )

                # Every ladder market (Shots On Target included) also goes
                # into fixture_player_props as raw data - Fouls Committed
                # and Tackles have no other home, and the fouls tool wants
                # the real ladder shape (every line), not a single derived
                # number.
                cur.execute(
                    """
                    insert into fixture_player_props (fixture_id, player_name_raw, player_id, market, bookmaker, price, line)
                    values (%s, %s, %s, %s, 'spreadex', %s, %s)
                    """,
                    (our_fixture_id, player_name, player_id, cfg["db_market"], round(decimal_odds, 4), line),
                )
                written[cfg["db_market"]] += 1

    # --- match-level Total Cards Over/Under, for margin derivation ------
    # Explicit tab click: the ladder loop above now ends on "Players" (see
    # the Fouls Committed/Tackles fix above), and Total Cards O/U only
    # renders under "Cards" - without this, extract_total_cards_ou reads
    # whatever tab was last active and silently returns nothing.
    try:
        page.get_by_text("Cards", exact=True).first.click(timeout=8000)
        page.wait_for_timeout(1000)
    except Exception:
        pass
    cards_rows = extract_total_cards_ou(page)
    cards_written = 0
    for row in cards_rows:
        m = re.match(r"^(Over|Under) ([\d.]+) Cards Price Button$", row["label"] or "")
        if not m:
            continue
        side, line = m.group(1), float(m.group(2))
        decimal_odds = fractional_to_decimal(row["price"])
        if decimal_odds is None:
            continue
        cur.execute(
            """
            insert into fixture_player_props (fixture_id, player_name_raw, player_id, market, bookmaker, price, line)
            values (%s, 'Match', null, %s, 'spreadex', %s, %s)
            """,
            (our_fixture_id, f"Total Cards {side}", round(decimal_odds, 4), line),
        )
        cards_written += 1

    # --- real confirmed lineups + formation ------------------------------
    # Pitch View's formation grid MUST be read before switching to List
    # View - Angular unmounts sx-mc-pitch-view-player entirely once the
    # toggle changes, confirmed live (a first attempt that read both
    # views back to back, after switching straight to List View, got a
    # real player list but every formation_row/formation_col came back
    # null).
    lineup_written = 0
    try:
        page.get_by_text("Team-Line-Ups", exact=True).first.click(timeout=8000)
        page.wait_for_timeout(1000)
        pitch_view = extract_pitch_view(page)
        page.get_by_text("List View", exact=True).first.click(timeout=8000)
        page.wait_for_timeout(800)
        list_view = extract_list_view(page)
        lineup_rows = join_lineup_views(list_view, pitch_view)
        for row in lineup_rows:
            team_id = home_team_id if row["half"] == 0 else away_team_id
            player_id = resolve_player_id(cur, row["name"], (team_id,))
            cur.execute(
                """
                insert into fixture_lineups
                    (fixture_id, team_id, player_id, player_name_raw, shirt_number,
                     formation_row, formation_col, row_width, is_starter)
                values (%s, %s, %s, %s, %s, %s, %s, %s, true)
                """,
                (our_fixture_id, team_id, player_id, row["name"], row["shirt"],
                 row["formation_row"], row["formation_col"], row["row_width"]),
            )
            lineup_written += 1
    except Exception:
        pass  # lineups genuinely aren't posted yet for most of the lookahead window - not an error

    return written, cards_written, lineup_written, unmatched


def expand_league_one_accordion(page):
    """League One's real fixtures live inside a collapsed accordion
    panel on the shared "football-popular" page, far down the page
    (confirmed live 2026-08-30: its header sits ~3300px down). A plain
    .click() - which relies on Playwright's own auto-scroll as part of
    the click - reliably reported success with zero exception but left
    the panel's fixture rows never actually rendering (confirmed live:
    zero matches for a real, visible team name anywhere on the page
    afterwards). An explicit scroll_into_view_if_needed() first, before
    clicking, is what actually works - this Angular SPA's own lazy
    rendering apparently needs the real scroll to complete (and a real
    pause) before the header's click handler does anything, not just
    the element being technically in the viewport at click time. This
    is exactly why every League One fixture failed to match on this
    script's first live run - not a name mismatch at all.

    KNOWN, ACCEPTED FLAKINESS - read before touching this again.
    Confirmed live 2026-08-30, isolated in a standalone repeated-
    navigation test (10 attempts, same URL, same page/context): this
    exact scroll+click sequence succeeds on roughly HALF of repeated
    attempts (an exact alternating 1,0,1,0,... pattern across 10
    tries) - and checking whether the panel already looks expanded
    before clicking (it never did) ruled out a simple open/close
    toggle-state explanation. Real impact: roughly half of League
    One's real fixtures get missed on any single run, not a total
    failure and not a data-correctness risk - and this pipeline runs
    twice daily, so a fixture missed this cycle has another real
    chance next cycle."""
    try:
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(300)
        header = page.get_by_text("League 1", exact=True).first
        header.scroll_into_view_if_needed(timeout=10000)
        page.wait_for_timeout(1000)
        header.click(timeout=10000)
        page.wait_for_timeout(2500)
    except Exception:
        pass


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

            totals = {"Shots On Target": 0, "Fouls Committed": 0, "Tackles": 0}
            total_cards, total_lineups = 0, 0
            total_unmatched = []
            no_fixture_found = []

            for competition, cfg in COMPETITIONS.items():
                comp_fixtures = [f for f in our_fixtures if f[3] == competition]
                if not comp_fixtures:
                    continue
                page.goto(cfg["listing_url"], wait_until="networkidle", timeout=30000)
                if competition == "efl_league_one":
                    expand_league_one_accordion(page)

                for fixture_id, home_name, away_name, _comp, home_team_id, away_team_id in comp_fixtures:
                    home_sx, away_sx = spreadex_name(home_name), spreadex_name(away_name)
                    fixture_url = find_and_click_fixture(page, home_sx, away_sx)
                    if fixture_url is None:
                        no_fixture_found.append((competition, home_sx, away_sx))
                        page.goto(cfg["listing_url"], wait_until="networkidle", timeout=30000)
                        if competition == "efl_league_one":
                            expand_league_one_accordion(page)
                        continue

                    written, cards_written, lineup_written, unmatched = scrape_fixture(
                        page, fixture_url, fixture_id, home_team_id, away_team_id, cur
                    )
                    for k, v in written.items():
                        totals[k] += v
                    total_cards += cards_written
                    total_lineups += lineup_written
                    total_unmatched.extend(unmatched)
                    print(
                        f"  {home_sx} v {away_sx}: SoT={written['Shots On Target']} "
                        f"Fouls={written['Fouls Committed']} Tackles={written['Tackles']} "
                        f"Cards={cards_written} Lineups={lineup_written}"
                        + (f" ({len(unmatched)} unmatched player name(s))" if unmatched else "")
                    )
                    conn.commit()

                    # Real courtesy delay between fixture pages - this is
                    # a live retail betting site, not a versioned API;
                    # scraping it politely matters more here than
                    # anywhere else in this project.
                    time.sleep(2)

                    page.goto(cfg["listing_url"], wait_until="networkidle", timeout=30000)
                    if competition == "efl_league_one":
                        expand_league_one_accordion(page)

            browser.close()

        print(
            f"\nDone: {totals['Shots On Target']} shots-on-target, {totals['Fouls Committed']} fouls-committed, "
            f"{totals['Tackles']} tackles, {total_cards} total-cards rows, {total_lineups} lineup rows written."
        )
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
