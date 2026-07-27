"""
compute_golf_projections.py
------------------------------
Hail Mary Golf - the golf-specific scoring algorithm (own algorithm_versions
family "golf-v1", entirely separate from compute_projections.py's football
model per the explicit instruction to keep the two distinct).

WHY THIS ISN'T JUST "PROJECT FanTeam's OWN form/avg score": FanTeam's form/
totalPoints/avgStats are real signal (used below as inputs), but the whole
point of a "Hail Mary" algorithm is decomposing them into a real per-stat
projection through the real scoring table, priced correctly, with
uncertainty modeled - not re-displaying a number FanTeam already shows.

APPROACH - per-stat shrinkage, same technique compute_projections.py uses
for football (see get_or_create_algorithm_version, and the shrinkage
formula `(player_value*sample + k*cohort_avg) / (sample + k)`), applied to
golf's own confirmed stats instead of goals/assists/clean-sheets:

  golf_tournament_entries.avg_stats (migration 0045) already gives each
  golfer's own PER-TOURNAMENT AVERAGE rate for every scored category
  (birdie, par, bogey, eagle, doubleBogey, tripleBogeyOrWorse, noBogeys,
  threeConsecutiveBirdies, ro64, allFourSub70, bounceBack, betterThanEagle,
  and the top10/20/30/40/50/60 finish tiers), weighted by match_count (how
  many tournaments FanTeam's own average is drawn from). Each golfer's own
  rate is shrunk toward a match_count-weighted FIELD average (this
  tournament's own pool, not a global constant) for whichever stat, then
  priced through the real game_scoring_rules point values (migration 0047)
  and summed - genuinely decomposed and re-priced, not a copy of FanTeam's
  own score.

  Crucially: because avgStats is already a PER-TOURNAMENT average (not a
  per-round or per-made-cut-only average), a golfer who misses cuts often
  already has a LOWER average baked in (fewer holes played that week means
  fewer birdies/pars that tournament, pulling their average down) - so
  make-cut risk is already implicitly priced into the projection without
  needing a separate cut-probability multiplier bolted on top. made_cut_rate
  itself is still reported as its own output (your explicit spec asked for
  it), just not double-applied to the points total.

COURSE HISTORY vs COURSE FIT - still two genuinely distinct things, per the
original decision. COURSE FIT (a statistical-profile heuristic - does this
golfer's game suit what the data says about the course, independent of
whether they've ever played it) remains unbuilt: course_fit_score is still
left null with inputs.course_fit_available = false, rather than fabricating
a heuristic with zero underlying course-characteristics data behind it.

COURSE HISTORY (how a golfer has actually scored at THIS course before) is
now real, when available: migration 0050 added a manual-import path for
DataGolf's Course History tool (datagolf.com/course-history-tool) - the
user downloads its CSV export and uploads it via /golf/course-history,
since DataGolf's API needs a paid subscription and scraping their site
instead isn't something to do without one. Once a tournament's
golf_tournaments.course_id is linked to an uploaded course, each golfer's
real historical_true_sg/versus_expected/ch_adjustment/rounds_played
feeds in below as course_history_points_adjustment - shrunk toward 0 by
rounds_played (same shrink() mechanism as everything else here, just with
a neutral-zero prior instead of a field average, since "no course signal"
should mean "no adjustment", not "assume field-average course history").

Converting DataGolf's strokes-gained scale into FanTeam points needs an
explicit, honestly-approximate constant (POINTS_PER_STROKE_GAINED_PER_ROUND
below) - there's no authoritative stroke-to-fantasy-point exchange rate to
look up, so this is a reasoned assumption (roughly splitting the point gap
between a par and a birdie), not a fact, and is called out here rather than
buried. If a course has no import yet, course_history_points_adjustment is
0.0 and inputs.course_history is null - an honest gap, not a guess.

CAPTAIN (x1.25) / UNDERDOG (x1.25 on your cheapest pick, automatic) /
SAFETY-NET (a withdrawn pick is auto-replaced by an active same-or-cheaper
golfer, not a blunt zero) are real FanTeam mechanics confirmed from your
screenshot of the in-app rules, but they're TEAM-construction-time
concerns, not per-golfer ones - this script projects each golfer on their
own 1x merits; the team optimiser (Phase 3) is where captain/underdog
selection and safety-net-aware risk get applied.

SIMULATION: a genuine Monte Carlo pass (not a single point estimate),
BRANCHED on made_cut_rate (see branch_rates()/simulate() - this is the
made_cut_branching_v1 fix; the original v1 sim fed the SAME blended
per-tournament rate into every one of 3000 draws regardless of outcome,
which can only ever produce one narrow, unimodal bell curve - confirmed
against real 3M Open results: simulated stdev was under a quarter of
actual stdev, and 75%/83% of made-cut/missed-cut golfers finished outside
their own model's ceiling/floor). Each draw first rolls against
made_cut_rate to pick a made-cut or missed-cut branch, then draws that
branch's own count-stat rates (birdies, pars, bogeys, etc. - Poisson
variance, i.e. variance = mean, is a standard, defensible assumption for
count-like golf stats with no better variance estimate available from
this data source) plus, only in the made-cut branch, one discrete
finish-tier draw (the top10/20/.../60 + 1st/2nd/3rd tiers are
monotonic/nested in the real data - "finished top 10" trivially implies
"finished top 30" - so a simulated tournament awards only the single BEST
tier reached, not every tier cumulatively, matching how DFS position
bonuses actually pay out; tier probabilities are conditioned on making
the cut first, since finishing any numbered place structurally requires
it). floor/ceiling/mean/median/make-cut/top-finish/boom/bust
probabilities are read directly off the resulting distribution, not
hand-tuned multipliers. The deterministic expected_points figure
(headline hail_mary_score) is unaffected by this fix - it was already a
valid unbiased mean estimator (confirmed: +2.9 aggregate bias on real
graded data) since averaging over the branches individually gives the
same overall mean as the blended rate by construction; only the
distribution's SHAPE (floor/ceiling/spread) was wrong.

RUN:
    python3 scripts/compute_golf_projections.py <tournament_id_or_url>
"""

