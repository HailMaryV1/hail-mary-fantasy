"""
compute_expected_goals.py
--------------------------
Real per-team expected goals, derived from the real bookmaker 1X2 (home/
draw/away win) market - 2026-08-20 user request, for the EFL-only "Market
Odds" page (Championship/League One/League Two - explicitly not Premier
League; scoped here the same way, not because the math couldn't apply
elsewhere).

fixture_team_totals (a real bookmaker team-goals line) exists but is
sparse in practice - checked live, every upcoming EFL fixture had
line IS NULL. attack_score (team_fixture_difficulty) is a WIN-probability
proxy, not a goals count - reusing it as "goals" would make a "Top 5 most
likely winners" grid and a "Top 5 highest goals" grid rank identically,
which isn't what a genuine goals metric should do.

Instead: solves for each team's Poisson goal-rate (lambda) that best
reproduces the REAL market's own home/draw/away win probabilities under
an independent-Poisson scoreline model (P(home=h, away=a) = Pois(h; lh) *
Pois(a; la), summed over h,a to get implied win/draw/loss). This is a
standard, well-documented odds-to-xG technique - a real number derived
from real market data, not a guess. Coarse-then-fine grid search (no
scipy dependency, and this is ~20 EFL fixtures a gameweek - a nested loop
costs nothing).

RUN:
    python3 scripts/compute_expected_goals.py
"""

import os
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent

EFL_COMPETITIONS = ("efl_championship", "efl_league_one", "efl_league_two")

MAX_GOALS = 8  # truncation point for the Poisson sum - tail beyond this is negligible for any realistic lambda.


def load_env():
    env_path = ROOT / ".env"
    if not env_path.exists():
        return  # CI sets real env vars directly - no .env file there.
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def poisson_pmf(k, lam):
    # Iterative form (not math.exp(-lam) * lam**k / factorial(k) directly)
    # avoids overflow for larger k at negligible extra cost - irrelevant at
    # MAX_GOALS=8, but a cheap, standard-form habit.
    p = pow(2.718281828459045, -lam)
    for i in range(1, k + 1):
        p *= lam / i
    return p


def implied_outcome_probs(lambda_home, lambda_away):
    home_win = draw = away_win = 0.0
    for h in range(MAX_GOALS + 1):
        ph = poisson_pmf(h, lambda_home)
        for a in range(MAX_GOALS + 1):
            pa = poisson_pmf(a, lambda_away)
            joint = ph * pa
            if h > a:
                home_win += joint
            elif h == a:
                draw += joint
            else:
                away_win += joint
    return home_win, draw, away_win


def solve_lambdas(target_home_win, target_draw, target_away_win, coarse_step=0.1, fine_step=0.01, fine_radius=0.15):
    """Two-stage grid search: coarse pass over a wide range, then a fine
    pass around the coarse winner. Loss compares all three implied outcome
    probabilities against the real market's - home_win/draw are enough to
    pin down (lambda_home, lambda_away) given they sum to 1 with away_win,
    but scoring all three keeps the search well-behaved near the edges of
    the grid."""
    def loss(lh, la):
        ih, idr, ia = implied_outcome_probs(lh, la)
        return (ih - target_home_win) ** 2 + (idr - target_draw) ** 2 + (ia - target_away_win) ** 2

    best_lh, best_la, best_loss = 1.0, 1.0, float("inf")
    lam = 0.2
    coarse_vals = []
    while lam <= 4.0:
        coarse_vals.append(round(lam, 2))
        lam += coarse_step
    for lh in coarse_vals:
        for la in coarse_vals:
            l = loss(lh, la)
            if l < best_loss:
                best_loss, best_lh, best_la = l, lh, la

    lo_h, hi_h = max(0.05, best_lh - fine_radius), best_lh + fine_radius
    lo_a, hi_a = max(0.05, best_la - fine_radius), best_la + fine_radius
    lh = lo_h
    fine_h = []
    while lh <= hi_h:
        fine_h.append(round(lh, 3))
        lh += fine_step
    fine_a = []
    la = lo_a
    while la <= hi_a:
        fine_a.append(round(la, 3))
        la += fine_step
    for lh in fine_h:
        for la in fine_a:
            l = loss(lh, la)
            if l < best_loss:
                best_loss, best_lh, best_la = l, lh, la

    return best_lh, best_la


def main():
    load_env()
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    conn.autocommit = False
    cur = conn.cursor()

    try:
        cur.execute(
            """
            select distinct on (fp.fixture_id)
                fp.fixture_id, f.home_team_id, f.away_team_id,
                fp.home_win_prob, fp.draw_prob, fp.away_win_prob
            from fixture_probabilities fp
            join fixtures f on f.id = fp.fixture_id
            where f.competition = any(%s)
            order by fp.fixture_id, fp.computed_at desc
            """,
            (list(EFL_COMPETITIONS),),
        )
        rows = cur.fetchall()

        written = 0
        for fixture_id, home_id, away_id, home_win_prob, draw_prob, away_win_prob in rows:
            lambda_home, lambda_away = solve_lambdas(float(home_win_prob), float(draw_prob), float(away_win_prob))
            for team_id, lam in ((home_id, lambda_home), (away_id, lambda_away)):
                cur.execute(
                    """
                    insert into fixture_expected_goals (fixture_id, team_id, expected_goals, computed_at)
                    values (%s, %s, %s, now())
                    on conflict (fixture_id, team_id)
                    do update set expected_goals = excluded.expected_goals, computed_at = excluded.computed_at
                    """,
                    (fixture_id, team_id, round(lam, 3)),
                )
                written += 1

        conn.commit()
        print(f"Computed expected goals for {written} (fixture, team) rows across {len(rows)} EFL fixtures.")
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
