"""
probe_odds_api.py
------------------
Checks what competitions The Odds API actually exposes (need Premier
League, Champions League, Europa League, Conference League, FA Cup,
League Cup - since Dream Team scores across all of them), and pulls a
sample of real match-winner odds to confirm the response shape before
building anything against it.

RUN:
    python3 scripts/probe_odds_api.py
"""

import json
import os
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env():
    for line in (ROOT / ".env").read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


load_env()
API_KEY = os.environ["ODDS_API_KEY"]
BASE = "https://api.the-odds-api.com/v4"


def fetch(path, params=""):
    url = f"{BASE}{path}?apiKey={API_KEY}{params}"
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:
        headers = dict(resp.headers)
        return resp.status, json.loads(resp.read()), headers


status, sports, headers = fetch("/sports")
soccer = [s for s in sports if s["group"] == "Soccer"]
print(f"Status {status} - {len(sports)} total sports, {len(soccer)} soccer competitions\n")

wanted_keywords = ["epl", "premier", "champs", "europa", "conference", "fa_cup", "efl", "league_cup", "uefa"]
relevant = [s for s in soccer if any(k in s["key"].lower() for k in wanted_keywords)]
print("Relevant competitions found:")
for s in relevant:
    print(f"  {s['key']:35s} active={s['active']}  {s['title']}")

print("\nAll soccer keys (for reference):")
for s in soccer:
    print(f"  {s['key']:35s} {s['title']}")

if relevant:
    key = next((s["key"] for s in relevant if "epl" in s["key"] or "premier" in s["key"]), relevant[0]["key"])
    print(f"\n--- sample odds for {key} ---")
    status, odds, headers = fetch(f"/sports/{key}/odds", "&regions=uk&markets=h2h")
    print("requests remaining:", headers.get("x-requests-remaining"), " used:", headers.get("x-requests-used"))
    print(json.dumps(odds[:1], indent=2)[:1500])