import json
import math
import os
import random
import re
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras

ROOT = Path(__file__).resolve().parent.parent

# Shrinkage strength in "tournaments" units, matching the role
# shrinkage_games plays for football - a golfer with far fewer tracked
# tournaments than this gets pulled hard toward the field average; someone
# with many more is barely adjusted. 8 tournaments (roughly a season's
# worth of tour starts before a real solo signal is trustworthy) is the
# same order of magnitude as football's 10-game constant.
SHRINKAGE_TOURNAMENTS = 8

SIMULATIONS = 3000

# Course history shrinkage + strokes-gained-to-fantasy-points conversion -
# see module docstring for why POINTS_PER_STROKE_GAINED_PER_ROUND is a
# documented assumption, not a known constant. SHRINKAGE_COURSE_ROUNDS is
# in ROUNDS (not tournaments, unlike SHRINKAGE_TOURNAMENTS above) - 16
# rounds is roughly 4 years of a course's typical single-visit-per-year
# tour stop, chosen as "several real years of signal" the same way
# SHRINKAGE_TOURNAMENTS was reasoned from a season's worth of starts.
SHRINKAGE_COURSE_ROUNDS = 16
POINTS_PER_STROKE_GAINED_PER_ROUND = 2.0
ROUNDS_PER_TOURNAMENT = 4

# avg_stats jsonb key -> game_scoring_rules.stat - only the stats
# confirmed live in the real FanTeam scoring table (migration 0047) are
# priced; anything else in avg_stats (rank1-9, remainingHoles, ...) has no
# scoring-rule row and is correctly ignored by price_stat() below.
COUNT_STAT_KEYS = {
    "birdie": "birdie",
    "par": "par",
    "bogey": "bogey",
    "eagle": "eagle",
    "doubleBogey": "double_bogey",
    "tripleBogeyOrWorse": "triple_bogey_or_worse",
    "noBogeys": "no_bogeys",
    "threeConsecutiveBirdies": "three_consecutive_birdies",
    "ro64": "round_of_64",
    "allFourSub70": "all_four_sub_70",
    "bounceBack": "bounce_back",
    "betterThanEagle": "hole_in_one",  # matches the real rule's own name, "Better than Eagle"
}

# Finish-tier ladder, best to worst - nested/monotonic in the real data
# (a top-10 finish trivially is also a top-30 finish), so a single
# simulated tournament resolves to exactly ONE of these (or none), not a
# cumulative stack. finish_1st/2nd/3rd use rank1/rank2/rank3 when a golfer
# actually has that exact-position history; top10/20/30/40/50/60 use
# FanTeam's own named finish-tier rates.
FINISH_TIERS = [
    ("finish_1st", "rank1"),
    ("finish_2nd", "rank2"),
    ("finish_3rd", "rank3"),
    ("top10", "top10"),
    ("top20", "top20"),
    ("top30", "top30"),
    ("top40", "top40"),
    ("top50", "top50"),
    ("top60", "top60"),
]

