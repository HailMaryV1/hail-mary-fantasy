"""
compute_target_scores.py
--------------------------
Target Score: a new layer above the single-gameweek Hail Mary Rating
(see compute_projections.py) - real user request 2026-08-23, prompted by
"When its ranking them i dont want 9/10 Nailed on - it means nothing..
I want a breakdown" plus a horizon selector (1/2/3/5 gameweeks) so a
player can be judged on more than just the next single gameweek.

Run AFTER compute_projections.py for a given (game_slug, gameweek) - it
reads that run's already-committed `projections` row rather than
recomputing anything, which is what lets it reuse is_rating_eligible's
"no rubbish" gate for free: a player without a real Hail Mary Rating
this gameweek gets no target_scores row at all, for any horizon.

Four sub-ratings, each independently bucketed 1-10 via the SAME
percentile math (assign_ratings) the engine already trusts for
hail_mary_rating itself, so every 1-10 number in the app means the same
thing:

  - live_odds_rating: from real bookmaker odds only (never a fallback) -
    horizon-invariant, computed once and reused across every horizon,
    since real markets essentially never exist more than a gameweek out.
  - form_rating: from Recent Form's own real recency-weighted rate -
    also horizon-invariant, same "as of right now" reasoning.
  - fixture_difficulty_rating: POSITION-AWARE (a defender's difficulty
    reflects the opponent's attacking threat, a forward's reflects the
    opponent's defensive solidity - same attack/clean_sheet position
    split compute_projections.py's own DEFAULT_WEIGHTS already uses),
    averaged across every real fixture in the selected window.
  - fixture_quantity_rating: how many real fixtures the player's team
    has in the window, ranked against every other team in the same
    competition's window.

Composite `target_score` blends whichever of the 4 are present, weighted
per horizon (odds/form dominate short horizons, fixture components
dominate long ones - see HORIZON_WEIGHTS), renormalized over available
signals only - never fabricates a number to fill a gap, then discounted
by the player's own expected minutes fraction (see opportunity_
multiplier below) - none of the 4 sub-ratings alone measure whether
THIS player is actually going to play.

RUN (mirrors compute_projections.py's own CLI):
    python3 scripts/compute_target_scores.py <game_slug> --gameweek <N>
"""

import os
import sys

import psycopg2
import psycopg2.extras

from compute_projections import (
    DEFAULT_WEIGHTS,
    RECENT_FORM_STATS,
    STAT_RATE_SCALE,
    assign_ratings,
    clean_sheet_reward_curve,
    fetch_scoring_rules,
    load_env,
)

HORIZONS = (1, 2, 3, 5)

# Real user report 2026-08-27: a confirmed Premier League backup
# goalkeeper (Illan Meslier, Arsenal - behind David Raya) was rating
# 9/10 on a 3-gameweek Target Score, ranking in the same top-5 list as
# genuine starters - "how the hell is a backup keeper in the top 5...
# players not likely to play should be nowhere near". Root cause:
# none of the 4 sub-ratings above measure the PLAYER's own chance of
# playing - Fixture Difficulty/Quantity are team-level, Live Odds/Form
# can come back None entirely for a fringe player (confirmed live:
# Meslier's own form_rating was None), so a backup at a club with easy
# fixtures could out-rank a starter at a club with hard ones. This
# discounts the final blended composite by the SAME expected_minutes_
# fraction the main Hail Mary Rating already uses (compute_projections.
# py's own Opportunity Model) - not a 5th visible sub-rating, so the 4
# existing 1-10 numbers keep meaning exactly what they already mean.
# 0.6 is the "no discount past this point" threshold - a real first-
# choice starter or a legitimate rotation-risk regular (expected to
# play at least ~54 minutes) should never be punished for occasionally
# being subbed early; the curve only bites below that, and bites hard
# by design as expected minutes approaches 0 (confirmed live: Meslier's
# real 0.074 fraction cuts a 9.06 composite down to ~1.1).
OPPORTUNITY_DISCOUNT_FLOOR_FRACTION = 0.6


def opportunity_multiplier(expected_minutes_fraction):
    if expected_minutes_fraction is None:
        return 1.0
    return min(1.0, expected_minutes_fraction / OPPORTUNITY_DISCOUNT_FLOOR_FRACTION)

