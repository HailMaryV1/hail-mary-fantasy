import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getGameweekInfo } from "@/lib/gameweek";
import { hasBudget as gameHasBudget } from "@/lib/gameConfig";
import { listPoolTeams } from "@/lib/poolSearch";
import { getProjectionFreshness, formatFreshness } from "@/lib/projectionFreshness";
import RatingsBrowseTable from "@/components/RatingsBrowseTable";
import TargetScoreBoard, { type TargetScoreRow } from "@/components/TargetScoreBoard";

export const dynamic = "force-dynamic";

// Only the 4 football games run the Hail Mary Rating system - golf (its
// own captain/underdog-multiplier scoring) and nfl-fanteam aren't in
// scope, matching this feature's own plan.
const RATED_GAMES: { slug: string; label: string }[] = [
  { slug: "dreamteam", label: "Dream Team" },
  { slug: "fanteam", label: "FanTeam" },
  { slug: "cloudff", label: "Cloud FF" },
  { slug: "eflfantasy", label: "EFL Fantasy" },
];

// GK/DEF/MID/FWD always shown; CLUB only appears for EFL Fantasy (its
// own 2 Club picks, migration 0087) - ranked as its own independent
// group by get_top_rated_players, never mixed with the 4 player
// positions above.
const POSITION_COLUMNS: { code: string; label: string }[] = [
  { code: "GK", label: "Goalkeepers" },
  { code: "DEF", label: "Defenders" },
  { code: "MID", label: "Midfielders" },
  { code: "FWD", label: "Forwards" },
  { code: "CLUB", label: "Clubs" },
];

// The 4 horizons a player can be judged over (2026-08-23 user request) -
// 1 keeps using the EXISTING Hail Mary Rating as its ranking signal (see
// get_top_target_score_players' own docstring); 2/3/5 rank by the new
// Target Score composite instead.
const HORIZONS = [1, 2, 3, 5];

// "Live Gameweek" - a 5th, separate tab (2026-08-26 user request: "just
// for info purposes on what mary predicted the best players where and
// whats actually happening") - not a real horizon value in target_scores
// (still uses horizon=1's own data), just a different ANCHOR (the live
// gameweek itself, never browsable) plus a real actual-result overlay.
type HorizonSelection = number | "live";

function parseHorizon(param: string | undefined): HorizonSelection {
  if (param === "live") return "live";
  const n = Number(param);
  return HORIZONS.includes(n) ? n : 1;
}