DEFAULT_WEIGHTS = {
    "shrinkage_tournaments": SHRINKAGE_TOURNAMENTS,
    "simulations": SIMULATIONS,
    # Fingerprint so a change to which stats are modeled mints a new
    # algorithm_versions revision even if no literal number changed - same
    # technique compute_projections.py's DEFAULT_WEIGHTS_V2 uses via
    # "stat_set"/"involvement_model".
    "count_stats": sorted(COUNT_STAT_KEYS.values()),
    "finish_tiers": [t for t, _ in FINISH_TIERS],
    "course_fit_available": False,
    # Bumped when simulate()'s distribution SHAPE changes (not just a
    # weight tweak) - see branch_rates()'s docstring. "made_cut_rate"
    # picks a branch first, "allFourSub70" is one particular stat forced
    # to 0 in the missed-cut branch since it's structurally impossible on
    # 2 rounds.
    "simulation_model": "made_cut_branching_v1",
    "course_history_mechanism": {
        "shrinkage_course_rounds": SHRINKAGE_COURSE_ROUNDS,
        "points_per_stroke_gained_per_round": POINTS_PER_STROKE_GAINED_PER_ROUND,
        "rounds_per_tournament": ROUNDS_PER_TOURNAMENT,
    },
}


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


def parse_tournament_id(arg: str) -> str:
    match = re.search(r"/participate/(\d+)", arg)
    if match:
        return match.group(1)
    if arg.strip().isdigit():
        return arg.strip()
    raise SystemExit(f"Couldn't extract a tournament ID from {arg!r} - pass a bare ID or a fanteam.com/fantasy/participate/<id> URL.")


def get_or_create_algorithm_version(cur, family, description, weights):
    """Identical mechanism to compute_projections.py's own function (see
    migration 0032's docstring) - not re-implemented differently, just
    scoped to this script's own DB cursor since compute_projections.py's
    version isn't imported (that file has football-specific globals like
    UPCOMING_SEASON this script doesn't want to depend on)."""
    cur.execute(
        "select id, revision, weights from algorithm_versions where family = %s order by revision desc limit 1",
        (family,),
    )
    row = cur.fetchone()

    if row is not None:
        existing_id, existing_revision, existing_weights = row
        if isinstance(existing_weights, str):
            existing_weights = json.loads(existing_weights)
        if existing_weights == weights:
            cur.execute("update algorithm_versions set description = %s where id = %s", (description, existing_id))
            return existing_id
        next_revision = existing_revision + 1
    else:
        next_revision = 1

    version_label = f"{family}.{next_revision}"
    cur.execute(
        "insert into algorithm_versions (version_label, family, revision, description, weights) values (%s, %s, %s, %s, %s) returning id",
        (version_label, family, next_revision, description, psycopg2.extras.Json(weights)),
    )
    return cur.fetchone()[0]


def fetch_scoring_rules(cur, game_id):
    cur.execute("select stat, points from game_scoring_rules where game_id = %s", (game_id,))
    return {stat: float(points) for stat, points in cur.fetchall()}


def fetch_tournament(cur, tournament_ref):
    cur.execute(
        "select id, game_id, fanteam_tournament_id, name, event_number, season_year, course_id from golf_tournaments where fanteam_tournament_id = %s",
        (tournament_ref,),
    )
    row = cur.fetchone()
    if not row:
        raise SystemExit(f"No golf_tournaments row for FanTeam tournament {tournament_ref!r} - run import_fanteam_golf.py first.")
    return row


def fetch_entries(cur, tournament_id):
    cur.execute(
        """
        select gte.id, gte.game_player_id, gp.golfer_id, g.full_name, gte.price, gte.lineup, gte.status,
               gte.match_count, gte.avg_stats
        from golf_tournament_entries gte
        join game_players gp on gp.id = gte.game_player_id
        join golfers g on g.id = gp.golfer_id
        where gte.tournament_id = %s
        """,
        (tournament_id,),
    )
    entries = []
    for entry_id, game_player_id, golfer_id, full_name, price, lineup, status, match_count, avg_stats in cur.fetchall():
        if isinstance(avg_stats, str):
            avg_stats = json.loads(avg_stats)
        entries.append(
            {
                "entry_id": entry_id,
                "game_player_id": game_player_id,
                "golfer_id": golfer_id,
                "full_name": full_name,
                "price": float(price) if price is not None else None,
                "lineup": lineup,
                "status": status,
                "match_count": match_count or 0,
                "avg_stats": avg_stats or {},
            }
        )
    return entries


