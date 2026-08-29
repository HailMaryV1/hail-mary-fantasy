"""
refresh_all.py
----------------
Single entrypoint for the automated data-refresh pipeline: odds -> fixture
extras -> SportMonks player props -> probabilities -> FanTeam player
pull -> import -> recompute scores for every upcoming gameweek, then the
same players/fixtures/recompute shape again for Cloud FF, EFL Fantasy,
Dream Team, and Golf, finishing with the cross-game wrap-up (actuals
capture, prediction freezing, grading). Every step here is
authentication-free (the FanTeam player pull needs no login - confirmed
live, see scraper_fanteam.py; Cloud FF's getPlayerList and fixtures.json
are both confirmed live unauthenticated, see scraper_cloudff.py) so this
can run entirely unattended in CI.

2026-08-17: restructured into named per-section functions (run_shared_
odds/run_fanteam/run_cloudff/run_eflfantasy/run_dreamteam/run_golf/
run_wrapup) behind a `--only <section>` flag, so each game can run on its
own staggered GitHub Actions schedule instead of one long sequential
job - see .github/workflows/refresh_*.yml. This was a genuine operational
problem, not a style preference: this script running all ~49 steps back
to back had already needed its GitHub Actions timeout raised once (30min
-> 55min, see that workflow's own history), and running several games'
score recomputes concurrently (which staggering avoids entirely, unlike
true parallelism) was directly observed today causing statement-timeout
failures on shared tables (algorithm_versions, bookmaker_player_features)
under concurrent write load. No step's INTERNAL logic changed in this
restructure - every subprocess call, its exact argument list, and every
comment explaining why a step is ordered where it is, is unchanged from
the single-file version; only the grouping/dispatch is new. Omitting
--only (or passing nothing) still runs every section in the original
order, for local end-to-end testing.

Deliberately excludes:
  - compute_team_strength.py - manually re-run from screenshot odds, not
    on a schedule (see its own docstring).
  - FanTeam's fixture/gameweek-calendar refresh - needs a real login
    token that eventually expires (confirmed - see scraper_fanteam.py's
    fetch_fixtures docstring). Manual/occasional path only, run by hand
    if the season's schedule ever changes.
  - Dream Team's own score recompute for future gameweeks - players/
    prices AND its real gameweek calendar are both refreshed here now
    (scraper_dreamteam.py + import_dreamteam.py, both unauthenticated;
    the gameweek calendar is copied from FanTeam's own real
    game_fixture_gameweeks rows rather than scraped fresh - see
    import_dreamteam.py's docstring for why).
  - Cloud FF's own Auto Import My Squad sync (scripts/sync_provider_
    squads.py) - that's a per-user credential flow with its own
    dedicated scheduled workflows (provider_sync_requested.yml /
    provider_sync_scheduled.yml), not part of this game-data refresh.

Each step's failure is logged but doesn't abort the rest of ITS OWN
section (e.g. a transient Odds API hiccup shouldn't also block the
FanTeam player pull, or vice versa) - a section exits non-zero only if
something within it failed, so GitHub Actions surfaces a red run for
that section alone.

RUN:
    python3 scripts/refresh_all.py                 # everything, in order
    python3 scripts/refresh_all.py --only fanteam   # just one section
"""

import os
import subprocess
import sys
from pathlib import Path

import psycopg2

ROOT = Path(__file__).resolve().parent.parent
MAX_GAMEWEEKS_AHEAD = 5

# Matches this file's section functions 1:1, and the `section:` argument
# each .github/workflows/refresh_*.yml passes via --only. Order here is
# the order a no-flag (full) run executes them in - unchanged from the
# original single-file version.
SECTIONS = ["shared_odds", "fanteam", "cloudff", "eflfantasy", "dreamteam", "golf", "wrapup"]


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


def run_step(label, relative_args):
    print(f"\n=== {label} ===")
    result = subprocess.run([sys.executable, *relative_args], cwd=ROOT)
    ok = result.returncode == 0
    if not ok:
        print(f"[FAILED] {label} (exit {result.returncode})")
    return ok


