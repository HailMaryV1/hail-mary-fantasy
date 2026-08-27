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

Target Score is the ONLY player-quality rating shown anywhere in the app
(2026-08-27 site-wide consolidation - see the plan in git history for the
full rationale). Four sub-ratings, each independently mapped 1-10 via
absolute_rating() - a fixed, evidence-based scale (real distributions
measured once and frozen as hardcoded thresholds, same technique already
proven in frontend-v2/src/lib/fixtureDifficultyColor.ts), NOT a
percentile rank against whoever else happens to be in the pool this
gameweek. That distinction matters: a percentile-ranked "9/10" only ever
means "best of a weak field this week", which is exactly what let a
backup goalkeeper with a brutal fixture rate 9-10 (real user report,
2026-08-27) - an absolute "9/10" means the same thing regardless of who
else is around:

  - live_odds_rating: from real bookmaker odds only (never a fallback) -
    horizon-invariant, computed once and reused across every horizon,
    since real markets essentially never exist more than a gameweek out.
  - form_rating: from Recent Form's own real recency-weighted rate -
    also horizon-invariant, same "as of right now" reasoning. No real
    samples exist yet this early in the 2026/27 season - see
    FORM_ANCHORS_BY_POSITION's own comment.
  - fixture_difficulty_rating: POSITION-AWARE (a defender's difficulty
    reflects the opponent's attacking threat, a forward's reflects the
    opponent's defensive solidity - same attack/clean_sheet position
    split compute_projections.py's own DEFAULT_WEIGHTS already uses),
    averaged across every real fixture in the selected window.
  - fixture_quantity_rating: how many real fixtures the player's team
    has in the window, as a ratio against the window's own length (see
    FIXTURE_QUANTITY_RATIO_ANCHORS) so 1.0 always means "normal" whether
    the horizon is 1 gameweek or 5.

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


def fetch_window_projected_fixtures(cur, game_id, start_gameweek, horizon):
    """{team_id: [{"gameweek": gw, "competition": comp, "confidence": c}, ...]}
    - real per-team projected cup/Europe fixture entries
    (dreamteamtonic_projected_fixtures, migration 0154, scripts/
    scrape_dreamteamtonic_fixture_ticker.py's own docstring for the full
    TBA/IF story) for the window, ONLY for a (team_id, gameweek,
    competition) that doesn't already have a REAL fixture in game_
    fixture_gameweeks - once the real fixture is confirmed and lands
    there, this stops contributing on its own (both to the Fixture
    Quantity number below AND to window_fixtures' own displayed pill -
    2026-08-27 user report: "gameweek 3 is showing a double for plenty
    of teams [on the real ticker]... why are they not visible in the
    rankings, the player pool, the player cards" - this was previously
    folded into the RATING only, with nothing displayable, since there's
    no real opponent to show; now surfaced as an honest TBA/IF
    placeholder fixture entry too, opponent deliberately left null
    rather than fabricated). TBA = 1.0 (date real/confirmed, opponent
    just not yet drawn), IF = 0.5 (contingent on cup progression,
    genuinely uncertain)."""
    cur.execute(
        """
        select dpf.team_id, dpf.gameweek, dpf.competition, dpf.confidence
        from dreamteamtonic_projected_fixtures dpf
        where dpf.game_id = %s and dpf.gameweek >= %s and dpf.gameweek < %s
          and not exists (
            select 1
            from game_fixture_gameweeks gfg
            join fixtures f on f.id = gfg.fixture_id
            where gfg.game_id = dpf.game_id and gfg.gameweek = dpf.gameweek
              and f.competition = dpf.competition
              and (f.home_team_id = dpf.team_id or f.away_team_id = dpf.team_id)
          )
        order by dpf.team_id, dpf.gameweek
        """,
        (game_id, start_gameweek, start_gameweek + horizon),
    )
    out = {}
    for team_id, gameweek, competition, confidence in cur.fetchall():
        out.setdefault(team_id, []).append({"gameweek": gameweek, "competition": competition, "confidence": float(confidence)})
    return out


def fetch_projected_fixture_credits(cur, game_id, start_gameweek, horizon):
    """{team_id: credit_sum} - fetch_window_projected_fixtures' own
    entries summed by confidence, for Fixture Quantity's raw count."""
    credits = {}
    for team_id, entries in fetch_window_projected_fixtures(cur, game_id, start_gameweek, horizon).items():
        credits[team_id] = sum(e["confidence"] for e in entries)
    return credits


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