def fetch_course_history(cur, course_id):
    """golfer_id -> real DataGolf course-history row, keyed for O(1) lookup
    per entry below. Empty dict (not an error) when course_id is None -
    the normal, expected state for any tournament nobody's uploaded a
    course-history CSV for yet."""
    if course_id is None:
        return {}
    cur.execute(
        """
        select golfer_id, rounds_played, historical_true_sg, versus_expected, ch_adjustment, experience_adjustment, year_finishes
        from golf_course_history_entries
        where course_id = %s and golfer_id is not null
        """,
        (course_id,),
    )
    result = {}
    for golfer_id, rounds_played, true_sg, versus_expected, ch_adjustment, experience_adjustment, year_finishes in cur.fetchall():
        result[golfer_id] = {
            "rounds_played": rounds_played,
            "historical_true_sg": float(true_sg) if true_sg is not None else None,
            "versus_expected": float(versus_expected) if versus_expected is not None else None,
            "ch_adjustment": float(ch_adjustment) if ch_adjustment is not None else None,
            "experience_adjustment": float(experience_adjustment) if experience_adjustment is not None else None,
            "year_finishes": year_finishes,
        }
    return result


def fetch_market_odds(cur, tournament_id):
    """golfer_id -> {market: {decimal_odds, implied_probability}}, from
    whatever's been manually pasted in at /golf/odds (migration 0051) -
    no golf odds API covers regular Tour events at a sane price, so this
    is bookmaker data the user copies in by hand. Purely informational
    here (see module docstring) - reported alongside the model's own
    probabilities for comparison, never blended into expected_points,
    since there's no principled way to weight "our simulation" against
    "the market" without inventing another conversion the same way
    course history's strokes-to-points one already had to be."""
    cur.execute(
        "select golfer_id, market, decimal_odds, implied_probability from golf_tournament_odds where tournament_id = %s and golfer_id is not null",
        (tournament_id,),
    )
    result = {}
    for golfer_id, market, decimal_odds, implied_probability in cur.fetchall():
        result.setdefault(golfer_id, {})[market] = {
            "decimal_odds": float(decimal_odds) if decimal_odds is not None else None,
            "implied_probability": float(implied_probability) if implied_probability is not None else None,
        }
    return result


def course_history_adjustment(ch_row):
    """Real course-history signal -> a shrunk FanTeam points adjustment.
    See module docstring for why the strokes-to-points conversion is a
    documented assumption. Shrinks ch_adjustment toward a neutral 0 (not
    a field average - "no course signal" should mean "no adjustment") by
    rounds_played, so a golfer with 2 rounds at this course barely moves
    while one with 20+ gets close to their full course-history figure."""
    if not ch_row or ch_row["ch_adjustment"] is None or not ch_row["rounds_played"]:
        return 0.0, None
    shrunk = shrink(ch_row["ch_adjustment"], ch_row["rounds_played"], 0.0, SHRINKAGE_COURSE_ROUNDS)
    points = shrunk * POINTS_PER_STROKE_GAINED_PER_ROUND * ROUNDS_PER_TOURNAMENT
    detail = {
        "rounds_played": ch_row["rounds_played"],
        "raw_ch_adjustment_strokes_per_round": ch_row["ch_adjustment"],
        "shrunk_ch_adjustment_strokes_per_round": round(shrunk, 4),
        "points_adjustment": round(points, 3),
        "historical_true_sg": ch_row["historical_true_sg"],
        "versus_expected": ch_row["versus_expected"],
        "year_finishes": ch_row["year_finishes"],
        "source": "datagolf",
    }
    return points, detail


def field_averages(entries):
    """Match_count-weighted field average for every count stat + finish
    tier - the shrinkage prior, computed fresh from THIS tournament's own
    pool (not a stored global constant), same "this game's own cohort"
    principle compute_shrunk_rates uses for football's position_avg."""
    sums = {key: 0.0 for key in list(COUNT_STAT_KEYS) + [rank_key for _, rank_key in FINISH_TIERS] + ["madeCut"]}
    weight_total = 0.0
    for e in entries:
        mc = e["match_count"]
        if mc <= 0:
            continue
        weight_total += mc
        for key in sums:
            value = e["avg_stats"].get(key)
            if value is not None:
                sums[key] += float(value) * mc
    if weight_total == 0:
        return {key: 0.0 for key in sums}
    return {key: total / weight_total for key, total in sums.items()}