def active_golf_tournaments(conn):
    """Every tournament that still needs its own re-scrape, not just the
    single most-recently-STARTED one. Importing a brand-new week's
    tournament (via /golf/import) already makes it the newest by
    start_time with zero extra step needed - the query below picks it up
    on the very next run automatically. The real gap this closes: the
    OLD tournament stops being scraped the instant a newer one exists,
    even if its last scrape landed before its own end_time (confirmed
    live, 2026-08-06 - a tournament's raw.points was last updated ~3
    hours before its official end_time, then frozen there forever once
    the next tournament's import made it no longer "the" current one).
    Keeping any tournament whose end_time is within the last 48h in the
    refresh set gives it a few more twice-daily cycles to catch FanTeam
    posting truly final scores, without re-scraping the entire history
    forever. Returns [] if FanTeam Golf isn't seeded at all yet or no
    tournament has ever been imported - either is a legitimate steady
    state, not an error."""
    cur = conn.cursor()
    cur.execute(
        """
        select t.fanteam_tournament_id
        from golf_tournaments t
        join fantasy_games fg on fg.id = t.game_id
        where fg.slug = 'fanteam-golf'
          and t.end_time > now() - interval '48 hours'
        order by t.start_time desc
        """
    )
    return [row[0] for row in cur.fetchall()]


# Games whose real scoring is Premier-League-only (see capture_gameweek_
# actuals.py's own capture_dreamteam_actuals fix, same root cause here) -
# assign_dreamteam_cup_gameweeks.py buckets Carabao Cup/FA Cup/European
# fixtures into the SAME gameweek number as the real league round they
# fall within, so an unfiltered "any fixture in this bucket kicks off in
# the future" check can keep a gameweek looking "upcoming" purely because
# of a cup tie, well after the real league round it belongs to has
# already finished (real user report 2026-08-27: Dream Team GW1 still
# being treated as needing a recompute the same night its own trailing
# League Cup tie kicked off, days after GW1's real Premier League
# fixtures were done). FanTeam/Cloud FF have no cup-bucketing step at
# all - every one of their own fixtures already IS 'soccer_epl', so this
# filter is a total no-op for them, not just "safe". EFL Fantasy is
# deliberately excluded - its own real competitions (Championship/League
# One/League Two) are never 'soccer_epl' at all, so filtering to it
# there would return nothing.
PL_ONLY_SCORED_GAMES = {"dreamteam", "fanteam", "cloudff"}


def upcoming_gameweeks(conn, game_slug):
    cur = conn.cursor()
    competition_filter = "and f.competition = 'soccer_epl'" if game_slug in PL_ONLY_SCORED_GAMES else ""
    cur.execute(
        f"""
        select distinct gfg.gameweek
        from game_fixture_gameweeks gfg
        join fixtures f on f.id = gfg.fixture_id
        join fantasy_games fg on fg.id = gfg.game_id
        where fg.slug = %s and f.kickoff_at >= now() {competition_filter}
        order by gfg.gameweek
        limit %s
        """,
        (game_slug, MAX_GAMEWEEKS_AHEAD),
    )
    return [row[0] for row in cur.fetchall()]


def recompute_section(game_slug, label):
    """Shared by fanteam/cloudff/eflfantasy/dreamteam below - each just
    differs in which game_slug/label to recompute for. Returns the list
    of per-gameweek step results."""
    results = []
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        gameweeks = upcoming_gameweeks(conn, game_slug)
    finally:
        conn.close()

    if not gameweeks:
        print(f"\nNo upcoming {label} gameweeks found in game_fixture_gameweeks - skipping score recompute.")
    else:
        print(f"\nRecomputing Hail Mary Score for {label} gameweeks: {gameweeks}")
        for gw in gameweeks:
            results.append(
                run_step(f"Recompute {label} GW{gw}", ["scripts/compute_projections.py", game_slug, "--gameweek", str(gw)])
            )
            # Target Score (2026-08-23 user request - horizon-aware
            # 1/2/3/5-gameweek ranking) reads THIS gameweek's just-committed
            # hail_mary_rating rather than recomputing anything, so it must
            # run immediately after, not in a separate pass - see
            # compute_target_scores.py's own docstring.
            results.append(
                run_step(f"Target scores {label} GW{gw}", ["scripts/compute_target_scores.py", game_slug, "--gameweek", str(gw)])
            )
    return results


