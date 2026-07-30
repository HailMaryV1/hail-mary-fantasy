"""
audit_player_role.py
---------------------
Read-only audit of the Player Role module across the whole player pool -
does NOT touch projection_module_weights or compute_projections.py's
formulas. Answers the question raised after building the Engine
Validation page: is Haaland's drop (33.3% team goal share) a one-off
data artefact, or a real pattern worth trusting/adjusting/replacing?

For every player currently projected (fanteam + dreamteam), rebuilds the
mathematically correct MARGINAL effect of Player Role - not just its
weighted_point_contribution (which does not account for the fact that
removing a module renormalizes weight onto the others, at THEIR rates,
not zero). Mirrors blend_module_rates()'s own renormalization exactly
(see compute_projections.py) using the raw_rate/configured_weight figures
already persisted in projections.inputs.module_detail - no re-derivation
of the underlying rates themselves, so this can never disagree with what
production actually computed.

Also runs data-quality checks on the team totals Player Role's share is
computed from (compute_team_stat_totals in compute_projections.py):
duplicate players, transferred/departed players, mismatched team
attribution, inconsistent season windows, zero-minute/tiny-sample
players - all real risks for a module built on players.team_id (CURRENT
squad) applied to last-season historical goals/assists (EARNED,
potentially, at a different club).

Writes a JSON report to stdout (redirect to a file) - a human-readable
Artifact is built from it separately.
"""
import json
import os
import statistics
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent
HISTORICAL_SEASON = "2025/26"
GAMES = ("fanteam", "dreamteam")
TINY_SAMPLE_MINUTES = 450.0  # 5 full 90s - below this, a player's own
# goal/assist total (and therefore both their own share AND their
# contribution to the team denominator) rests on very little evidence.


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


def fetch_base_rows(cur, game_slug):
    cur.execute(
        """
        select gp.id as game_player_id, gp.player_id, p.full_name, p.position, p.team_id,
               t.name as team_name,
               coalesce(gps.minutes_played, 0) as minutes_played,
               coalesce(gps.goals, 0) as goals, coalesce(gps.assists, 0) as assists,
               (gps.game_player_id is not null) as has_historical_row,
               gps.season as historical_season, gps.gameweek as historical_gameweek
        from game_players gp
        join players p on p.id = gp.player_id
        join teams t on t.id = p.team_id
        join fantasy_games fg on fg.id = gp.game_id
        left join game_player_stats gps
            on gps.game_player_id = gp.id and gps.season = %s and gps.gameweek = 0
        where fg.slug = %s and gp.is_active = true
        """,
        (HISTORICAL_SEASON, game_slug),
    )
    return {r["game_player_id"]: r for r in cur.fetchall()}


def fetch_projection_rows(cur, game_slug):
    cur.execute(
        """
        select game_player_id, full_name, position, team_name, price, hail_mary_score, gameweek, inputs
        from player_projection_summary
        where game_slug = %s
        """,
        (game_slug,),
    )
    return cur.fetchall()


def compute_team_totals(base_rows):
    totals = {}
    for r in base_rows.values():
        if r["minutes_played"] <= 0:
            continue
        team_id = r["team_id"]
        entry = totals.setdefault(
            team_id,
            {"team_name": r["team_name"], "goal_total": 0.0, "assist_total": 0.0, "games90": 0.0, "player_count": 0, "player_ids": []},
        )
        entry["goal_total"] += r["goals"]
        entry["assist_total"] += r["assists"]
        entry["games90"] += r["minutes_played"] / 90.0
        entry["player_count"] += 1
        entry["player_ids"].append(r["player_id"])
    return totals


def player_role_impact(inputs):
    """(total_delta_points, per_stat_detail) - the properly-renormalized
    marginal effect of Player Role on the PRIMARY fixture's projection
    (module_detail's own documented scope - see compute_projections.py's
    module_detail_scope). None if this row has no v2 module_detail at all
    (shouldn't happen for fanteam/dreamteam, both v2, but fails safe)."""
    module_detail = inputs.get("module_detail") or {}
    emf = inputs.get("expected_minutes_fraction")
    if emf is None or not module_detail:
        return None, {}
    total_delta = 0.0
    per_stat = {}
    for stat in ("goal", "assist"):
        stat_detail = module_detail.get(stat)
        if not stat_detail:
            continue
        modules = stat_detail["modules"]
        role = modules.get("player_role")
        if role is None or role.get("raw_rate") is None:
            continue
        points_each = stat_detail.get("points_each")
        if points_each is None:
            continue
        available = {m: d["raw_rate"] for m, d in modules.items() if m != "player_role" and d.get("raw_rate") is not None}
        if not available:
            without_rate = 0.0
        else:
            weight_sum = sum(modules[m]["configured_weight"] for m in available)
            if weight_sum <= 0:
                without_rate = sum(available.values()) / len(available)
            else:
                without_rate = sum(modules[m]["configured_weight"] / weight_sum * rate for m, rate in available.items())
        with_rate = stat_detail["final_rate"]
        delta_rate = with_rate - without_rate
        delta_points = round(delta_rate * emf * points_each, 4)
        total_delta += delta_points
        per_stat[stat] = {
            "role_raw_rate": role["raw_rate"],
            "role_configured_weight": role["configured_weight"],
            "role_effective_weight": role["effective_weight"],
            "final_rate_with_role": with_rate,
            "blended_rate_without_role": round(without_rate, 4),
            "delta_points": delta_points,
        }
    return round(total_delta, 4), per_stat