def absolute_rating(raw_value, anchors):
    """Fixed, evidence-based 1-10 mapping from a raw signal to an ABSOLUTE
    quality rating - piecewise-linear between real, hardcoded (raw_value,
    rating) control points, NOT a percentile rank against whoever else is
    in the pool this gameweek (that's what this replaces - see git history
    for the old bucket_by_group/assign_ratings approach). Real user report
    2026-08-27: a keeper with a brutal fixture was rating 9-10 purely
    because he topped a weak GK field that particular week - percentile
    ranking answers "who's best available right now", never "how good is
    this, really". A 10 here means the same thing in a strong week and a
    weak one.

    anchors: sorted ascending by raw_value. None passes through as None -
    never fabricates a rating for a signal that doesn't exist for this
    player. A raw_value outside the anchor range clamps to the nearest
    endpoint rating rather than extrapolating."""
    if raw_value is None:
        return None
    if raw_value <= anchors[0][0]:
        return anchors[0][1]
    if raw_value >= anchors[-1][0]:
        return anchors[-1][1]
    for (x0, y0), (x1, y1) in zip(anchors, anchors[1:]):
        if x0 <= raw_value <= x1:
            frac = (raw_value - x0) / (x1 - x0)
            return round(y0 + frac * (y1 - y0))
    return anchors[-1][1]


# Fixture Difficulty absolute anchors - same real quintile breakpoints
# already calibrated for the Tough/Average/Easy fixture pill colors
# (frontend-v2/src/lib/fixtureDifficultyColor.ts, 420 real fixtures'
# attack_score measured 2026-08-27), extended from 5 labels to a smooth
# 1-10 scale so the pill and the numeric rating always describe the same
# fixture the same way. ease = 1 - hardship (see ease_by_team_position
# below) - position-INDEPENDENT, since single_fixture_difficulty_raw
# already applies the attack/clean_sheet position weighting before this
# point, so one shared anchor list is correct here (unlike Live Odds
# below, which is genuinely different units per position).
FIXTURE_DIFFICULTY_EASE_ANCHORS = [(0.0, 1), (0.35, 3), (0.56, 5), (0.68, 7), (0.89, 9), (1.0, 10)]

# Live Odds absolute anchors - raw is a real points-per-fixture rate
# derived from bookmaker odds, on a genuinely different scale per position
# (a striker's real goal-rate isn't comparable to a defender's clean-
# sheet-adjacent rate) - frozen from the real horizon=1 raw distribution
# measured 2026-08-27 across all 4 games (n=987-3627 samples per
# position: min/p10/p25/median/p75/p90/max control points). No CLUB entry
# needed - EFL Fantasy's club pick has no live-odds signal at all
# (compute_stat_sum_raw always returns None for it, see POSITION_WEIGHTS'
# own comment above). Revisit once a full season's real odds have
# accumulated - this is a pre-season/early-season snapshot.
LIVE_ODDS_ANCHORS_BY_POSITION = {
    "GK":  [(0.0, 1), (0.148, 2), (0.311, 4), (0.455, 5), (1.484, 8), (2.695, 9), (3.773, 10)],
    "DEF": [(0.0, 1), (0.019, 2), (0.401, 4), (2.025, 5), (2.568, 7), (2.982, 9), (4.353, 10)],
    "MID": [(0.0, 1), (0.016, 2), (0.134, 3), (0.456, 5), (0.815, 7), (1.268, 9), (4.724, 10)],
    "FWD": [(0.0, 1), (0.026, 2), (0.578, 4), (0.951, 5), (1.259, 7), (1.565, 9), (4.089, 10)],
}

# Fixture Quantity absolute anchors - raw fixture count is converted to a
# RATIO against the window's horizon length before this (raw / horizon,
# see qty_rating_by_team below) so one anchor list works across
# horizon=1/2/3/5 without separate threshold sets: 1.0 = exactly one
# fixture per gameweek in the window (no blanks, no doubles - the normal
# case, rated a solid-but-unremarkable 6, not a mediocre 5). Anchors
# frozen from the real ratio distribution measured 2026-08-27 across
# every horizon (min observed 0.33-1.0 depending on horizon, max 1.4-2.0).
FIXTURE_QUANTITY_RATIO_ANCHORS = [(0.0, 1), (0.5, 3), (0.8, 5), (1.0, 6), (1.2, 7), (1.5, 9), (2.0, 10)]