export default async function HailMaryRatingsPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string; gameweek?: string; horizon?: string }>;
}) {
  const { game: gameParam, gameweek: gameweekParam, horizon: horizonParam } = await searchParams;
  const horizonSelection = parseHorizon(horizonParam);
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const activeSlug = RATED_GAMES.some((g) => g.slug === gameParam) ? gameParam! : "dreamteam";

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", activeSlug).maybeSingle();
  if (!game) redirect("/");

  const gwInfo = await getGameweekInfo(supabase, game.id);
  const planningGameweek = gwInfo.planningGameweek ?? gwInfo.displayGameweek;
  const requestedGameweek = Number(gameweekParam);
  const viewedGameweek = Number.isInteger(requestedGameweek)
    ? Math.min(Math.max(requestedGameweek, gwInfo.minGameweek), gwInfo.maxGameweek)
    : gwInfo.displayGameweek;

  // "next gameweek should always be the following gameweek from the one
  // thats live... next 2 should be the 2 after the one thats live" -
  // horizon >= 2 ALWAYS anchors at planningGameweek (real definition:
  // "the instant a gameweek's first ball is kicked, planning shifts to
  // the next one" - gameweek.ts's own docstring), never at whatever the
  // gameweek switcher happens to be browsing. horizon=1 keeps browsing
  // normally (that's what the switcher is for). "live" pins to
  // displayGameweek - the gameweek actually in progress right now.
  const anchorGameweek =
    horizonSelection === "live"
      ? gwInfo.displayGameweek
      : horizonSelection === 1
        ? viewedGameweek
        : Math.min(planningGameweek, gwInfo.maxGameweek);
  const horizonRpcValue = horizonSelection === "live" ? 1 : horizonSelection;
  const isLive = horizonSelection === "live";

  const [{ data: topRated }, teams, projectionsUpdatedAt] = await Promise.all([
    supabase.rpc("get_top_target_score_players", {
      p_game_slug: activeSlug,
      p_gameweek: anchorGameweek,
      p_horizon: horizonRpcValue,
      p_limit: 5,
    }),
    listPoolTeams(activeSlug),
    getProjectionFreshness(supabase, activeSlug),
  ]);
  // Postgres `numeric` columns come back through supabase-js as strings,
  // not JS numbers (confirmed convention - see poolSearch.ts's own
  // Number(...) conversions for the exact same real_total_points/
  // last_gw_points columns) - target_score and last_gw_points need the
  // same explicit conversion here, or TargetScoreBoard's .toFixed(1) on
  // last_gw_points would throw at runtime the first time a Live
  // Gameweek result actually gets graded.
  const rows = ((topRated ?? []) as (Omit<TargetScoreRow, "target_score" | "last_gw_points"> & {
    target_score: number | string | null;
    last_gw_points: number | string | null;
  })[]).map((r) => ({
    ...r,
    target_score: r.target_score != null ? Number(r.target_score) : null,
    last_gw_points: r.last_gw_points != null ? Number(r.last_gw_points) : null,
  }));
  const byPosition = new Map<string, TargetScoreRow[]>();
  for (const r of rows) {
    const list = byPosition.get(r.position) ?? [];
    list.push(r);
    byPosition.set(r.position, list);
  }
  const columns = POSITION_COLUMNS.filter((c) => c.code !== "CLUB" || activeSlug === "eflfantasy");

  const atMin = viewedGameweek <= gwInfo.minGameweek;
  const atMax = viewedGameweek >= gwInfo.maxGameweek;
  const gwLabel = viewedGameweek === planningGameweek ? `Gameweek ${viewedGameweek} (current)` : `Gameweek ${viewedGameweek}`;
  // Window label for horizon >= 2 / live - the switcher only ever
  // affects horizon=1's browsable single gameweek, so showing it (still
  // active-looking, silently doing nothing) for any other selection
  // would be a dead control. A plain static label instead, honest about
  // what's actually being shown.
  const windowLabel = isLive
    ? `Gameweek ${anchorGameweek} (live)`
    : typeof horizonSelection === "number" && horizonSelection > 1
      ? `GW${anchorGameweek}–GW${anchorGameweek + horizonSelection - 1}`
      : null;

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-xs font-medium text-navy-400 hover:text-white"
        >
          ← Home
        </Link>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-white">Hail Mary Weekly Ratings</h1>
            <p className="mt-1 max-w-xl text-xs text-navy-400">
              Who Mary rates highest over the selected horizon, by position - top 5 per position, switchable by game, gameweek and horizon.
            </p>
            {/* "when has this game mode's projections last actually been
                updated" (2026-08-23 user request) - same real freshness
                stamp already shown on every game board, keyed to
                whichever game is currently selected so switching games
                shows that game's own last-successful-run time, not a
                shared/blended one. */}
            {projectionsUpdatedAt && (
              <p className="mt-1 text-[10px] text-navy-600" title={new Date(projectionsUpdatedAt).toLocaleString("en-GB")}>
                {formatFreshness(projectionsUpdatedAt)}
              </p>
            )}
          </div>
          {/* Only meaningful for horizon=1 - horizon >= 2 always anchors
              to planningGameweek regardless of what's browsed here (see
              anchorGameweek above), so the switcher would be a dead
              control for those; windowLabel below explains the window
              instead. Not GameweekSwitcher - that component only ever
              manages its own bare ?gameweek= param (confirmed via its
              real usage on eflfantasy/market-odds, where switching
              gameweek resets that page's own competition filter back to
              ALL). This page has TWO primary axes (game + gameweek) that
              both need to survive navigating the other, so both Links
              below build the full two-param URL explicitly - same
              visual style, real two-param correctness. */}
          {horizonSelection === 1 ? (
            <div className="flex items-center gap-1 rounded-full border border-navy-700 bg-navy-900 px-1 py-1">
              {atMin ? (
                <span className="cursor-not-allowed rounded-full px-2 py-1 text-xs font-medium text-navy-700">←</span>
              ) : (
                <Link
                  href={`/ratings?game=${activeSlug}&gameweek=${viewedGameweek - 1}&horizon=1`}
                  className="rounded-full px-2 py-1 text-xs font-medium text-navy-300 hover:bg-navy-800 hover:text-white"
                >
                  ←
                </Link>
              )}
              <span className="px-2 text-xs font-semibold text-white">{gwLabel}</span>
              {atMax ? (
                <span className="cursor-not-allowed rounded-full px-2 py-1 text-xs font-medium text-navy-700">→</span>
              ) : (
                <Link
                  href={`/ratings?game=${activeSlug}&gameweek=${viewedGameweek + 1}&horizon=1`}
                  className="rounded-full px-2 py-1 text-xs font-medium text-navy-300 hover:bg-navy-800 hover:text-white"
                >
                  →
                </Link>
              )}
            </div>
          ) : (
            windowLabel && (
              <span className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-semibold text-white">{windowLabel}</span>
            )
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {RATED_GAMES.map((g) => (
            <Link
              key={g.slug}
              href={`/ratings?game=${g.slug}&gameweek=${viewedGameweek}&horizon=${horizonSelection}`}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                activeSlug === g.slug ? "bg-sky-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:bg-navy-700"
              }`}
            >
              {g.label}
            </Link>
          ))}
        </div>

        {/* Horizon selector (2026-08-23 user request) - "best for THIS
            gameweek" (1, unchanged ranking) through "best over the next
            5 gameweeks" (fixture-weighted), plus a separate "Live
            Gameweek" info tab (2026-08-26 user request). Same plain
            URL-param <Link> pattern as the game pills above - no client
            state needed. */}
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-navy-500">Best for</span>
          {HORIZONS.map((h) => (
            <Link
              key={h}
              href={`/ratings?game=${activeSlug}&gameweek=${viewedGameweek}&horizon=${h}`}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                horizonSelection === h ? "bg-emerald-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:bg-navy-700"
              }`}
            >
              {h === 1 ? "This gameweek" : `Next ${h} gameweeks`}
            </Link>
          ))}
          <Link
            href={`/ratings?game=${activeSlug}&gameweek=${viewedGameweek}&horizon=live`}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              isLive ? "bg-red-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:bg-navy-700"
            }`}
          >
            Live Gameweek
          </Link>
        </div>

        {/* 2-wide always (not 4/5-wide on large screens) - a narrow box
            crushed the player name/fixture text once the rating grew a
            tier pill AND a basis pill (2026-08-23 user report: "hiding
            the name"). GK/DEF stack over MID/FWD (over CLUB, for EFL
            Fantasy) instead of forcing everything into one cramped row. */}
        <div className="mt-6">
          <TargetScoreBoard
            columns={columns}
            byPosition={byPosition}
            gameSlug={activeSlug}
            anchorGameweek={anchorGameweek}
            horizon={horizonRpcValue}
            isLive={isLive}
          />
        </div>

        <RatingsBrowseTable
          key={`${activeSlug}-${viewedGameweek}`}
          gameSlug={activeSlug}
          gameweek={viewedGameweek}
          teams={teams}
          hasClubPosition={activeSlug === "eflfantasy"}
          hasBudget={gameHasBudget(activeSlug)}
        />
      </div>
    </div>
  );
}