def shrink(golfer_value, golfer_weight, cohort_avg, k):
    """Same shape as compute_projections.py's own shrinkage formula:
    (player_total + k*cohort_avg) / (player_sample + k), with
    golfer_value*golfer_weight standing in for a "total" since avg_stats
    only gives us a pre-averaged rate, not raw per-tournament totals."""
    if golfer_value is None:
        golfer_value = cohort_avg
        golfer_weight = 0
    return (golfer_value * golfer_weight + k * cohort_avg) / (golfer_weight + k)


# Confirmed live against the 3M Open's first graded results: 75% of
# golfers who made the cut scored ABOVE the model's own simulated
# ceiling, 83% who missed it scored BELOW the model's own floor (mean
# actual 92.8 vs mean ceiling 79.1 for made-cut golfers; mean actual 27.8
# vs mean floor 34.5 for missed-cut ones) - the simulated spread (stdev
# 7.6) was less than a quarter of the real spread (stdev 35.4). Root
# cause: avg_stats is a SEASON-BLENDED per-tournament rate (made-cut
# weeks and missed-cut weeks mixed into one number, see module docstring
# above), fed into simulate() as a single fixed Poisson rate for every
# one of the 3000 draws - made_cut_rate was computed and reported but
# never actually influenced the simulated distribution's shape, so a
# blended rate can only ever produce one narrow, unimodal bell curve,
# never the two genuinely distinct outcome clusters a real tournament
# produces.
#
# Fixed by decomposing the blended rate into two branch-specific rates
# and having each simulated draw pick a branch first (weighted by
# made_cut_rate), then draw from THAT branch's rates - see
# branch_rates() and the updated simulate() below.
ROUNDS_IF_MADE_CUT = 4
ROUNDS_IF_MISSED_CUT = 2

# allFourSub70 requires literally completing all 4 rounds under 70 - not
# just rare, structurally IMPOSSIBLE on 2 rounds. Every other count stat
# scales down proportionally with rounds played for the missed-cut
# branch (fewer holes played, proportionally fewer birdies/bogeys/etc.)
# - this one has to be forced to 0 instead, or the missed-cut branch
# would keep awarding it at a scaled-down-but-nonzero rate for something
# that literally cannot happen.
IMPOSSIBLE_IF_MISSED_CUT = {"allFourSub70"}


def branch_rates(shrunk_rates, exclusive_tier_probs, made_cut_rate):
    """Decomposes ONE blended per-tournament rate (mixing made-cut and
    missed-cut weeks together, per FanTeam's own avgStats) into two
    branch-specific rates, using only the data already available -
    FanTeam's API doesn't separately track "this golfer's rate specifically
    during weeks they made the cut" vs "weeks they missed", so this
    assumes a golfer's PER-ROUND rate is roughly constant regardless of
    outcome (same skill per hole) and the blended total just reflects how
    many rounds they typically get to play. Preserves the same overall
    mean by construction (implied_rounds is exactly what the blended rate
    was implicitly averaged over) - only the SHAPE/variance changes, not
    the central estimate.

    Finish tiers (top10/20/.../60, finish_1st/2nd/3rd) are conditioned on
    making the cut - you structurally cannot finish a numbered place
    without playing the weekend, so exclusive_tier_probs (already an
    unconditional per-tournament-attempt probability) is divided by
    made_cut_rate to get P(this tier | made the cut), which is what the
    made-cut branch of the simulation actually needs.
    """
    implied_rounds = made_cut_rate * ROUNDS_IF_MADE_CUT + (1 - made_cut_rate) * ROUNDS_IF_MISSED_CUT
    made_cut_stat_rates, missed_cut_stat_rates = {}, {}
    for jkey, rate in shrunk_rates.items():
        per_round = rate / implied_rounds if implied_rounds > 0 else 0.0
        made_cut_stat_rates[jkey] = per_round * ROUNDS_IF_MADE_CUT
        missed_cut_stat_rates[jkey] = 0.0 if jkey in IMPOSSIBLE_IF_MISSED_CUT else per_round * ROUNDS_IF_MISSED_CUT

    conditional_tier_probs = {
        label: (min(1.0, prob / made_cut_rate) if made_cut_rate > 0 else 0.0) for label, prob in exclusive_tier_probs.items()
    }
    return made_cut_stat_rates, missed_cut_stat_rates, conditional_tier_probs


