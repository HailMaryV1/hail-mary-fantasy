import Link from "next/link";
import { createServerSupabaseClient } from "@/lib/supabase";

// See rankings/page.tsx for why this is needed - Supabase's .rpc() POSTs
// to a fixed URL regardless of parameters, so Next's fetch Data Cache can
// serve a stale horizon's response for a different horizon's request.
export const dynamic = "force-dynamic";

type HorizonSummaryRow = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_name: string;
  price: number;
  avg_score: number;
  points_per_90: number;
};

type SummaryRow = {
  full_name: string;
  position: string;
  team_name: string;
  price: number;
  hail_mary_score: number;
  points_per_90: number;
};

type NextFixture = { opponent: string; is_home: boolean } | null;

type ComparedPlayer = {
  gamePlayerId: number;
  fullName: string;
  position: string;
  teamName: string;
  price: number;
  score: number | null;
  pointsPer90: number;
  horizonAvailable: boolean;
  nextFixture: NextFixture;
};

const HORIZONS = [
  { key: "short", label: "Short (1 GW)", gameweeks: 1 },
  { key: "medium", label: "Medium (2 GW avg)", gameweeks: 2 },
  { key: "long", label: "Long (3 GW avg)", gameweeks: 3 },
] as const;

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<{ ids?: string; horizon?: string }>;
}) {
  const { ids: idsParam, horizon: horizonParam } = await searchParams;
  const activeHorizon = HORIZONS.find((h) => h.key === horizonParam) ?? HORIZONS[0];
  const ids = (idsParam ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));

  const supabase = createServerSupabaseClient();

  const players: ComparedPlayer[] = [];
  for (const gamePlayerId of ids) {
    const { data: gamePlayer } = await supabase
      .from("game_players")
      .select("fantasy_games(slug)")
      .eq("id", gamePlayerId)
      .maybeSingle<{ fantasy_games: { slug: string } }>();
    if (!gamePlayer) continue;
    const gameSlug = gamePlayer.fantasy_games.slug;

    const { data: horizonRows } = await supabase
      .rpc("player_score_by_horizon", { p_game_slug: gameSlug, p_num_gameweeks: activeHorizon.gameweeks })
      .eq("game_player_id", gamePlayerId)
      .returns<HorizonSummaryRow[]>();
    const horizonRow = horizonRows?.[0] ?? null;

    if (horizonRow) {
      const { data: fixtureRows } = await supabase
        .rpc("player_projection_fixtures_by_horizon", { p_game_player_id: gamePlayerId, p_num_gameweeks: 1 })
        .returns<{ opponent: string; is_home: boolean }[]>();
      players.push({
        gamePlayerId,
        fullName: horizonRow.full_name,
        position: horizonRow.position,
        teamName: horizonRow.team_name,
        price: horizonRow.price,
        score: horizonRow.avg_score,
        pointsPer90: horizonRow.points_per_90,
        horizonAvailable: true,
        nextFixture: fixtureRows?.[0] ? { opponent: fixtureRows[0].opponent, is_home: fixtureRows[0].is_home } : null,
      });
    } else {
      const { data: summaryRow } = await supabase
        .from("player_projection_summary")
        .select("*")
        .eq("game_player_id", gamePlayerId)
        .maybeSingle<SummaryRow>();
      if (!summaryRow) continue;
      const { data: fixtureRows } = await supabase
        .from("player_projection_fixtures")
        .select("opponent, is_home")
        .eq("game_player_id", gamePlayerId)
        .order("kickoff_at")
        .limit(1)
        .returns<{ opponent: string; is_home: boolean }[]>();
      players.push({
        gamePlayerId,
        fullName: summaryRow.full_name,
        position: summaryRow.position,
        teamName: summaryRow.team_name,
        price: summaryRow.price,
        score: summaryRow.hail_mary_score,
        pointsPer90: summaryRow.points_per_90,
        horizonAvailable: false,
        nextFixture: fixtureRows?.[0] ?? null,
      });
    }
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        <Link href="/rankings" className="text-sm text-navy-400 hover:text-sky-300">
          ← Back to rankings
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">Compare players</h1>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium uppercase tracking-wide text-navy-400">Planning horizon</span>
          <div className="flex gap-1 rounded-lg bg-navy-900 p-1">
            {HORIZONS.map((h) => (
              <Link
                key={h.key}
                href={`/compare?ids=${ids.join(",")}&horizon=${h.key}`}
                prefetch={false}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  h.key === activeHorizon.key ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
                }`}
              >
                {h.label}
              </Link>
            ))}
          </div>
        </div>

        {players.length === 0 ? (
          <p className="mt-8 text-sm text-navy-300">No players selected. Go back to rankings and pick 2-3 to compare.</p>
        ) : (
          <div className="mt-6 overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
            <table className="w-full text-left text-sm">
              <tbody>
                {[
                  { label: "Player", render: (p: ComparedPlayer) => <Link href={`/players/${p.gamePlayerId}`} className="font-medium text-white hover:text-sky-300">{p.fullName}</Link> },
                  { label: "Team", render: (p: ComparedPlayer) => <span className="text-navy-300">{p.teamName}</span> },
                  { label: "Position", render: (p: ComparedPlayer) => <span className="text-navy-300">{p.position}</span> },
                  { label: "Price", render: (p: ComparedPlayer) => <span className="text-navy-300">£{Number(p.price).toFixed(1)}m</span> },
                  { label: "Hail Mary Score", render: (p: ComparedPlayer) => <span className="font-semibold text-sky-400">{p.score != null ? Number(p.score).toFixed(1) : "-"}</span> },
                  { label: "Points / 90", render: (p: ComparedPlayer) => <span className="text-navy-300">{Number(p.pointsPer90).toFixed(1)}</span> },
                  {
                    label: "Next fixture",
                    render: (p: ComparedPlayer) => (
                      <span className="text-navy-300">
                        {p.nextFixture ? `${p.nextFixture.is_home ? "vs" : "@"} ${p.nextFixture.opponent}` : "-"}
                      </span>
                    ),
                  },
                ].map((row) => (
                  <tr key={row.label} className="border-b border-navy-800 last:border-0">
                    <td className="w-40 px-4 py-3 text-xs font-medium uppercase tracking-wide text-navy-400">{row.label}</td>
                    {players.map((p) => (
                      <td key={p.gamePlayerId} className="px-4 py-3">
                        {row.render(p)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