def audit_game(cur, game_slug):
    base_rows = fetch_base_rows(cur, game_slug)
    team_totals = compute_team_totals(base_rows)
    proj_rows = fetch_projection_rows(cur, game_slug)

    players_out = []
    for row in proj_rows:
        inputs = row["inputs"]
        if not inputs:
            continue
        if isinstance(inputs, str):
            inputs = json.loads(inputs)
        base = base_rows.get(row["game_player_id"])
        if base is None:
            continue
        delta, per_stat = player_role_impact(inputs)
        if delta is None:
            continue
        games90 = base["minutes_played"] / 90.0
        players_out.append(
            {
                "game_player_id": row["game_player_id"],
                "full_name": row["full_name"],
                "position": row["position"],
                "team_name": row["team_name"],
                "price": float(row["price"]) if row["price"] is not None else None,
                "hail_mary_score": float(row["hail_mary_score"]) if row["hail_mary_score"] is not None else None,
                "player_role_impact_points": delta,
                "per_stat_detail": per_stat,
                "player_role_detail": inputs.get("player_role_detail"),
                "data_confidence": inputs.get("data_confidence"),
                "minutes_played": base["minutes_played"],
                "games90": round(games90, 2),
                "tiny_sample": 0 < base["minutes_played"] < TINY_SAMPLE_MINUTES,
                "has_historical_row": base["has_historical_row"],
                "historical_season": base["historical_season"],
                "historical_gameweek": base["historical_gameweek"],
            }
        )

    players_out.sort(key=lambda p: p["player_role_impact_points"])
    largest_negative = players_out[:15]
    largest_positive = list(reversed(players_out[-15:]))

    # Summary stats, by position and by sample-size bucket, to test
    # whether large swings concentrate in low-sample players (would
    # support capping/reducing weight for thin samples specifically)
    # or are spread evenly (would support a broader model rethink).
    def _stats(vals):
        vals = list(vals)
        if not vals:
            return None
        return {
            "n": len(vals),
            "mean": round(sum(vals) / len(vals), 3),
            "median": round(statistics.median(vals), 3),
            "stdev": round(statistics.pstdev(vals), 3) if len(vals) > 1 else 0.0,
            "pct_abs_gt_0_5": round(100 * sum(1 for v in vals if abs(v) > 0.5) / len(vals), 1),
            "pct_abs_gt_1_0": round(100 * sum(1 for v in vals if abs(v) > 1.0) / len(vals), 1),
        }

    impacts_by_position = {
        pos: _stats(p["player_role_impact_points"] for p in players_out if p["position"] == pos)
        for pos in ("GK", "DEF", "MID", "FWD")
    }
    tiny_impacts = [p["player_role_impact_points"] for p in players_out if p["tiny_sample"]]
    normal_impacts = [p["player_role_impact_points"] for p in players_out if not p["tiny_sample"]]
    summary_stats = {
        "by_position": impacts_by_position,
        "tiny_sample_players": _stats(tiny_impacts),
        "normal_sample_players": _stats(normal_impacts),
    }

    # Representative sample: per position, largest positive, largest
    # negative, a "typical" (median-impact) player, and a low-sample
    # player, deduped by game_player_id.
    sample = {}
    for pos in ("GK", "DEF", "MID", "FWD"):
        pos_players = [p for p in players_out if p["position"] == pos]
        if not pos_players:
            continue
        pos_players_sorted = sorted(pos_players, key=lambda p: p["player_role_impact_points"])
        picks = []
        picks.append(pos_players_sorted[0])  # most negative
        picks.append(pos_players_sorted[-1])  # most positive
        picks.append(pos_players_sorted[len(pos_players_sorted) // 2])  # median
        tiny = [p for p in pos_players if p["tiny_sample"] and p["player_role_impact_points"] != 0]
        if tiny:
            picks.append(max(tiny, key=lambda p: abs(p["player_role_impact_points"])))
        highest_priced = max(pos_players, key=lambda p: p["price"] or 0)
        picks.append(highest_priced)
        seen = set()
        deduped = []
        for p in picks:
            if p["game_player_id"] in seen:
                continue
            seen.add(p["game_player_id"])
            deduped.append(p)
        sample[pos] = deduped

    return {
        "game_slug": game_slug,
        "player_count_audited": len(players_out),
        "player_count_total_active": len(base_rows),
        "team_totals": {
            str(team_id): {
                "team_name": v["team_name"],
                "goal_total": v["goal_total"],
                "assist_total": v["assist_total"],
                "games90": round(v["games90"], 1),
                "player_count": v["player_count"],
            }
            for team_id, v in team_totals.items()
        },
        "largest_positive": largest_positive,
        "largest_negative": largest_negative,
        "representative_sample": sample,
        "summary_stats": summary_stats,
    }


def data_quality_checks(cur):
    out = {}

    # 1. Duplicate players - same normalized name, multiple player rows.
    cur.execute(
        """
        select lower(trim(full_name)) as key, array_agg(id) as ids, array_agg(team_id) as team_ids,
               array_agg(full_name) as names, count(*) as n
        from players
        group by lower(trim(full_name))
        having count(*) > 1
        order by n desc
        """
    )
    dupes = cur.fetchall()
    dup_out = []
    for d in dupes:
        cur.execute("select id, name from teams where id = any(%s)", (d["team_ids"],))
        team_names = {r["id"]: r["name"] for r in cur.fetchall()}
        # Per player_id: which game(s) it's rostered in, and the real
        # historical minutes/goals/assists on each - shows directly
        # whether this is (a) a harmless benign per-game duplicate where
        # both copies carry the SAME real record, (b) a genuine
        # cross-game matching gap where one copy is a zero-stat phantom
        # while the other holds the real record, or (c) an actual
        # double-count (both copies carrying real minutes on the SAME
        # game, which WOULD inflate that game's team total).
        per_id = []
        for pid in d["ids"]:
            cur.execute(
                """
                select fg.slug as game_slug, coalesce(gps.minutes_played, 0) as minutes,
                       coalesce(gps.goals, 0) as goals, coalesce(gps.assists, 0) as assists
                from game_players gp
                join fantasy_games fg on fg.id = gp.game_id
                left join game_player_stats gps
                    on gps.game_player_id = gp.id and gps.season = %s and gps.gameweek = 0
                where gp.player_id = %s and gp.is_active = true
                """,
                (HISTORICAL_SEASON, pid),
            )
            per_id.append({"player_id": pid, "rosters": [dict(r) for r in cur.fetchall()]})
        # Double-count risk: two DIFFERENT player_ids both showing real
        # minutes (>0) within the SAME game_slug - that genuinely inflates
        # that game's team_stat_totals denominator/numerator.
        by_game = {}
        for entry in per_id:
            for ros in entry["rosters"]:
                if ros["minutes"] > 0:
                    by_game.setdefault(ros["game_slug"], []).append(entry["player_id"])
        real_double_count = {g: ids for g, ids in by_game.items() if len(ids) > 1}
        dup_out.append(
            {
                "name_key": d["key"],
                "player_ids": d["ids"],
                "names_as_stored": d["names"],
                "teams": [team_names.get(tid) for tid in d["team_ids"]],
                "per_player_id_rosters": per_id,
                "confirmed_double_counted_in_game": real_double_count or None,
            }
        )
    out["duplicate_players"] = dup_out

    # 2. Transferred/departed players - team_changed activity_log events,
    # cross-referenced with whether that player has real historical
    # goal/assist output currently feeding their NEW team's total.
    cur.execute(
        """
        select al.created_at, al.summary, al.details, p.id as player_id, p.full_name, p.team_id as current_team_id,
               t_new.name as new_team_name, t_old.name as old_team_name
        from activity_log al
        join players p on p.id = (al.details->>'player_id')::bigint
        left join teams t_new on t_new.id = (al.details->>'new_team_id')::bigint
        left join teams t_old on t_old.id = (al.details->>'old_team_id')::bigint
        where al.event_type = 'team_changed'
        order by al.created_at desc
        """
    )
    transferred = cur.fetchall()
    transferred_out = []
    for r in transferred:
        cur.execute(
            """
            select coalesce(sum(gps.goals), 0) as goals, coalesce(sum(gps.assists), 0) as assists,
                   coalesce(sum(gps.minutes_played), 0) as minutes
            from game_player_stats gps
            join game_players gp on gp.id = gps.game_player_id
            where gp.player_id = %s and gps.season = %s and gps.gameweek = 0
            """,
            (r["player_id"], HISTORICAL_SEASON),
        )
        hist = cur.fetchone()
        transferred_out.append(
            {
                "player": r["full_name"],
                "moved_from": r["old_team_name"],
                "moved_to": r["new_team_name"],
                "changed_at": str(r["created_at"]),
                "historical_goals_now_counted_at_new_team": hist["goals"] if hist else None,
                "historical_assists_now_counted_at_new_team": hist["assists"] if hist else None,
                "historical_minutes": hist["minutes"] if hist else None,
            }
        )
    out["transferred_players"] = transferred_out

    # 3. Mismatched team attribution. Two separate counts per team,
    # because they answer different questions:
    #   - "all_time" = every players row ever attached to this team_id,
    #     regardless of whether it's on anyone's active roster today -
    #     inflated by historical/departed/loan entries that were never
    #     purged, NOT itself a Player Role bug (compute_team_stat_totals
    #     only sums the active roster - see below) but a sign the
    #     `players` table itself accumulates stale rows.
    #   - "active_roster" = only players rows with an is_active
    #     game_players row for this game - what compute_team_stat_totals
    #     ACTUALLY sums, so this is the number that matters operationally.
    #     Flagged outside a plausible Premier League squad size (~16-36).
    cur.execute(
        """
        select t.id, t.name, count(p.id) as player_count
        from teams t
        left join players p on p.team_id = t.id
        group by t.id, t.name
        order by player_count desc
        """
    )
    all_time_sizes = {r["id"]: r["player_count"] for r in cur.fetchall()}

    active_outliers = {}
    for game_slug in GAMES:
        cur.execute(
            """
            select t.id, t.name, count(distinct p.id) as player_count
            from teams t
            join players p on p.team_id = t.id
            join game_players gp on gp.player_id = p.id
            join fantasy_games fg on fg.id = gp.game_id
            where fg.slug = %s and gp.is_active = true
            group by t.id, t.name
            order by player_count desc
            """,
            (game_slug,),
        )
        rows = cur.fetchall()
        active_outliers[game_slug] = [
            {
                "team_id": r["id"],
                "team_name": r["name"],
                "active_roster_size": r["player_count"],
                "all_time_players_table_size": all_time_sizes.get(r["id"]),
            }
            for r in rows
            if r["player_count"] > 36 or r["player_count"] < 16
        ]
    out["active_roster_size_outliers"] = active_outliers
    out["all_time_players_table_note"] = (
        "players table rows per team_id regardless of active-roster status - informational only, "
        "NOT what compute_team_stat_totals sums (see active_roster_size_outliers for the operationally "
        "relevant check). Max all-time count observed: " + str(max(all_time_sizes.values(), default=0))
    )

    cur.execute("select count(*) as n from players where team_id is null")
    out["players_with_no_team"] = cur.fetchone()["n"]

    # 4. Inconsistent season windows - distinct (season, gameweek) pairs
    # actually present in game_player_stats, and how many currently-active
    # game_players have NO historical row at all (a genuine "no data",
    # silently coalesced to 0 by every query that left-joins it).
    cur.execute("select distinct season, gameweek from game_player_stats order by season, gameweek")
    out["season_gameweek_pairs_present"] = [{"season": r["season"], "gameweek": r["gameweek"]} for r in cur.fetchall()]

    for game_slug in GAMES:
        cur.execute(
            """
            select count(*) as n
            from game_players gp
            join fantasy_games fg on fg.id = gp.game_id
            left join game_player_stats gps
                on gps.game_player_id = gp.id and gps.season = %s and gps.gameweek = 0
            where fg.slug = %s and gp.is_active = true and gps.game_player_id is null
            """,
            (HISTORICAL_SEASON, game_slug),
        )
        out.setdefault("no_historical_row_count", {})[game_slug] = cur.fetchone()["n"]

    return out


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    report = {"games": {}, "data_quality": None}
    for game_slug in GAMES:
        sys.stderr.write(f"Auditing {game_slug}...\n")
        report["games"][game_slug] = audit_game(cur, game_slug)

    sys.stderr.write("Running data-quality checks...\n")
    report["data_quality"] = data_quality_checks(cur)

    cur.close()
    conn.close()
    print(json.dumps(report, indent=2, default=str))


if __name__ == "__main__":
    main()
