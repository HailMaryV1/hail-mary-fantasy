"""
match_players.py
-----------------
Cross-game player identity matching, tested against last season's real
Dream Team and FanTeam CSVs before any database exists.

Dream Team spells names as "E. Haaland" (initial + surname); FanTeam
spells them in full ("Erling Haaland"). Team names and position codes
also differ between the two (see CANONICAL_TEAMS / POSITION_MAP below).
This script buckets players by (canonical team, canonical position) and
matches within each bucket by checking whether one name's surname is
a suffix of the other's compacted full name - which also naturally
handles punctuation differences like "Gibbs-White" vs "GibbsWhite".

This does NOT touch a database. It's a dry run to validate the matching
approach and produce a CSV you can eyeball before we wire this into the
real Supabase import.

RUN:
    python3 match_players.py "path/to/dreamteam.csv" "path/to/fanteam.csv"
"""

import csv
import re
import sys

CANONICAL_TEAMS = [
    # (canonical, dreamteam_name, fanteam_name)
    ("Arsenal", "Arsenal", "Arsenal"),
    ("Aston Villa", "Villa", "Aston Villa"),
    ("Bournemouth", "Bournemouth", "Bournemouth"),
    ("Brentford", "Brentford", "Brentford"),
    ("Brighton", "Brighton", "Brighton"),
    ("Burnley", "Burnley", "Burnley"),
    ("Chelsea", "Chelsea", "Chelsea"),
    ("Crystal Palace", "Palace", "Crystal Palace"),
    ("Everton", "Everton", "Everton"),
    ("Fulham", "Fulham", "Fulham"),
    ("Leeds United", "Leeds", "Leeds"),
    ("Liverpool", "Liverpool", "Liverpool"),
    ("Manchester City", "Man City", "Manchester City"),
    ("Manchester United", "Man Utd", "Manchester United"),
    ("Newcastle United", "Newcastle", "Newcastle"),
    ("Nottingham Forest", "Forest", "Nottingham Forest"),
    ("Tottenham Hotspur", "Spurs", "Spurs"),
    ("Sunderland", "Sunderland", "Sunderland"),
    ("West Ham United", "West Ham", "West Ham"),
    ("Wolverhampton Wanderers", "Wolves", "Wolves"),
]
DT_TEAM_TO_CANON = {dt: canon for canon, dt, ft in CANONICAL_TEAMS}
FT_TEAM_TO_CANON = {ft: canon for canon, dt, ft in CANONICAL_TEAMS}

POSITION_MAP = {
    "dreamteam": {"GK": "GK", "DEF": "DEF", "MID": "MID", "STR": "FWD"},
    "fanteam": {"GK": "GK", "DEF": "DEF", "MID": "MID", "FOR": "FWD"},
}


def compact(name: str) -> str:
    """Lowercase, strip everything but letters - for robust name comparison."""
    return re.sub(r"[^a-z]", "", name.lower())


def dt_surname(display_name: str) -> str:
    """Dream Team format is 'X. Surname' - take everything after the initial."""
    if ". " in display_name:
        return display_name.split(". ", 1)[1]
    return display_name.split(" ", 1)[-1]


def load_dreamteam(path):
    rows = []
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            team = DT_TEAM_TO_CANON.get(r["squadName"].strip())
            pos = POSITION_MAP["dreamteam"].get(r["position"].strip())
            if not team or not pos:
                print(f"  [warn] unmapped dreamteam row: {r['squadName']!r} / {r['position']!r}")
                continue
            rows.append({
                "source": "dreamteam",
                "external_id": r["playerId"],
                "display_name": r["displayName"],
                "surname_compact": compact(dt_surname(r["displayName"])),
                "team": team,
                "position": pos,
                "position_raw": r["position"].strip(),
                "price": r["price"],
                "raw": r,
            })
    return rows


def load_fanteam(path):
    rows = []
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            team = FT_TEAM_TO_CANON.get(r["squadName"].strip())
            pos = POSITION_MAP["fanteam"].get(r["position"].strip())
            if not team or not pos:
                print(f"  [warn] unmapped fanteam row: {r['squadName']!r} / {r['position']!r}")
                continue
            rows.append({
                "source": "fanteam",
                "external_id": r["playerId"],
                "display_name": r["displayName"],
                "full_compact": compact(r["displayName"]),
                "team": team,
                "position": pos,
                "position_raw": r["position"].strip(),
                "price": r["price"],
                "raw": r,
            })
    return rows


def match(dt_rows, ft_rows):
    matched, dt_only, ft_only, ambiguous = [], [], [], []

    for team_pos in {(r["team"], r["position"]) for r in dt_rows} | {(r["team"], r["position"]) for r in ft_rows}:
        dt_bucket = [r for r in dt_rows if (r["team"], r["position"]) == team_pos]
        ft_bucket = [r for r in ft_rows if (r["team"], r["position"]) == team_pos]
        ft_remaining = list(ft_bucket)

        for dt in dt_bucket:
            candidates = [ft for ft in ft_remaining if ft["full_compact"].endswith(dt["surname_compact"])]
            if len(candidates) > 1:
                # Same surname, multiple first names at the same club/position
                # (e.g. "Hugo Bueno" and "Santiago Bueno" at Wolves) - use the
                # Dream Team initial to disambiguate.
                initial = dt["display_name"][0].lower()
                narrowed = [ft for ft in candidates if ft["display_name"][0].lower() == initial]
                if len(narrowed) == 1:
                    candidates = narrowed

            if len(candidates) == 1:
                ft = candidates[0]
                matched.append((dt, ft))
                ft_remaining.remove(ft)
            elif len(candidates) == 0:
                dt_only.append(dt)
            else:
                ambiguous.append((dt, candidates))

        ft_only.extend(ft_remaining)

    return matched, dt_only, ft_only, ambiguous


def main():
    if len(sys.argv) != 3:
        print("Usage: python3 match_players.py <dreamteam.csv> <fanteam.csv>")
        sys.exit(1)

    dt_rows = load_dreamteam(sys.argv[1])
    ft_rows = load_fanteam(sys.argv[2])
    print(f"Loaded {len(dt_rows)} Dream Team rows, {len(ft_rows)} FanTeam rows\n")

    matched, dt_only, ft_only, ambiguous = match(dt_rows, ft_rows)

    print(f"Matched:        {len(matched)}")
    print(f"Dream Team only: {len(dt_only)}")
    print(f"FanTeam only:    {len(ft_only)}")
    print(f"Ambiguous:       {len(ambiguous)}")

    with open("player_match_review.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["status", "dt_id", "dt_name", "ft_id", "ft_name", "team", "position"])
        for dt, ft in matched:
            w.writerow(["matched", dt["external_id"], dt["display_name"], ft["external_id"], ft["display_name"], dt["team"], dt["position"]])
        for dt in dt_only:
            w.writerow(["dreamteam_only", dt["external_id"], dt["display_name"], "", "", dt["team"], dt["position"]])
        for ft in ft_only:
            w.writerow(["fanteam_only", "", "", ft["external_id"], ft["display_name"], ft["team"], ft["position"]])
        for dt, candidates in ambiguous:
            names = "; ".join(f"{c['external_id']}:{c['display_name']}" for c in candidates)
            w.writerow(["ambiguous", dt["external_id"], dt["display_name"], names, "", dt["team"], dt["position"]])

    print("\nFull breakdown written to player_match_review.csv")


if __name__ == "__main__":
    main()
