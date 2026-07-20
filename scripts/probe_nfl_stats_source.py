"""
probe_nfl_stats_source.py
--------------------------
Checks whether nflverse's public data releases (free, no auth, CSV over
HTTPS - https://github.com/nflverse/nflverse-data) actually expose real
2025 season player and team box-score stats in a shape that maps onto
nfl_game_player_stats, before building the real historical importer
against it.

RUN:
    python3 scripts/probe_nfl_stats_source.py
"""

import csv
import io
import urllib.error
import urllib.request

CANDIDATES = {
    "player_stats (offense, weekly)": "https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats.csv",
    "team_stats (weekly)": "https://github.com/nflverse/nflverse-data/releases/download/stats_team/stats_team_week.csv",
    "schedules (scores)": "https://github.com/nflverse/nflverse-data/releases/download/schedules/schedules.csv",
}


def fetch_head(url, n_bytes=200_000):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status, resp.read(n_bytes)


for label, url in CANDIDATES.items():
    print(f"--- {label} ---")
    print(url)
    try:
        status, raw = fetch_head(url)
    except urllib.error.HTTPError as e:
        print(f"  HTTP {e.code}")
        continue
    except Exception as e:
        print(f"  error: {e}")
        continue

    text = raw.decode("utf-8", errors="replace")
    # a partial download likely cuts mid-row; only parse complete lines
    lines = text.splitlines()[:-1]
    reader = csv.reader(lines)
    rows = list(reader)
    if not rows:
        print("  no rows parsed")
        continue
    header = rows[0]
    print(f"  status {status}, {len(header)} columns")
    print(f"  columns: {header}")
    if len(rows) > 1:
        sample = dict(zip(header, rows[-1]))
        # print only a few interesting fields if present, else the whole row
        interesting = [k for k in sample if any(
            kw in k.lower() for kw in
            ["season", "week", "team", "player", "pass", "rush", "rec", "int", "fumbl", "sack", "score", "points"]
        )]
        print(f"  sample row (subset): {{{', '.join(f'{k!r}: {sample[k]!r}' for k in interesting[:20])}}}")
    print()
