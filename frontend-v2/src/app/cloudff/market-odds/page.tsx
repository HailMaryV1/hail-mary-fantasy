import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getGameweekInfo } from "@/lib/gameweek";
import { fetchMarketOdds, type MarketOddsTeamRow } from "@/lib/marketOdds";
import GameweekSwitcher from "@/components/GameweekSwitcher";
import Kit from "@/components/Kit";

export const dynamic = "force-dynamic";

function DeltaTag({ value, suffix = "%" }: { value: number; suffix?: string }) {
  if (Math.abs(value) < 0.05) return null;
  const up = value > 0;
  return (
    <span className={`ml-1 text-[10px] font-semibold ${up ? "text-emerald-400" : "text-red-400"}`}>
      {up ? "▲" : "▼"}
      {Math.abs(value).toFixed(1)}
      {suffix}
    </span>
  );
}

function Top5Card({ title, rows, metric }: { title: string; rows: MarketOddsTeamRow[]; metric: "win" | "goals" | "cleanSheet" }) {
  return (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-navy-400">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-navy-500">No real odds posted yet for this gameweek.</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {rows.map((r, i) => (
            <li key={`${r.fixtureId}-${r.teamId}`} className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <span className="w-4 shrink-0 text-[10px] font-bold text-navy-500">{i + 1}</span>
                <Kit teamName={r.teamName} size="sm" />
                <span className="truncate text-xs font-medium text-white">{r.teamName}</span>
              </div>
              <span className="shrink-0 text-xs font-bold text-sky-300">
                {metric === "win" && `${r.winPct.toFixed(0)}%`}
                {metric === "goals" && r.expectedGoals?.toFixed(2)}
                {metric === "cleanSheet" && `${r.cleanSheetPct.toFixed(0)}%`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default async function CloudFFMarketOddsPage({
  searchParams,
}: {
  searchParams: Promise<{ gameweek?: string }>;
}) {
  const { gameweek: gameweekParam } = await searchParams;
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id").eq("slug", "cloudff").maybeSingle();
  if (!game) redirect("/ratings?game=cloudff");

  const gwInfo = await getGameweekInfo(supabase, game.id);
  const planningGameweek = gwInfo.planningGameweek ?? 1;
  const requestedGameweek = Number(gameweekParam);
  const viewedGameweek = Number.isInteger(requestedGameweek)
    ? Math.min(Math.max(requestedGameweek, gwInfo.minGameweek), gwInfo.maxGameweek)
    : gwInfo.displayGameweek;

  const { fixtures, top5Winners, top5Goals, top5CleanSheets } = await fetchMarketOdds("cloudff", viewedGameweek, "soccer_epl");

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-lg font-semibold text-white">Market Odds</h1>
            <p className="mt-1 max-w-xl text-xs text-navy-400">
              Goal and clean sheet projections from the betting market, with how far each price has moved since it opened. Premier
              League only.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a
              href={`/api/market-odds-card?gameweek=${viewedGameweek}&gameSlug=cloudff`}
              download={`hail-mary-market-odds-gw${viewedGameweek}.png`}
              className="flex shrink-0 items-center gap-1 self-start rounded-full border border-navy-700 bg-navy-950 px-2.5 py-1.5 text-[10px] font-semibold text-sky-400 hover:border-sky-500 hover:text-sky-300"
              title="Download a shareable market odds card for socials"
            >
              ⬇ Card
            </a>
            <GameweekSwitcher
              basePath="/cloudff/market-odds"
              currentGameweek={viewedGameweek}
              minGameweek={gwInfo.minGameweek}
              maxGameweek={gwInfo.maxGameweek}
              planningGameweek={planningGameweek}
            />
          </div>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Top5Card title="Top 5 Most Likely Winners" rows={top5Winners} metric="win" />
          <Top5Card title="Top 5 Highest Projected Goals" rows={top5Goals} metric="goals" />
          <Top5Card title="Top 5 Most Likely Clean Sheets" rows={top5CleanSheets} metric="cleanSheet" />
        </div>

        <div className="mt-6 rounded-xl border border-navy-700 bg-navy-900 p-4">
          <h2 className="text-sm font-semibold text-white">By fixture</h2>
          {fixtures.length === 0 ? (
            <p className="mt-3 text-xs text-navy-500">No fixtures found for Gameweek {viewedGameweek}.</p>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
              {fixtures.map((fx) => (
                <div key={fx.fixtureId} className="rounded-lg border border-navy-800 bg-navy-950 p-3">
                  <div className="flex items-center justify-between text-[10px] text-navy-500">
                    <span>{new Date(fx.kickoffAt).toLocaleString("en-GB", { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</span>
                  </div>
                  <table className="mt-2 w-full text-left text-xs">
                    <thead>
                      <tr className="text-navy-500">
                        <th className="pb-1 font-medium"></th>
                        <th className="pb-1 text-right font-medium">Goals</th>
                        <th className="pb-1 text-right font-medium">CS%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[fx.home, fx.away].map((side) => (
                        <tr key={side.teamId} className="border-t border-navy-800">
                          <td className="py-1.5">
                            <div className="flex items-center gap-2">
                              <Kit teamName={side.teamName} size="sm" />
                              <span className="font-medium text-white">{side.teamName}</span>
                            </div>
                          </td>
                          <td className="py-1.5 text-right text-sky-300">
                            <span className="font-bold">{side.expectedGoals != null ? side.expectedGoals.toFixed(2) : "-"}</span>
                          </td>
                          <td className="py-1.5 text-right">
                            {side.cleanSheetSource === "real" ? (
                              <>
                                <span className="font-bold text-emerald-400">{side.cleanSheetPct.toFixed(0)}%</span>
                                <DeltaTag value={side.cleanSheetPctDelta} />
                              </>
                            ) : (
                              // "We shouldnt use the fallback - its
                              // tricking the eye" (2026-08-26 user
                              // request) - no real Clean Sheet market
                              // posted for this fixture yet.
                              <span title="No real clean sheet odds posted for this fixture yet" className="text-[10px] font-medium text-navy-600">
                                Odds not posted yet
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