def run_shared_odds():
    """Odds/fixtures/probabilities - feeds every game at once (a Premier
    League fixture's odds matter to FanTeam, Cloud FF, and Dream Team
    simultaneously), so this runs once, ahead of every game-specific
    section, rather than being duplicated per game (which would burn
    through the Odds API/SportMonks quota re-fetching the same data).

    2026-08-21: also owns real match-winner/clean-sheet odds (SportMonks)
    and derived expected goals for every competition that importer covers
    - EFL Championship/League One/League Two AND the Premier League (see
    import_sportmonks_match_odds.py's LEAGUE_ID_BY_COMPETITION and
    compute_expected_goals.py's MARKET_ODDS_COMPETITIONS). Previously
    these two only ran inside run_eflfantasy(), so Dream Team/FanTeam/
    Cloud FF's "Market Odds" pages only ever got fresh data as a
    byproduct of EFL Fantasy's own schedule - moved here so every game
    refreshes on the same cadence, and placed before the probabilities/
    clean-sheet passes below so they see this cycle's freshest odds."""
    results = []
    results.append(run_step("Odds: fixtures + h2h", ["scripts/import_fixtures_odds.py"]))
    results.append(
        run_step("Odds: fixture extras (team totals / player props)", ["scripts/import_fixture_extras.py", "--limit", "20"])
    )
    results.append(
        run_step("SportMonks: player-level bookmaker props", ["scripts/import_sportmonks_player_props.py"])
    )
    results.append(
        run_step("SportMonks: match odds (EFL + Premier League)", ["scripts/import_sportmonks_match_odds.py"])
    )
    # 2026-08-29 user request - real cost-saving alternative to SportMonks
    # via DreamTeamTonic's own Market Odds tool (Spreadex). Runs alongside
    # SportMonks, not instead of it, for now - see import_dreamteamtonic_
    # market_odds.py's own docstring for exactly what it does and doesn't
    # cover (no FA Cup/Carabao Cup yet, no League Two player props).
    # Deliberately AFTER the SportMonks step: both write into fixture_
    # probabilities/fixture_clean_sheet_probabilities/bookmaker_player_
    # features, which all already resolve "latest row wins" - so running
    # this second just means DTT's real data is what's live right now,
    # easy to compare against SportMonks' own prior row by computed_at.
    results.append(
        run_step("DreamTeamTonic: market odds (Premier League + EFL)", ["scripts/import_dreamteamtonic_market_odds.py"])
    )
    results.append(run_step("Fixture probabilities", ["scripts/compute_fixture_probabilities.py"]))
    results.append(run_step("Clean sheet probabilities", ["scripts/compute_clean_sheet_probabilities.py"]))
    results.append(run_step("Expected goals (EFL + Premier League)", ["scripts/compute_expected_goals.py"]))
    # Real user request 2026-08-18: alert on large player-odds swings -
    # runs last in this section so it always sees this cycle's freshest
    # bookmaker_player_probability_history rows (migration 0120).
    results.append(run_step("Detect odds swings", ["scripts/detect_odds_swings.py"]))
    return results


def run_fanteam():
    results = []
    results.append(run_step("FanTeam players (no login needed)", ["scraper_fanteam.py", "--players-only"]))
    results.append(run_step("Import FanTeam players", ["import_fanteam_live.py", "--skip-fixtures"]))
    results.extend(recompute_section("fanteam", "FanTeam"))
    return results


