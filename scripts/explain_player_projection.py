"""
explain_player_projection.py
------------------------------
Pretty-prints exactly how a stored Hail Mary projection reached its
number, stat by stat - a safeguard, not a new calculation. Built after
an investigation (2026-08-06, EFL Fantasy defender clearance/goal
projections) where hand-reconstructing compute_projections.py's formula
from reading the source led to a wrong conclusion ("this number is
stale/broken") that a look at the REAL stored breakdown would have
caught immediately: goal/assist/clean_sheet_60min (MODULAR_STATS) fold
in a fixture-strength multiplier on top of the player's own fixture-
neutral shrunk rate, which a from-scratch formula read is easy to miss.

This script never recomputes anything - it only reads and decodes
projections.inputs (already the full, authoritative breakdown the real
pipeline produced), cross-referenced against game_scoring_rules for
plain-English labels. Zero risk of the "hand-derivation was subtly
wrong" failure mode, by construction - reuse this instead of re-deriving
the formula from source next time someone asks "does this number look
right?".

RUN:
    python3 scripts/explain_player_projection.py <game_player_id> [--gameweek N]
    python3 scripts/explain_player_projection.py --search "<name substring>" --game <slug>
"""

import argparse
import json
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent


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


MODULAR_STATS = {"goal", "assist", "clean_sheet_60min"}


def fmt(v, nd=4):
    return "N/A" if v is None else f"{float(v):.{nd}f}"


def print_stat_breakdown(stat, detail, scoring_rules_by_stat, position):
    label = scoring_rules_by_stat.get(stat, stat)
    points_each = detail.get("points_each")
    contribution = detail.get("contribution")
    projected = detail.get("projected") or detail.get("probability")
    print(f"\n  {stat} ({label})")
    print(f"    projected rate/probability : {fmt(projected)}")
    print(f"    points each                : {points_each}")
    print(f"    contribution               : {fmt(contribution, 3)} pts")