# Confirmed with the user 2026-08-23: odds/form decay with horizon (real
# market signal about right now says progressively less about week 5);
# fixture components rise (that's what a multi-week horizon is actually
# for - rotation/captaincy planning over a run of games).
HORIZON_WEIGHTS = {
    1: {"live_odds": 0.50, "form": 0.20, "fixture_difficulty": 0.20, "fixture_quantity": 0.10},
    2: {"live_odds": 0.30, "form": 0.20, "fixture_difficulty": 0.25, "fixture_quantity": 0.25},
    3: {"live_odds": 0.15, "form": 0.20, "fixture_difficulty": 0.30, "fixture_quantity": 0.35},
    5: {"live_odds": 0.10, "form": 0.15, "fixture_difficulty": 0.35, "fixture_quantity": 0.40},
}

# EFL Fantasy's CLUB pick has no equivalent in compute_projections.py's
# own DEFAULT_WEIGHTS["position_weights"] (it's a whole-team pick, not
# GK/DEF/MID/FWD) - a club's own EFL Fantasy scoring rewards both goals
# and clean sheets/wins, so an even split is the defensible first-pass
# default rather than inventing an undiscussed formula. Fixture
# Difficulty is the only sub-rating this affects for CLUB; Live Odds/
# Form both come back None for CLUB regardless (compute_club_scores'
# separate loop never builds a module_detail/recent_form_detail for
# these rows - CLUB eligibility runs through a different real-odds check
# entirely, see compute_projections.py's compute_club_scores), so a
# CLUB row's composite ends up entirely fixture-driven, which is honest:
# a club pick's whole scoring IS about how that team's games go.
POSITION_WEIGHTS = {**DEFAULT_WEIGHTS["position_weights"], "CLUB": {"attack": 0.5, "clean_sheet": 0.5}}


def fetch_eligible_players(cur, game_id, gameweek):
    """Every game_players row whose LATEST projections row at this exact
    gameweek already has a real hail_mary_rating - i.e. already passed
    is_rating_eligible when compute_projections.py wrote it this run.
    This IS the "no rubbish" gate, applied with zero extra logic: a
    fixture-only player who failed that gate simply has no row here and
    is silently excluded from every horizon."""
    cur.execute(
        """
        select distinct on (pr.game_player_id) pr.game_player_id, gp.position_code, p.team_id, pr.inputs
        from projections pr
        join game_players gp on gp.id = pr.game_player_id
        join players p on p.id = gp.player_id
        where gp.game_id = %s and pr.gameweek = %s and pr.hail_mary_rating is not null
        order by pr.game_player_id, pr.created_at desc, pr.id desc
        """,
        (game_id, gameweek),
    )
    return [
        {"game_player_id": gpid, "position": position, "team_id": team_id, "inputs": inputs or {}}
        for gpid, position, team_id, inputs in cur.fetchall()
    ]