def run_cloudff():
    """Same players/fixtures/recompute shape as FanTeam above, its own
    two real unauthenticated endpoints (see scraper_cloudff.py).
    seed_cloudff_historical_stats.py is idempotent (skips any Cloud FF
    game_player that already has a historical row - see its own
    docstring) so it's safe to run every cycle, picking up newly-signed
    players as import_cloudff.py adds them."""
    results = []
    results.append(run_step("Cloud FF players + fixtures (no login needed)", ["scraper_cloudff.py"]))
    results.append(run_step("Import Cloud FF players + fixtures", ["import_cloudff.py"]))
    results.append(run_step("Seed Cloud FF historical stats", ["scripts/seed_cloudff_historical_stats.py"]))
    results.extend(recompute_section("cloudff", "Cloud FF"))
    return results


def run_eflfantasy():
    """EFL Fantasy - players/clubs/fixtures, both endpoints real, public,
    unauthenticated JSON (see scraper_eflfantasy.py) - no login dance
    needed at all, unlike FanTeam. Its real bookmaker match-winner odds
    (SportMonks, confirmed live 2026-08-06), the fixture-probabilities
    pass, and expected goals now all run once for every game up front in
    run_shared_odds() (2026-08-21 - previously duplicated here since this
    was the only section that called the SportMonks importer at all), so
    this section is just players/clubs/fixtures import + recompute."""
    results = []
    results.append(run_step("EFL Fantasy players + clubs + fixtures (no login needed)", ["scraper_eflfantasy.py"]))
    results.append(run_step("Import EFL Fantasy players + clubs + fixtures", ["import_eflfantasy.py"]))
    results.extend(recompute_section("eflfantasy", "EFL Fantasy"))
    return results


def run_dreamteam():
    """Dream Team - players/prices + its own gameweek calendar
    (import_dreamteam.py's sync_gameweek_calendar copies FanTeam's real
    soccer_epl (fixture_id, gameweek) pairs onto dreamteam's game_id -
    see that script's docstring). That calendar only ever covers league
    fixtures though, so assign_dreamteam_cup_gameweeks.py runs right
    after it to bucket any Carabao Cup/FA Cup/European fixture that's
    landed in `fixtures` (via the shared Odds import) into whichever
    Dream Team gameweek window its kickoff falls in - a fixture that
    doesn't exist yet (e.g. a cup round not drawn) simply finds nothing
    to assign, not an error, and picks itself up automatically the
    first refresh after it appears.

    scraper_dreamteam_stats.py + seed_dreamteam_historical_stats.py (added
    2026-08-22) pull Dream Team's own real season-cumulative per-player
    stats and reseed the historical shrinkage prior from them every run -
    replaces what used to be a one-time stale CSV seed. Deliberately runs
    in THIS job (not wrapup) since seed_dreamteam_historical_stats.py
    reads the scraper's raw JSON file straight off disk, same-job/same-
    checkout - see capture_gameweek_actuals.py's own docstring for why
    its separate Dream Team actuals capture can't reuse that file and
    fetches live instead.

    2026-08-27: Dream Team's own official API has no real per-match
    minutes field at all (see seed_dreamteam_historical_stats.py's own
    docstring), which is what let a uniform, ~1-game-deep proxy crush
    every Dream Team player's expected-minutes fraction toward zero (real
    user report - Erling Haaland rated 3/10). This job's own historical
    seed above still covers the real event-stats (goals/assists/etc) the
    official API DOES have; real per-gameweek minutes now come from
    DreamTeamTonic instead (accumulate_dreamteam_current_season_row in
    scripts/import_dreamteamtonic_starts.py, wrapup section, dreamteam-
    only) - see that function's own docstring for the full story. Not
    duplicated here since that script needs the SAME real fixture
    calendar this job's own assign_dreamteam_cup_gameweeks.py step just
    finished updating, so it stays in wrapup (which always runs after
    every game section) rather than being pulled forward into this job."""
    results = []
    results.append(run_step("Dream Team players (no login needed)", ["scraper_dreamteam.py"]))
    results.append(run_step("Import Dream Team players", ["import_dreamteam.py"]))
    results.append(run_step("Dream Team: assign cup/Europe fixtures to gameweeks", ["scripts/assign_dreamteam_cup_gameweeks.py"]))
    results.append(run_step("Dream Team player stats (no login needed)", ["scraper_dreamteam_stats.py"]))
    results.append(run_step("Seed Dream Team historical stats", ["scripts/seed_dreamteam_historical_stats.py"]))
    results.extend(recompute_section("dreamteam", "Dream Team"))
    return results