def project_entry(entry, cohort, scoring_rules, weights):
    k = weights["shrinkage_tournaments"]
    mc = entry["match_count"]
    avg_stats = entry["avg_stats"]

    shrunk_rates = {}
    for jkey in COUNT_STAT_KEYS:
        shrunk_rates[jkey] = shrink(avg_stats.get(jkey), mc, cohort[jkey], k)
    tier_probs = {}
    for _, jkey in FINISH_TIERS:
        tier_probs[jkey] = max(0.0, min(1.0, shrink(avg_stats.get(jkey), mc, cohort[jkey], k)))

    # Nested tiers -> exclusive per-tier probability (P(exactly this tier,
    # not a better one)) via successive differences down the ladder,
    # best-to-worst. Anything left over after the worst tier is "outside
    # every scored tier" (misses the cut or finishes 61st+), worth nothing.
    exclusive = {}
    remaining = 1.0
    for label, jkey in FINISH_TIERS:
        this_tier = min(tier_probs[jkey], remaining)
        exclusive[label] = this_tier
        remaining = max(0.0, remaining - this_tier)
        # Each subsequent (worse) tier's raw probability already includes
        # everyone in the better tiers above it (monotonic), so re-clamp
        # against what's actually left, not the raw shrunk value again.
        remaining = min(remaining, 1.0)

    made_cut_rate = max(0.0, min(1.0, shrink(avg_stats.get("madeCut"), mc, cohort["madeCut"], k)))
    made_cut_stat_rates, missed_cut_stat_rates, conditional_tier_probs = branch_rates(shrunk_rates, exclusive, made_cut_rate)

    # Point value of one simulated draw's expected contribution per stat -
    # the deterministic "expected points" figure (mean of the count stats
    # * their point value, plus the finish-tier expected value).
    expected_points = 0.0
    priced = {}
    for jkey, stat in COUNT_STAT_KEYS.items():
        points = scoring_rules.get(stat)
        if points is None:
            continue
        contribution = shrunk_rates[jkey] * points
        priced[stat] = {"rate": round(shrunk_rates[jkey], 4), "points_each": points, "contribution": round(contribution, 3)}
        expected_points += contribution

    finish_ev = 0.0
    for label, _ in FINISH_TIERS:
        points = scoring_rules.get(label)
        if points is None:
            continue
        contribution = exclusive[label] * points
        priced[label] = {"probability": round(exclusive[label], 4), "points_each": points, "contribution": round(contribution, 3)}
        finish_ev += contribution
    expected_points += finish_ev

    return {
        "shrunk_rates": shrunk_rates,
        "exclusive_tier_probs": exclusive,
        "made_cut_rate": made_cut_rate,
        "made_cut_stat_rates": made_cut_stat_rates,
        "missed_cut_stat_rates": missed_cut_stat_rates,
        "conditional_tier_probs": conditional_tier_probs,
        "expected_points": expected_points,
        "priced": priced,
    }


def availability_multiplier(lineup, status):
    """Confirmed live: lineup='refuted'/status='not_play' = withdrawn. No
    partial-availability states have been observed for golf (unlike
    football's EXP/MAY/BEN spread) - binary for now, same fail-open-to-1.0
    philosophy as football's LINEUP_MULTIPLIERS for anything unrecognized."""
    if lineup == "refuted" or status == "not_play":
        return 0.0
    return 1.0


def poisson_draw(lam):
    """Small pure-Python Poisson sampler (Knuth's algorithm) - avoids
    adding numpy as a dependency for one script. Fine for the small
    (typically well under 30) lambdas golf stat rates produce."""
    if lam <= 0:
        return 0
    limit = math.exp(-lam)
    k, p = 0, 1.0
    while True:
        k += 1
        p *= random.random()
        if p <= limit:
            return k - 1


def simulate(made_cut_rate, made_cut_stat_rates, missed_cut_stat_rates, conditional_tier_probs, scoring_rules, n):
    """Monte Carlo draws, branched on made-cut probability - see the
    branch_rates() docstring and the block comment above it for why: a
    single blended rate can only ever produce one narrow, unimodal
    distribution, never golf's real bimodal made-cut/missed-cut spread.

    Each of the n draws first rolls against made_cut_rate to pick a
    branch, THEN draws that branch's count stats (and, only if the
    made-cut branch was picked, a finish-tier bonus from the
    cut-conditional probabilities - you can't finish a numbered place
    without playing the weekend)."""
    made_cut_items = [(stat, made_cut_stat_rates[jkey]) for jkey, stat in COUNT_STAT_KEYS.items() if stat in scoring_rules]
    missed_cut_items = [(stat, missed_cut_stat_rates[jkey]) for jkey, stat in COUNT_STAT_KEYS.items() if stat in scoring_rules]
    tier_labels = list(conditional_tier_probs.keys())
    tier_cum = []
    running = 0.0
    for label in tier_labels:
        running += conditional_tier_probs[label]
        tier_cum.append((running, label))

    totals = []
    for _ in range(n):
        total = 0.0
        made_cut = random.random() < made_cut_rate
        count_items = made_cut_items if made_cut else missed_cut_items
        for stat, rate in count_items:
            total += poisson_draw(max(rate, 0.0)) * scoring_rules[stat]
        if made_cut:
            roll = random.random()
            for cum, label in tier_cum:
                if roll <= cum and label in scoring_rules:
                    total += scoring_rules[label]
                    break
        totals.append(total)
    return totals


