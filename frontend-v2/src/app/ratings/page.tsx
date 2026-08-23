import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getGameweekInfo } from "@/lib/gameweek";
import { formatRating, ratingTier, ratingBasisTag } from "@/lib/hailMaryRating";
import { formatFixtureShort } from "@/lib/fixtureFormat";
import { hasBudget as gameHasBudget } from "@/lib/gameConfig";
import { listPoolTeams } from "@/lib/poolSearch";
import Kit from "@/components/Kit";
import RatingsBrowseTable from "@/components/RatingsBrowseTable";

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

type TopRatedRow = {
  position: string;
  rnk: number;
  game_player_id: number;
  full_name: string;
  team_id: number;
  team_name: string;
  hail_mary_rating: number | null;
  hail_mary_rating_basis: "real_odds" | "recent_form" | "coverage_only" | null;
  hail_mary_score: number;
  opponent_team_name: string | null;
  fixture_is_home: boolean | null;
  fixture_kickoff_at: string | null;
};

function RatingRow({ row, rank }: { row: TopRatedRow; rank: number }) {
  const tier = ratingTier(row.hail_mary_rating);
  const basisTag = ratingBasisTag(row.hail_mary_rating_basis);
  // CLUB rows' full_name is the synthetic "<Team> Team" pick label (EFL
  // Fantasy's club-pick naming, migration 0087) - team_name ("Millwall")
  // is the real display name everywhere else this shows up (see
  // eflfantasy/page.tsx's own club_name: p.team_name usage).
  const displayName = row.position === "CLUB" ? row.team_name : row.full_name;
  return (
    <li className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="w-4 shrink-0 text-[10px] font-bold text-navy-500">{rank}</span>
        <Kit teamName={row.team_name} size="sm" />
        <div className="min-w-0">
          <span className="block truncate text-xs font-medium text-white">{displayName}</span>
          <span className="block truncate text-[10px] text-navy-500">
            {formatFixtureShort(row.opponent_team_name, row.fixture_is_home, row.fixture_kickoff_at)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-xs font-bold text-sky-300">{formatRating(row.hail_mary_rating)}/10</span>
        {tier && <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${tier.toneClass}`}>{tier.label}</span>}
        {basisTag && (
          <span title={basisTag.title} className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${basisTag.toneClass}`}>
            {basisTag.label}
          </span>
        )}
      </div>
    </li>
  );
}

export default async function HailMaryRatingsPage({
  searchParams,
}: {
  searchParams: Promise<{ game?: string; gameweek?: string }>;
}) {
  const { game: gameParam, gameweek: gameweekParam } = await searchParams;
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const activeSlug = RATED_GAMES.some((g) => g.slug === gameParam) ? gameParam! : "dreamteam";

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", activeSlug).maybeSingle();
  if (!game) redirect("/");

  const gwInfo = await getGameweekInfo(supabase, game.id);
  const planningGameweek = gwInfo.planningGameweek ?? 1;
  const requestedGameweek = Number(gameweekParam);
  const viewedGameweek = Number.isInteger(requestedGameweek)
    ? Math.min(Math.max(requestedGameweek, gwInfo.minGameweek), gwInfo.maxGameweek)
    : gwInfo.displayGameweek;

  const [{ data: topRated }, teams] = await Promise.all([
    supabase.rpc("get_top_rated_players", {
      p_game_slug: activeSlug,
      p_gameweek: viewedGameweek,
      p_limit: 5,
    }),
    listPoolTeams(activeSlug),
  ]);
  const rows = (topRated ?? []) as TopRatedRow[];
  const byPosition = new Map<string, TopRatedRow[]>();
  for (const r of rows) {
    const list = byPosition.get(r.position) ?? [];
    list.push(r);
    byPosition.set(r.position, list);
  }
  const columns = POSITION_COLUMNS.filter((c) => c.code !== "CLUB" || activeSlug === "eflfantasy");

  const atMin = viewedGameweek <= gwInfo.minGameweek;
  const atMax = viewedGameweek >= gwInfo.maxGameweek;
  const gwLabel = viewedGameweek === planningGameweek ? `Gameweek ${viewedGameweek} (current)` : `Gameweek ${viewedGameweek}`;

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
              Who Mary rates highest this gameweek, by position - top 5 per position, switchable by game and gameweek.
            </p>
          </div>
          {/* Not GameweekSwitcher - that component only ever manages its
              own bare ?gameweek= param (confirmed via its real usage on
              eflfantasy/market-odds, where switching gameweek resets that
              page's own competition filter back to ALL). This page has
              TWO primary axes (game + gameweek) that both need to
              survive navigating the other, so both Links below build the
              full two-param URL explicitly - same visual style, real
              two-param correctness. */}
          <div className="flex items-center gap-1 rounded-full border border-navy-700 bg-navy-900 px-1 py-1">
            {atMin ? (
              <span className="cursor-not-allowed rounded-full px-2 py-1 text-xs font-medium text-navy-700">←</span>
            ) : (
              <Link
                href={`/ratings?game=${activeSlug}&gameweek=${viewedGameweek - 1}`}
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
                href={`/ratings?game=${activeSlug}&gameweek=${viewedGameweek + 1}`}
                className="rounded-full px-2 py-1 text-xs font-medium text-navy-300 hover:bg-navy-800 hover:text-white"
              >
                →
              </Link>
            )}
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {RATED_GAMES.map((g) => (
            <Link
              key={g.slug}
              href={`/ratings?game=${g.slug}&gameweek=${viewedGameweek}`}
              className={`rounded-full px-3 py-1.5 text-xs font-medium ${
                activeSlug === g.slug ? "bg-sky-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:bg-navy-700"
              }`}
            >
              {g.label}
            </Link>
          ))}
        </div>

        <div className={`mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 ${columns.length === 5 ? "lg:grid-cols-5" : "lg:grid-cols-4"}`}>
          {columns.map((col) => {
            const colRows = (byPosition.get(col.code) ?? []).sort((a, b) => a.rnk - b.rnk);
            return (
              <div key={col.code} className="rounded-xl border border-navy-700 bg-navy-900 p-4">
                <h2 className="text-xs font-semibold uppercase tracking-wide text-navy-400">{col.label}</h2>
                {colRows.length === 0 ? (
                  <p className="mt-3 text-xs text-navy-500">No real projections for this gameweek yet.</p>
                ) : (
                  <ol className="mt-3 space-y-2">
                    {colRows.map((r, i) => (
                      <RatingRow key={r.game_player_id} row={r} rank={i + 1} />
                    ))}
                  </ol>
                )}
              </div>
            );
          })}
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