def run_golf():
    """FanTeam Golf - a brand-new tournament ID drops every week with no
    auto-discovery endpoint (confirmed live - every unauthenticated
    "list tournaments" path returns HTTP 401), so the FIRST import of a
    new week's tournament stays a manual, one-time action (the
    Tournament Builder wizard at /golf/import). But once a tournament
    is already known, RE-scraping it needs no new information from a
    human at all - it's the same fanteam_tournament_id every time, and
    FanTeam's own API naturally returns each day's updated round scores/
    prices/status for it. Re-running the scraper+importer here, before
    the recompute step, is what makes "today's round scores" show up
    without anyone revisiting /golf/import - directly closes the gap
    where a tournament's scores/prices only ever updated if someone
    remembered to paste the same URL in again each day. Loops over
    every tournament active_golf_tournaments() returns (not just one)
    so importing next week's tournament doesn't silently cut off this
    week's still-finishing one - see that function's own docstring."""
    results = []
    conn = psycopg2.connect(os.environ["DATABASE_URL"])
    try:
        golf_tournament_refs = active_golf_tournaments(conn)
    finally:
        conn.close()

    if golf_tournament_refs:
        for golf_tournament_ref in golf_tournament_refs:
            results.append(run_step(f"Re-scrape FanTeam Golf tournament ({golf_tournament_ref})", ["scraper_fanteam_golf.py", golf_tournament_ref]))
            results.append(run_step("Re-import FanTeam Golf tournament", ["import_fanteam_golf.py"]))
            # Runs AFTER the re-scrape/re-import above on purpose (2026-08-12
            # fix) - those two only ever work pre-lock (scraper_fanteam_golf.py's
            # endpoint 401s the instant a tournament starts, see its own
            # docstring), so once locked they'd otherwise be the last writer
            # to golf_tournament_entries.raw each cycle and silently overwrite
            # this step's real score data with stale pre-lock pricing. See
            # capture_golf_scores.py's docstring for the full story (this
            # replaces the old 5-minute live poller, which the user doesn't
            # want back - just the final score, on the existing twice-daily
            # cadence).
            results.append(
                run_step(f"Capture FanTeam Golf scores ({golf_tournament_ref})", ["scripts/capture_golf_scores.py", golf_tournament_ref])
            )
            results.append(
                run_step(f"Recompute Hail Mary Golf projections ({golf_tournament_ref})", ["scripts/compute_golf_projections.py", golf_tournament_ref])
            )
    else:
        print("\nNo FanTeam Golf tournament imported yet - skipping golf re-scrape/recompute.")

    # These two scans need no tournament ID at all - they operate on
    # every already-imported golf_tournaments row, so they're exactly as
    # safe to run unattended as their football counterparts.
    results.append(run_step("Freeze golf predictions (Hail Mary Golf)", ["scripts/capture_golf_predictions.py"]))
    results.append(run_step("Attach golf tournament results", ["scripts/attach_golf_tournament_results.py"]))
    return results