# form_raw has zero real samples in the database as of 2026-08-27 (too
# early in the 2026/27 season for real recency-weighted data) - there is
# no real distribution to freeze into absolute anchors yet. Once real
# form data starts populating, measure it the same way LIVE_ODDS_ANCHORS_
# BY_POSITION was calibrated above and give this the same per-position
# shape; until then form_rating stays None for everyone, which
# compute_composite already renormalizes over correctly (see its own
# docstring) - never a fabricated number.
FORM_ANCHORS_BY_POSITION = None


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
        # See FORM_ANCHORS_BY_POSITION's own comment - no real data to
        # rate against yet, so every player stays None here.
        form_rating = {gpid: None for gpid in form_raw}
        odds_rating = {
            gpid: absolute_rating(raw, anchors) if (anchors := LIVE_ODDS_ANCHORS_BY_POSITION.get(position_of[gpid])) else None
            for gpid, raw in odds_raw.items()
        }

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
            # tougher fixtures) but FIXTURE_DIFFICULTY_EASE_ANCHORS maps
            # ascending-to-10 (higher input -> higher rating) - rating
            # hardship directly would rate the TOUGHEST run of fixtures
            # 10/10 and the easiest 1/10, exactly backwards (real user
            # report 2026-08-26: Chuba Akpom's genuinely brutal fixture
            # run was rating 10 while Haaland's genuinely easy run was
            # rating 1). Rate EASE (1 - hardship) instead, so higher
            # rating always means an easier run.
            ease_by_team_position = {k: (1.0 - v if v is not None else None) for k, v in diff_raw_by_team_position.items()}
            diff_rating_by_team_position = {
                k: absolute_rating(ease, FIXTURE_DIFFICULTY_EASE_ANCHORS) for k, ease in ease_by_team_position.items()
            }

            # Fixture Quantity is team-level only (not position-aware) -
            # one raw fixture count per team, summed across every
            # competition a team has fixtures in this window (a real bug
            # fixed live 2026-08-27: this used to OVERWRITE per
            # competition, silently discarding a team's cup/Europe
            # fixtures the moment they also had a real Premier League one
            # this window - the overwhelmingly common case, and exactly
            # what would have swallowed the projected credits added just
            # below).
            qty_raw_by_team = {}
            for (competition, team_id), count in fixture_counts.items():
                qty_raw_by_team[team_id] = qty_raw_by_team.get(team_id, 0) + count
            # Real projected cup/Europe fixtures (2026-08-27 user
            # request - "the fixture tickers show all the double
            # gameweeks coming up... it would massively help our
            # fixture QUANTITY even when the game is not populated
            # themselves") - see fetch_window_projected_fixtures' own
            # docstring. Dream Team only (fetch_window_projected_
            # fixtures itself is game-scoped via game_id, so this is a
            # genuine no-op for fanteam/cloudff/eflfantasy - they simply
            # have no rows in dreamteamtonic_projected_fixtures). Fetched
            # once here and reused below for window_fixtures' own
            # displayed TBA/IF placeholder pill, so the number and the
            # thing a user can actually see always agree.
            projected_fixtures_by_team = fetch_window_projected_fixtures(cur, game_id, gameweek, horizon)
            for team_id, entries in projected_fixtures_by_team.items():
                qty_raw_by_team[team_id] = qty_raw_by_team.get(team_id, 0) + sum(e["confidence"] for e in entries)
            # Ratio against the window length, not the raw count itself -
            # see FIXTURE_QUANTITY_RATIO_ANCHORS' own comment for why (one
            # absolute scale needs to work across horizon=1/2/3/5).
            qty_rating_by_team = {
                team_id: absolute_rating(raw / horizon, FIXTURE_QUANTITY_RATIO_ANCHORS) for team_id, raw in qty_raw_by_team.items()
            }

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
                ] + [
                    # A projected cup/Europe TBA/IF placeholder (see
                    # fetch_window_projected_fixtures) - deliberately no
                    # opponent_team_name/kickoff_at/difficulty_raw (all
                    # None): honest about what we don't know yet, never
                    # fabricated. is_projected/confidence let the
                    # frontend render this distinctly from a real
                    # fixture (2026-08-27 user report: these need to be
                    # visible, not just folded into the rating number).
                    {
                        "fixture_id": None,
                        "kickoff_at": None,
                        "is_home": None,
                        "opponent_team_name": None,
                        "opponent_attack_score": None,
                        "opponent_clean_sheet_score": None,
                        "gameweek": pf["gameweek"],
                        "competition": pf["competition"],
                        "difficulty_raw": None,
                        "is_projected": True,
                        "confidence": pf["confidence"],
                    }
                    for pf in projected_fixtures_by_team.get(team_id, [])
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