def compute_stat_sum_raw(inputs, position, scoring_rules, source):
    """source: 'live_odds' | 'form'. Sums raw_rate * expected_minutes_fraction
    * rate_scale * points_each - but ONLY for stats genuinely backed by
    the requested real source (bookmaker_data_source == 'real' for
    live_odds; a present Recent Form detail entry for form), same "real
    observation only, never a fallback" bar has_real_bookmaker_signal/
    has_recent_form_signal already apply to eligibility itself. Returns
    None if nothing qualifies - a player eligible purely via the OTHER
    source (real odds but no Recent Form yet, or vice versa) legitimately
    has one of these two blank, never a fabricated number.

    live_odds deliberately loops over EVERY module_detail stat, not just
    goal/assist - bookmaker_data_source() itself only ever returns 'real'
    for goal/assist/clean_sheet_60min (the only 3 stats with a genuine
    market), so a GK/DEF eligible purely via real clean-sheet odds (no
    real goal/assist market at all) would otherwise wrongly show a blank
    Live Odds despite being real-odds-eligible - confirmed live: Ben
    Johnson (dreamteam GW2) passed is_rating_eligible with a null
    live_odds_rating under the goal/assist-only version of this loop."""
    expected_minutes_fraction = inputs.get("expected_minutes_fraction")
    if expected_minutes_fraction is None:
        return None
    module_detail = inputs.get("module_detail") or {}
    total = 0.0
    any_real = False
    if source == "live_odds":
        for stat, detail in module_detail.items():
            if detail.get("bookmaker_data_source") != "real":
                continue
            raw_rate = detail.get("modules", {}).get("bookmaker_intelligence", {}).get("raw_rate")
            points_each = detail.get("points_each")
            if raw_rate is None or points_each is None:
                continue
            # Same clean_sheet_reward_curve the real hail_mary_score now
            # prices clean_sheet_60min through (2026-08-26 user request) -
            # otherwise Live Odds would silently disagree with the
            # engine it's meant to summarize for exactly this one stat.
            priced_rate = clean_sheet_reward_curve(raw_rate) if stat == "clean_sheet_60min" else raw_rate
            total += priced_rate * expected_minutes_fraction * STAT_RATE_SCALE.get(stat, 1.0) * points_each
            any_real = True
    else:
        recent_form_detail = inputs.get("recent_form_detail") or {}
        for stat in RECENT_FORM_STATS:
            stat_detail = recent_form_detail.get(stat)
            if not stat_detail or stat_detail.get("final_shrunk_rate") is None:
                continue
            points_each = (module_detail.get(stat) or {}).get("points_each")
            if points_each is None:
                points_each = scoring_rules.get(("all", stat), scoring_rules.get((position, stat)))
            if points_each is None:
                continue
            total += stat_detail["final_shrunk_rate"] * expected_minutes_fraction * STAT_RATE_SCALE.get(stat, 1.0) * points_each
            any_real = True
    return total if any_real else None


def fetch_window_fixture_rows(cur, game_id, start_gameweek, horizon):
    """One row per (team, real fixture) in [start_gameweek, start_gameweek
    + horizon - 1], with the OPPONENT's real attack_score/clean_sheet_score
    from team_fixture_difficulty (self-joined on fixture_id) - the same
    real win/clean-sheet-odds-derived numbers (real market odds where
    posted, auto-falling back to team_season_strength/Bradley-Terry
    synthetic probabilities otherwise) every other fixture-difficulty
    consumer in this codebase already trusts."""
    cur.execute(
        """
        select
            tfd_own.team_id, tfd_own.fixture_id, tfd_own.kickoff_at,
            (f.home_team_id = tfd_own.team_id) as is_home,
            t_opp.name as opponent_team_name,
            tfd_opp.attack_score as opponent_attack_score,
            tfd_opp.clean_sheet_score as opponent_clean_sheet_score,
            gfg.gameweek
        from game_fixture_gameweeks gfg
        join fixtures f on f.id = gfg.fixture_id
        join team_fixture_difficulty tfd_own on tfd_own.fixture_id = f.id and tfd_own.game_id = gfg.game_id
        join team_fixture_difficulty tfd_opp
            on tfd_opp.fixture_id = f.id and tfd_opp.game_id = gfg.game_id and tfd_opp.team_id != tfd_own.team_id
        join teams t_opp on t_opp.id = tfd_opp.team_id
        where gfg.game_id = %s and gfg.gameweek >= %s and gfg.gameweek < %s
        """,
        (game_id, start_gameweek, start_gameweek + horizon),
    )
    by_team = {}
    for team_id, fixture_id, kickoff_at, is_home, opponent_team_name, opp_attack, opp_clean_sheet, gameweek in cur.fetchall():
        by_team.setdefault(team_id, []).append(
            {
                "fixture_id": fixture_id,
                "kickoff_at": kickoff_at.isoformat() if kickoff_at else None,
                "is_home": is_home,
                "opponent_team_name": opponent_team_name,
                "opponent_attack_score": float(opp_attack) if opp_attack is not None else None,
                "opponent_clean_sheet_score": float(opp_clean_sheet) if opp_clean_sheet is not None else None,
                "gameweek": gameweek,
            }
        )
    return by_team