def run_wrapup():
    """Cross-game steps that don't belong to any single game's own
    section - either because they span more than one game
    (capture_gameweek_actuals.py captures FanTeam's, Cloud FF's, AND EFL
    Fantasy's real actuals in one pass, from three different data sources -
    see its own docstring) or because they operate generically over whichever
    games/gameweeks already exist in the database with no game_slug filter
    at all (attach_gameweek_results.py, capture_gameweek_predictions.py).
    Scheduled to run after every game section (see .github/workflows/
    refresh_wrapup.yml's cron offset) specifically so it always sees each
    game's freshest recompute, not because any of these scripts assume a
    particular game finished first.

    2026-08-27 site-wide rating consolidation: capture_squad_gameweek_
    state.py, evaluate_predictions.py, and send_accuracy_digest.py were
    removed here (and deleted from the repo) - they only ever fed Ask
    Mary/Performance Lab, both now deleted from every game's frontend, and
    nothing writes new rows to the `predictions`/`squad_gameweek_locks`
    tables they depended on anymore (verified via a full grep sweep before
    removing - see git history for the exact audit). capture_gameweek_
    predictions.py stays: despite its "Hail Mary Form" framing being from
    before that frontend badge existed, it's still a real, load-bearing
    prerequisite - it's the step that INSERTs each gameweek's player_
    gameweek_predictions rows in the first place, which attach_gameweek_
    results.py (actual_minutes/actual_goals/actual_assists - Recent
    Form's own real data source, see fetch_recent_gameweek_observations)
    and import_dreamteamtonic_starts.py (actual_started - the Opportunity
    Model's real starts signal) both only ever UPDATE, never insert.
    Removing this step would silently break both of those going forward,
    not just the retired display.

    prune_old_projections.py runs last, deliberately after everything
    above that still reads from `projections` this cycle - see that
    script's own docstring for why every real consumer already only
    ever wants the latest row per (game_player_id, gameweek) anyway, so
    running this every cycle keeps the table from ever re-accumulating
    the ~90k-row/168MB bloat a one-off cleanup found on 2026-08-17."""
    results = []
    results.append(run_step("Capture gameweek actuals", ["scripts/capture_gameweek_actuals.py"]))
    # Real per-gameweek starts data (2026-08-27 user request - replaces
    # the old static rotation-risk screenshot, see compute_projections.py's
    # fetch_recent_start_observations) - runs right after actuals capture
    # since it UPDATEs the same player_gameweek_predictions rows that step
    # just wrote/confirmed exist, and before the next step reads them.
    results.append(run_step("Capture real starts (Dream Team Tonic)", ["scripts/import_dreamteamtonic_starts.py"]))
    # Real projected cup/Europe fixtures for Dream Team's own Fixture
    # Quantity rating (2026-08-27 user request - see that script's own
    # docstring for the full TBA/IF story). Self-gates on its own last
    # capture (~12h staleness), so running it every wrapup cycle is a
    # no-op on the second daily run - team competition participation
    # changes far slower than real minutes/starts do.
    results.append(run_step("Capture projected fixtures (Dream Team Tonic ticker)", ["scripts/scrape_dreamteamtonic_fixture_ticker.py"]))
    results.append(run_step("Attach gameweek results to frozen predictions", ["scripts/attach_gameweek_results.py"]))
    results.append(run_step("Freeze gameweek predictions (starts/minutes tracking prerequisite)", ["scripts/capture_gameweek_predictions.py"]))
    results.append(run_step("Prune superseded projection rows", ["scripts/prune_old_projections.py"]))
    return results


SECTION_FUNCS = {
    "shared_odds": run_shared_odds,
    "fanteam": run_fanteam,
    "cloudff": run_cloudff,
    "eflfantasy": run_eflfantasy,
    "dreamteam": run_dreamteam,
    "golf": run_golf,
    "wrapup": run_wrapup,
}


def main():
    load_env()

    only = None
    if "--only" in sys.argv:
        only = sys.argv[sys.argv.index("--only") + 1]
        if only not in SECTION_FUNCS:
            raise SystemExit(f"--only must be one of {SECTIONS}, got {only!r}")

    sections_to_run = [only] if only else SECTIONS

    results = []
    for section in sections_to_run:
        results.extend(SECTION_FUNCS[section]())

    failed = results.count(False)
    print(f"\n{len(results) - failed}/{len(results)} steps succeeded.")
    if failed:
        raise SystemExit(f"{failed} step(s) failed - see log above.")


if __name__ == "__main__":
    main()