def print_module_detail(stat, module_detail):
    if not module_detail:
        return
    detail = module_detail.get(stat)
    if not detail:
        return
    print(
        f"    [MODULAR STAT] this isn't just the player's own fixture-neutral"
        f" rate. It's a blend of up to 5 modules, and the fixture-model/"
        f" historical-performance modules ALREADY include a fixture-strength"
        f" multiplier for this specific gameweek's opponent - don't hand-derive"
        f" this one from raw season totals alone (see script docstring)."
    )
    print(f"    final blended rate         : {fmt(detail.get('final_rate'))}")
    for module, m in detail.get("modules", {}).items():
        raw = m.get("raw_rate")
        eff_w = m.get("effective_weight")
        cfg_w = m.get("configured_weight")
        contrib = m.get("weighted_point_contribution")
        print(
            f"      - {module:<24} raw_rate={fmt(raw)}  "
            f"weight={fmt(eff_w, 2)} (configured {fmt(cfg_w, 2)})  "
            f"contribution={fmt(contrib, 3)}"
        )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("game_player_id", nargs="?", type=int)
    parser.add_argument("--gameweek", type=int, default=None)
    parser.add_argument("--search", type=str, default=None)
    parser.add_argument("--game", type=str, default=None)
    args = parser.parse_args()

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    game_player_id = args.game_player_id
    if args.search:
        cur.execute(
            """
            select gp.id, p.full_name, gp.position_code as position, fg.slug
            from game_players gp
            join players p on p.id = gp.player_id
            join fantasy_games fg on fg.id = gp.game_id
            where p.full_name ilike %s and (%s::text is null or fg.slug = %s)
            order by p.full_name
            limit 10
            """,
            (f"%{args.search}%", args.game, args.game),
        )
        matches = cur.fetchall()
        if not matches:
            raise SystemExit(f"No player matching '{args.search}'" + (f" in {args.game}" if args.game else ""))
        if len(matches) > 1 and not game_player_id:
            print(f"Multiple matches for '{args.search}':")
            for m in matches:
                print(f"  game_player_id={m['id']:<8} {m['full_name']:<25} {m['position']:<6} ({m['slug']})")
            print("\nRe-run with the game_player_id you want.")
            return
        game_player_id = matches[0]["id"]

    if not game_player_id:
        raise SystemExit("Usage: python3 scripts/explain_player_projection.py <game_player_id> [--gameweek N]\n"
                          "   or: python3 scripts/explain_player_projection.py --search '<name>' [--game <slug>]")

    cur.execute(
        """
        select p.full_name, gp.position_code as position, fg.slug as game_slug, gp.price
        from game_players gp
        join players p on p.id = gp.player_id
        join fantasy_games fg on fg.id = gp.game_id
        where gp.id = %s
        """,
        (game_player_id,),
    )
    player = cur.fetchone()
    if not player:
        raise SystemExit(f"No game_player with id={game_player_id}")

    cur.execute(
        """
        select gsr.stat, gsr.applies_to, gsr.notes
        from game_scoring_rules gsr
        join fantasy_games fg on fg.id = gsr.game_id
        where fg.slug = %s
        """,
        (player["game_slug"],),
    )
    scoring_rules_by_stat = {}
    scoring_notes = {}
    for r in cur.fetchall():
        scoring_rules_by_stat.setdefault(r["stat"], r["stat"])
        scoring_notes[r["stat"]] = r["notes"]

    query = """
        select pr.gameweek, pr.hail_mary_score, pr.inputs, pr.created_at
        from projections pr
        join game_players gp on gp.id = pr.game_player_id
        where pr.game_player_id = %s
    """
    params = [game_player_id]
    if args.gameweek is not None:
        query += " and pr.gameweek = %s"
        params.append(args.gameweek)
    query += " order by pr.gameweek nulls last"
    cur.execute(query, params)
    rows = cur.fetchall()
    if not rows:
        raise SystemExit(f"No stored projections for game_player_id={game_player_id}" +
                          (f" gameweek={args.gameweek}" if args.gameweek else ""))

    print(f"{'=' * 70}")
    print(f"{player['full_name']} ({player['position']}, GBP {player['price']}m) - {player['game_slug']}")
    print(f"game_player_id={game_player_id}")
    print(f"{'=' * 70}")

    for row in rows:
        inputs = row["inputs"]
        if isinstance(inputs, str):
            inputs = json.loads(inputs)
        print(f"\n--- Gameweek {row['gameweek']} - TOTAL: {row['hail_mary_score']} pts (computed {row['created_at']}) ---")

        module_detail = inputs.get("module_detail") or {}
        fixtures = inputs.get("fixtures") or []
        for fx in fixtures:
            if len(fixtures) > 1:
                print(f"\n  Fixture {fx.get('fixture_id')} ({fx.get('kickoff_at')}) - contributes {fx.get('contribution')} pts")
            for stat, detail in (fx.get("stats") or {}).items():
                print_stat_breakdown(stat, detail, scoring_rules_by_stat, player["position"])
                if stat in MODULAR_STATS:
                    print_module_detail(stat, module_detail)

        recon = inputs.get("reconciliation") or {}
        if recon:
            print(f"\n  Reconciliation: modular_sum={fmt(recon.get('modular_sum'), 3)} + "
                  f"non_modular_sum={fmt(recon.get('non_modular_sum'), 3)} + "
                  f"bonus={fmt(recon.get('bonus'), 3)} "
                  f"x availability={fmt(recon.get('availability_multiplier'), 3)} "
                  f"= {fmt(recon.get('final_score'), 3)}")

        explanation = inputs.get("explanation")
        if explanation:
            print(f"\n  \"{explanation}\"")

    print(f"\n{'=' * 70}")
    print("Notes on scoring rule confidence for this game:")
    seen_notes = set()
    for stat, note in scoring_notes.items():
        if note and note not in seen_notes:
            seen_notes.add(note)
    if seen_notes:
        for note in seen_notes:
            print(f"  - {note}")
    else:
        print("  (no notes on file)")


if __name__ == "__main__":
    main()