def fetch_window_fixture_counts(cur, game_id, start_gameweek, horizon):
    """{(competition, team_id): real fixture count} for the window - a
    blank gameweek is genuinely "no rows" (no status/postponed column
    exists anywhere in this schema), same known limitation the rest of
    this codebase already lives with."""
    cur.execute(
        """
        select team_id, competition, count(distinct fixture_id) as fixture_count
        from (
            select f.home_team_id as team_id, f.competition, f.id as fixture_id
            from game_fixture_gameweeks gfg join fixtures f on f.id = gfg.fixture_id
            where gfg.game_id = %s and gfg.gameweek >= %s and gfg.gameweek < %s
            union all
            select f.away_team_id as team_id, f.competition, f.id as fixture_id
            from game_fixture_gameweeks gfg join fixtures f on f.id = gfg.fixture_id
            where gfg.game_id = %s and gfg.gameweek >= %s and gfg.gameweek < %s
        ) x
        group by team_id, competition
        """,
        (game_id, start_gameweek, start_gameweek + horizon, game_id, start_gameweek, start_gameweek + horizon),
    )
    return {(competition, team_id): count for team_id, competition, count in cur.fetchall()}


def single_fixture_difficulty_raw(position, fixture):
    """Position-weighted opponent hardship (0-1, higher = harder) for ONE
    fixture - reuses DEFAULT_WEIGHTS' own attack/clean_sheet position
    split: FWD (attack=1.0) -> hard when the opponent defends well
    (opponent_clean_sheet_score). GK (clean_sheet=1.0) -> hard when the
    opponent attacks well (opponent_attack_score). DEF/MID blend both.
    None if this fixture has no real team_fixture_difficulty coverage on
    either side, or the position has no weight entry (e.g. an unmapped
    position). Shared by compute_fixture_difficulty_raw's window AVERAGE
    below and by main()'s per-fixture window_fixtures display (2026-08-26
    user request - real per-fixture difficulty pills on the ratings page
    and the downloadable card, not just one blended window-average)."""
    pw = POSITION_WEIGHTS.get(position)
    if not pw or fixture["opponent_attack_score"] is None or fixture["opponent_clean_sheet_score"] is None:
        return None
    return pw["attack"] * fixture["opponent_clean_sheet_score"] + pw["clean_sheet"] * fixture["opponent_attack_score"]


def compute_fixture_difficulty_raw(position, fixtures_for_team):
    """Mean (not sum - would double-count with Fixture Quantity; not
    worst-case - one bad fixture shouldn't erase an otherwise good run)
    across the window of single_fixture_difficulty_raw's per-fixture
    value. None if the team has zero window fixtures, or none have any
    real team_fixture_difficulty coverage."""
    per_fixture = [single_fixture_difficulty_raw(position, fx) for fx in fixtures_for_team]
    per_fixture = [v for v in per_fixture if v is not None]
    if not per_fixture:
        return None
    return sum(per_fixture) / len(per_fixture)


def bucket_by_group(raw_by_key, group_of):
    """raw_by_key: {key: raw_value_or_None}. group_of: {key: group_label}
    dict, OR a callable key -> group_label. Buckets 1-10 via
    assign_ratings independently within each distinct group (position,
    or competition) - a key with a None raw value is excluded entirely,
    never fabricated. Returns {key: rating}."""
    resolve_group = group_of if callable(group_of) else group_of.__getitem__
    by_group = {}
    for key, raw in raw_by_key.items():
        if raw is None:
            continue
        by_group.setdefault(resolve_group(key), []).append(key)
    result = {}
    for group, keys in by_group.items():
        ratings = assign_ratings([raw_by_key[k] for k in keys])
        result.update(zip(keys, ratings))
    return result


def compute_composite(sub_ratings, weights):
    """Weighted average over whichever of the 4 sub-ratings are present,
    renormalized so the weights actually used sum to 1.0 - the same
    renormalize-over-available-signal pattern modular_coverage already
    uses elsewhere in this engine. At least one of live_odds/form is
    guaranteed present (is_rating_eligible already required it), so this
    never returns None for an eligible row."""
    present = {k: v for k, v in sub_ratings.items() if v is not None}
    total_weight = sum(weights[k] for k in present)
    if total_weight <= 0:
        return round(sum(present.values()) / len(present), 2)
    return round(sum(weights[k] * v for k, v in present.items()) / total_weight, 2)