def percentile(sorted_values, p):
    if not sorted_values:
        return 0.0
    idx = min(len(sorted_values) - 1, max(0, round(p * (len(sorted_values) - 1))))
    return sorted_values[idx]


def upsert_projection(cur, algo_id, game_id, game_player_id, gameweek, season, score, inputs):
    cur.execute(
        """
        insert into projections (algorithm_version_id, game_player_id, season, gameweek, hail_mary_score, inputs)
        values (%s, %s, %s, %s, %s, %s)
        on conflict (algorithm_version_id, game_player_id, gameweek) where gameweek is not null
            do update set hail_mary_score = excluded.hail_mary_score, inputs = excluded.inputs
        """,
        (algo_id, game_player_id, season, gameweek, round(score, 3), psycopg2.extras.Json(inputs)),
    )


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python3 scripts/compute_golf_projections.py <tournament_id_or_url>")
    tournament_ref = parse_tournament_id(sys.argv[1])

    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        tournament_id, game_id, fanteam_tournament_id, name, event_number, season_year, course_id = fetch_tournament(cur, tournament_ref)
        scoring_rules = fetch_scoring_rules(cur, game_id)
        if not scoring_rules:
            raise SystemExit("No game_scoring_rules found for fanteam-golf - run migrations 0045/0047 first.")

        entries = fetch_entries(cur, tournament_id)
        if not entries:
            raise SystemExit(f"No golf_tournament_entries for tournament {tournament_id} - run import_fanteam_golf.py first.")

        course_history = fetch_course_history(cur, course_id)
        if course_id is None:
            print(f"No course linked to \"{name}\" yet - course_history_points_adjustment will be 0.0 for every golfer. Link one at /golf/course-history.")
        else:
            print(f"Course history: {len(course_history)} golfer(s) matched for this tournament's linked course.")

        market_odds = fetch_market_odds(cur, tournament_id)
        print(f"Market odds: {len(market_odds)} golfer(s) with at least one pasted-in bookmaker market.")

        cohort = field_averages(entries)
        algo_id = get_or_create_algorithm_version(
            cur, "golf-v1",
            "Hail Mary Golf v1 - per-stat shrinkage projection + Monte Carlo simulation, real FanTeam scoring rules",
            DEFAULT_WEIGHTS,
        )

        gameweek = event_number
        season = str(season_year) if season_year else "unknown"

        written = 0
        for entry in entries:
            proj = project_entry(entry, cohort, scoring_rules, DEFAULT_WEIGHTS)
            avail = availability_multiplier(entry["lineup"], entry["status"])
            ch_points, ch_detail = course_history_adjustment(course_history.get(entry["golfer_id"]))
            expected_points = (proj["expected_points"] + ch_points) * avail

            sim_totals = sorted(
                v * avail
                for v in simulate(
                    proj["made_cut_rate"],
                    proj["made_cut_stat_rates"],
                    proj["missed_cut_stat_rates"],
                    proj["conditional_tier_probs"],
                    scoring_rules,
                    DEFAULT_WEIGHTS["simulations"],
                )
            ) if avail > 0 else [0.0] * DEFAULT_WEIGHTS["simulations"]
            # Course history is a deterministic adjustment (no per-round
            # variance estimate exists for it), so it shifts the whole
            # simulated distribution by a constant rather than being drawn
            # stochastically like the count/finish-tier stats above.
            if avail > 0 and ch_points:
                sim_totals = sorted(v + ch_points for v in sim_totals)

            floor = percentile(sim_totals, 0.05)
            ceiling = percentile(sim_totals, 0.95)
            median = percentile(sim_totals, 0.50)
            mean_sim = sum(sim_totals) / len(sim_totals) if sim_totals else 0.0
            # "Boom" = a result well above the mean (90th pctile threshold),
            # "bust" = well below it (10th) - probability mass beyond each,
            # not fixed point thresholds, so this stays meaningful across
            # very different price/quality tiers.
            boom_threshold = percentile(sim_totals, 0.90)
            bust_threshold = percentile(sim_totals, 0.10)
            boom_probability = sum(1 for v in sim_totals if v >= boom_threshold) / len(sim_totals) if sim_totals else 0.0
            bust_probability = sum(1 for v in sim_totals if v <= bust_threshold) / len(sim_totals) if sim_totals else 0.0
            top_finish_probability = proj["exclusive_tier_probs"].get("top10", 0.0) + proj["exclusive_tier_probs"].get("finish_1st", 0.0) \
                + proj["exclusive_tier_probs"].get("finish_2nd", 0.0) + proj["exclusive_tier_probs"].get("finish_3rd", 0.0)

            value = round(expected_points / entry["price"], 3) if entry["price"] else None

            reasons = []
            if avail == 0:
                reasons.append(f"{entry['full_name']} is withdrawn/not playing this tournament - projected at 0 (FanTeam's safety-net will substitute an active golfer at team level, not reflected in this per-golfer figure).")
            else:
                top_stat = max(proj["priced"].items(), key=lambda kv: kv[1]["contribution"], default=(None, None))
                if top_stat[0]:
                    reasons.append(f"Biggest single contributor: {top_stat[0]} ({top_stat[1]['contribution']:+.2f} pts from a {top_stat[1].get('rate', top_stat[1].get('probability'))} rate).")
                if entry["match_count"] < DEFAULT_WEIGHTS["shrinkage_tournaments"]:
                    reasons.append(f"Only {entry['match_count']} tracked tournament(s) - projection leans toward the field average until more history accumulates.")
                if ch_detail:
                    sign = "boosts" if ch_points >= 0 else "docks"
                    reasons.append(
                        f"Course history at this venue ({ch_detail['rounds_played']} rounds, {ch_detail['versus_expected']:+.2f} strokes gained vs expectation) "
                        f"{sign} the projection by {ch_points:+.2f} pts."
                    )

            golfer_odds = market_odds.get(entry["golfer_id"])
            model_win_probability = proj["exclusive_tier_probs"].get("finish_1st", 0.0)
            if golfer_odds and "win" in golfer_odds and golfer_odds["win"]["implied_probability"] is not None:
                market_win_probability = golfer_odds["win"]["implied_probability"]
                # Purely a comparison note, not a correction - the market
                # figure includes bookmaker overround (implied probabilities
                # across a full field sum to >100%) so isn't a clean "true"
                # probability either; it's a second opinion, not an answer.
                diff = model_win_probability - market_win_probability
                if abs(diff) >= 0.02:
                    verdict = "our model is higher on" if diff > 0 else "the market is higher on"
                    reasons.append(
                        f"Win probability: model {model_win_probability:.1%} vs market {market_win_probability:.1%} - {verdict} this golfer."
                    )

            inputs = {
                "tournament_id": tournament_id,
                "fanteam_tournament_id": fanteam_tournament_id,
                "match_count": entry["match_count"],
                "availability_multiplier": avail,
                "made_cut_rate": proj["made_cut_rate"],
                "shrunk_rates": {k: round(v, 4) for k, v in proj["shrunk_rates"].items()},
                "exclusive_tier_probabilities": {k: round(v, 4) for k, v in proj["exclusive_tier_probs"].items()},
                "priced": proj["priced"],
                "floor": round(floor, 2),
                "ceiling": round(ceiling, 2),
                "median": round(median, 2),
                "mean_simulated": round(mean_sim, 2),
                "make_cut_probability": round(proj["made_cut_rate"], 4) if proj["made_cut_rate"] is not None else None,
                "top_finish_probability": round(top_finish_probability, 4),
                "boom_probability": round(boom_probability, 4),
                "bust_probability": round(bust_probability, 4),
                "value": value,
                "price": entry["price"],
                "course_fit_score": None,  # honest - no course-characteristics data source integrated, see module docstring
                "course_fit_available": False,
                "course_history_points_adjustment": round(ch_points, 3),
                "course_history": ch_detail,  # null when no course linked, or golfer has no history there
                "model_win_probability": round(model_win_probability, 4),
                "market_odds": golfer_odds,  # null when nobody's pasted in odds for this golfer/tournament yet
                "explanation": " ".join(reasons),
            }

            upsert_projection(cur, algo_id, game_id, entry["game_player_id"], gameweek, season, expected_points, inputs)
            written += 1

        conn.commit()
        print(f"Wrote {written} golf projections for \"{name}\" (algorithm golf-v1, gameweek {gameweek}).")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
