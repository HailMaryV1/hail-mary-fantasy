"""
capture_ffscout_injury_detail.py
----------------------------------
Real injury type/description + expected return date from FFScout's
dedicated injuries page (fantasyfootballscout.co.uk/fantasy-football-
injuries) - 2026-08-20 user request: "we can also add this page into our
injury news"..."I just want the data feeding into Ask Mary - the player
pools with player status... just like we have with the predicted
lineups and the little injury snippet. this is more extensive." Writes
into the SAME ffscout_player_status table as
capture_ffscout_player_status.py (migration 0122), under a distinct
source='ffscout_injuries' so both scrapers' rows coexist without key
collisions (unique on team_id, raw_name, snapshot_date, source) - see
migration 0127 for the detail/expected_return_date columns and the
game_player_pool view's second lateral join that surfaces them.

Real markup confirmed live (2026-08-20): 65 `tr.injuries-bans-item[data-
team-code]` rows, no pagination. Column 1 is player name - a bare
surname text node plus an optional `span.first-name` "(Firstname)" node
(5/65 rows have no first-name span at all - single-word entries).
Column 2 is club: `img[alt]` for 16/19 clubs seen; the 3 real 2026/27
promoted clubs (Coventry, Hull, Ipswich - see memory
feedback_2026_27_relegation_promotion.md) have no crest image yet, only
a `span.team-disc` with no name text - team-code fallback below.
Column 3 status is `span.status`, CLASS-encoded (`injured`/`doubt-N`/
`suspended` - confirmed only these 3 values live, N is a real percentage
matching the team-news page's own doubt-percent for the same player,
e.g. Fatawu 75% appears identically on both pages - same "chance to
start" semantic already established by capture_ffscout_player_status.py).
Column 4 is return date ("Unknown" or "DD/MM/YYYY", both confirmed with
no other format live). Column 5 is detail: a `<strong>` type label (which
can itself literally read "Unknown" as a type, e.g. Darlow row - don't
confuse this with column 4's own "Unknown") + free text + an optional
`<a>[Source]</a>` link (absent on 6/65 rows). Column 6 (last updated) is
not captured - captured_at already timestamps our own scrape.

Player/team matching reuses capture_ffscout_player_status.py's own
match_player() (surname_key/surname_variants via name_matching.py) - not
re-implemented here.

RUN:
    python3 scripts/capture_ffscout_injury_detail.py
"""
import os
import sys
import urllib.request
from datetime import date, datetime
from pathlib import Path

import psycopg2
import psycopg2.extras
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

from capture_ffscout_player_status import load_env, match_player  # noqa: E402

INJURIES_URL = "https://www.fantasyfootballscout.co.uk/fantasy-football-injuries"
SOURCE = "ffscout_injuries"

FFSCOUT_TEAM_NAME_OVERRIDES = {
    "Brighton and Hove Albion": "Brighton",
}

# Confirmed live 2026-08-20 - these 3 real Premier League clubs have no
# crest image on this page (only a team-disc placeholder), so they can't
# be resolved via img[alt] like every other club. If a currently-imaged
# club ever loses its crest too, resolve_team_id() logs and skips it
# rather than guessing an unconfirmed code.
FFSCOUT_TEAM_CODE_OVERRIDES = {
    "cov": "Coventry City",
    "hul": "Hull City",
    "ips": "Ipswich Town",
}