def write_target_scores(cur, rows):
    """rows: list of (game_player_id, horizon, start_gameweek,
    end_gameweek, target_score, form_rating, fixture_difficulty_rating,
    fixture_quantity_rating, live_odds_rating, inputs_dict) tuples."""
    if not rows:
        return
    psycopg2.extras.execute_values(
        cur,
        """
        insert into target_scores
            (game_player_id, horizon, start_gameweek, end_gameweek, target_score,
             form_rating, fixture_difficulty_rating, fixture_quantity_rating, live_odds_rating, inputs)
        values %s
        on conflict (game_player_id, horizon, start_gameweek) do update set
            end_gameweek = excluded.end_gameweek, target_score = excluded.target_score,
            form_rating = excluded.form_rating, fixture_difficulty_rating = excluded.fixture_difficulty_rating,
            fixture_quantity_rating = excluded.fixture_quantity_rating, live_odds_rating = excluded.live_odds_rating,
            inputs = excluded.inputs
        """,
        [
            (gpid, horizon, start_gw, end_gw, score, form_r, diff_r, qty_r, odds_r, psycopg2.extras.Json(inputs))
            for gpid, horizon, start_gw, end_gw, score, form_r, diff_r, qty_r, odds_r, inputs in rows
        ],
        template="(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
    )


def clear_stale_target_scores(cur, game_id, start_gameweek, eligible_game_player_ids):
    """A player who's lost eligibility since a past run (real odds/form
    that existed then no longer does) must not keep a stale target_scores
    row for any horizon at this anchor - mirrors clear_ratings' own "must
    not silently survive" rule. Eligibility is horizon-invariant (same
    eligible set feeds every horizon), so one delete covers all 4."""
    cur.execute(
        """
        delete from target_scores using game_players gp
        where target_scores.game_player_id = gp.id and gp.game_id = %s
          and target_scores.start_gameweek = %s
          and not (target_scores.game_player_id = any(%s))
        """,
        (game_id, start_gameweek, list(eligible_game_player_ids)),
    )


def main():
    args = sys.argv[1:]
    if len(args) != 3 or args[1] != "--gameweek":
        print("Usage: python3 compute_target_scores.py <game_slug> --gameweek <N>")
        sys.exit(1)
    game_slug, gameweek = args[0], int(args[2])

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute("select id from fantasy_games where slug = %s", (game_slug,))
        row = cur.fetchone()
        if not row:
            raise SystemExit(f"Unknown game slug: {game_slug}")
        game_id = row[0]

        scoring_rules = fetch_scoring_rules(cur, game_id)
        eligible = fetch_eligible_players(cur, game_id, gameweek)
        if not eligible:
            print(f"No eligible players for {game_slug} GW{gameweek} - nothing to compute.")
            clear_stale_target_scores(cur, game_id, gameweek, [])
            conn.commit()
            return

        position_of = {p["game_player_id"]: p["position"] for p in eligible}
        team_of = {p["game_player_id"]: p["team_id"] for p in eligible}

        # Horizon-invariant: computed once, reused unchanged across every
        # horizon's row for a player (confirmed with the user - Live
        # Odds/Form always reflect right now, only the fixture components
        # look ahead).
        form_raw = {p["game_player_id"]: compute_stat_sum_raw(p["inputs"], p["position"], scoring_rules, "form") for p in eligible}
        odds_raw = {p["game_player_id"]: compute_stat_sum_raw(p["inputs"], p["position"], scoring_rules, "live_odds") for p in eligible}
        form_rating = bucket_by_group(form_raw, position_of)
        odds_rating = bucket_by_group(odds_raw, position_of)

        total_written = 0
        for horizon in HORIZONS:
            end_gameweek = gameweek + horizon - 1
            weights = HORIZON_WEIGHTS[horizon]

            fixtures_by_team = fetch_window_fixture_rows(cur, game_id, gameweek, horizon)
            fixture_counts = fetch_window_fixture_counts(cur, game_id, gameweek, horizon)

            # Fixture Difficulty is position-aware AND team-aware - one
            # raw value per (team, position) pair, computed once and
            # shared by every eligible player at that (team, position).
            diff_raw_by_team_position = {}
            for gpid in position_of:
                key = (team_of[gpid], position_of[gpid])
                if key not in diff_raw_by_team_position:
                    diff_raw_by_team_position[key] = compute_fixture_difficulty_raw(position_of[gpid], fixtures_by_team.get(team_of[gpid], []))
            # compute_fixture_difficulty_raw returns HARDSHIP (higher =
            # tougher fixtures) but assign_ratings ranks its input
            # ascending-to-10 (higher input -> higher rating) - bucketing
            # hardship directly would rate the TOUGHEST run of fixtures
            # 10/10 and the easiest 1/10, exactly backwards (real user
            # report 2026-08-26: Chuba Akpom's genuinely brutal fixture
            # run was rating 10 while Haaland's genuinely easy run was
            # rating 1). Bucket EASE (1 - hardship) instead, so higher
            # rating always means an easier run - `raw` values are
            # bounded ~0-1 (a probability-weighted blend), so this stays
            # comfortably positive and never trips assign_ratings' "all
            # values <= 0" all-1s branch the way negating would have.
            ease_by_team_position = {k: (1.0 - v if v is not None else None) for k, v in diff_raw_by_team_position.items()}
            diff_rating_by_team_position = bucket_by_group(ease_by_team_position, lambda k: k[1])

            # Fixture Quantity is team-level only (not position-aware) -
            # one raw value per team, ranked within its own competition.
            qty_raw_by_team = {}
            competition_of_team = {}
            for (competition, team_id), count in fixture_counts.items():
                qty_raw_by_team[team_id] = count
                competition_of_team[team_id] = competition
            qty_rating_by_team = bucket_by_group(qty_raw_by_team, competition_of_team)

            rows = []
            for p in eligible:
                gpid, position, team_id = p["game_player_id"], p["position"], p["team_id"]
                diff_key = (team_id, position)
                sub_ratings = {
                    "live_odds": odds_rating.get(gpid),
                    "form": form_rating.get(gpid),
                    "fixture_difficulty": diff_rating_by_team_position.get(diff_key),
                    "fixture_quantity": qty_rating_by_team.get(team_id),
                }
                emf = p["inputs"].get("expected_minutes_fraction") if isinstance(p["inputs"], dict) else None
                opp_multiplier = opportunity_multiplier(emf)
                composite = round(compute_composite(sub_ratings, weights) * opp_multiplier, 2)
                # Real user request 2026-08-26: "use the difficulty pills
                # with differing colours too" on the per-fixture window
                # list, both on the ratings page and the card - each
                # fixture needs its OWN position-weighted difficulty, not
                # just the window average above (a team's fixture list is
                # shared across positions, but how hard it plays differs
                # by position - same reasoning compute_fixture_difficulty_
                # raw itself is built on).
                window_fixtures_for_position = [
                    {**fx, "difficulty_raw": round(v, 4) if (v := single_fixture_difficulty_raw(position, fx)) is not None else None}
                    for fx in fixtures_by_team.get(team_id, [])
                ]
                inputs = {
                    "form_raw": round(form_raw[gpid], 4) if form_raw[gpid] is not None else None,
                    "live_odds_raw": round(odds_raw[gpid], 4) if odds_raw[gpid] is not None else None,
                    "fixture_difficulty_raw": round(diff_raw_by_team_position[diff_key], 4) if diff_raw_by_team_position[diff_key] is not None else None,
                    "fixture_quantity_raw": qty_raw_by_team.get(team_id),
                    "weights_used": weights,
                    "sub_ratings": sub_ratings,
                    "expected_minutes_fraction": emf,
                    "opportunity_multiplier": round(opp_multiplier, 4),
                    "window_fixtures": window_fixtures_for_position,
                }
                rows.append((gpid, horizon, gameweek, end_gameweek, composite, sub_ratings["form"], sub_ratings["fixture_difficulty"], sub_ratings["fixture_quantity"], sub_ratings["live_odds"], inputs))

            write_target_scores(cur, rows)
            total_written += len(rows)

        clear_stale_target_scores(cur, game_id, gameweek, position_of.keys())
        conn.commit()
        print(f"Wrote {total_written} target_scores rows across {len(HORIZONS)} horizons for {game_slug} GW{gameweek} ({len(eligible)} eligible players).")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