def fetch_page():
    req = urllib.request.Request(INJURIES_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    return raw.decode("utf-8")


def parse_status(status_td):
    span = status_td.find("span", class_="status")
    if not span:
        return None, None
    classes = span.get("class", [])
    if "injured" in classes:
        return "out", None
    if "suspended" in classes:
        return "banned", None
    for c in classes:
        if c.startswith("doubt-"):
            try:
                return "doubt", float(c.split("-", 1)[1])
            except ValueError:
                return "doubt", None
    return None, None


def parse_return_date(return_date_td):
    text = return_date_td.get_text(strip=True)
    if not text or text.lower() == "unknown":
        return None
    try:
        return datetime.strptime(text, "%d/%m/%Y").date()
    except ValueError:
        return None


def parse_detail(detail_td):
    """'<Type>: <description>' with the [Source] link stripped - built
    from a fresh re-parse of this cell's own markup so extracting the
    <strong>/<a> tags below doesn't mutate the live soup tree."""
    td = BeautifulSoup(str(detail_td), "html.parser")
    strong = td.find("strong")
    detail_type = strong.get_text(strip=True) if strong else None
    if strong:
        strong.extract()
    link = td.find("a")
    if link:
        link.extract()
    description = td.get_text(" ", strip=True)
    if detail_type and description:
        return f"{detail_type}: {description}"
    return detail_type or description or None


def parse_name(name_td):
    """(surname, first_name_or_None) - surname is the direct text node
    before the optional nested first-name span (see module docstring)."""
    span = name_td.find("span", class_="align-middle")
    if not span or not span.contents:
        return None, None
    surname = str(span.contents[0]).strip()
    first_name_span = span.find("span", class_="first-name")
    first_name = first_name_span.get_text(strip=True).strip("()") if first_name_span else None
    return surname or None, first_name


def parse_injuries(html):
    """[(team_code, club_img_alt_or_None, surname, status, start_probability,
    expected_return_date, detail), ...] - one entry per real row."""
    soup = BeautifulSoup(html, "html.parser")
    rows = []
    for tr in soup.select("tr.injuries-bans-item[data-team-code]"):
        tds = tr.find_all("td")
        if len(tds) < 5:
            continue
        surname, _first_name = parse_name(tds[0])
        if not surname:
            continue
        img = tds[1].find("img")
        club_img_alt = img.get("alt") if img else None
        status, start_probability = parse_status(tds[2])
        if status is None:
            continue
        expected_return_date = parse_return_date(tds[3])
        detail = parse_detail(tds[4])
        rows.append((tr.get("data-team-code"), club_img_alt, surname, status, start_probability, expected_return_date, detail))
    return rows


def resolve_team_id(cur, team_code, club_img_alt):
    external_key = club_img_alt if club_img_alt else f"code:{team_code}"
    cur.execute(
        "select team_id from team_aliases where source = %s and external_name = %s",
        (SOURCE, external_key),
    )
    row = cur.fetchone()
    if row:
        return row["team_id"]

    if club_img_alt:
        canonical_name = FFSCOUT_TEAM_NAME_OVERRIDES.get(club_img_alt, club_img_alt)
    else:
        canonical_name = FFSCOUT_TEAM_CODE_OVERRIDES.get(team_code)
    if not canonical_name:
        return None
    cur.execute("select id from teams where name = %s", (canonical_name,))
    row = cur.fetchone()
    if not row:
        return None
    team_id = row["id"]
    cur.execute(
        "insert into team_aliases (team_id, source, external_name) values (%s, %s, %s) on conflict do nothing",
        (team_id, SOURCE, external_key),
    )
    return team_id


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"], cursor_factory=psycopg2.extras.RealDictCursor)
    cur = conn.cursor()
    snapshot_date = date.today()

    try:
        html = fetch_page()
        rows = parse_injuries(html)

        written, matched, unmatched, skipped_teams = 0, 0, 0, 0
        unmatched_rows = []
        seen_teams = {}
        for team_code, club_img_alt, raw_name, status, start_probability, expected_return_date, detail in rows:
            team_key = club_img_alt or team_code
            if team_key not in seen_teams:
                try:
                    seen_teams[team_key] = resolve_team_id(cur, team_code, club_img_alt)
                except Exception as e:
                    print(f"  [skip team] {team_key}: {e}")
                    seen_teams[team_key] = None
            team_id = seen_teams[team_key]
            if not team_id:
                print(f"  [skip row] unresolved team code={team_code!r} img_alt={club_img_alt!r} for {raw_name!r}")
                skipped_teams += 1
                continue

            try:
                player_id = match_player(cur, team_id, raw_name)
            except Exception as e:
                print(f"  [skip row] {raw_name!r}: {e}")
                continue
            if player_id:
                matched += 1
            else:
                unmatched += 1
                unmatched_rows.append((team_key, raw_name, status))

            cur.execute(
                """
                insert into ffscout_player_status
                    (player_id, team_id, raw_name, status, start_probability, detail, expected_return_date, snapshot_date, source, captured_at)
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                on conflict (team_id, raw_name, snapshot_date, source) do update
                    set player_id = excluded.player_id, status = excluded.status,
                        start_probability = excluded.start_probability, detail = excluded.detail,
                        expected_return_date = excluded.expected_return_date, captured_at = excluded.captured_at
                """,
                (player_id, team_id, raw_name, status, start_probability, detail, expected_return_date, snapshot_date, SOURCE),
            )
            written += 1

        conn.commit()
        print(
            f"\nFFScout injury detail captured for {snapshot_date}: {written} rows written "
            f"({matched} matched to a real player_id, {unmatched} unmatched, {skipped_teams} rows skipped for unresolved team)."
        )
        if unmatched_rows:
            print("\nUnmatched (left as player_id = NULL, raw_name preserved):")
            for team_key, raw_name, status in unmatched_rows:
                print(f"  [{team_key} {status}] {raw_name!r}")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
