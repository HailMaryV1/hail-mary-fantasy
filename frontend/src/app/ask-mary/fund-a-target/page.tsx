import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { runAskMaryAnalysis } from "@/lib/askMaryEngine";
import { fetchPlayerOptions } from "@/lib/engineExplainability";
import TargetPicker from "../TargetPicker";
import FavouredMoveCard from "../FavouredMoveCard";
import GameSecondaryNav from "../../GameSecondaryNav";

// Same reasoning as ask-mary/page.tsx - the analysis depends on live
// squad/budget state, not something Next's fetch cache should serve stale.
export const dynamic = "force-dynamic";

/**
 * "Fund a Target" - the user-driven counterpart to Mary's own
 * auto-discovered "Prepare for a Target" favoured move. You pick a
 * specific player yourself instead of Mary ranking one from the pool;
 * everything else (the funding search, transfer legality, Apply
 * Transfer) is the exact same machinery, not a reimplementation - see
 * askMaryEngine.ts's findFundingPathForTarget.
 *
 * Deliberately scoped to "can I afford this now via one legal
 * downgrade" - not a multi-gameweek target-directed plan. That's a
 * genuinely different, larger feature ("Build a Route"), out of scope
 * here.
 */
export default async function FundATargetPage({
  searchParams,
}: {
  searchParams: Promise<{ squad?: string; player?: string }>;
}) {
  const { squad: squadParam, player: playerParam } = await searchParams;

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: fanteamGameRow } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", "fanteam").single();
  if (!fanteamGameRow) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          <h1 className="text-2xl font-semibold text-white">Fund a Target</h1>
          <p className="mt-4 text-sm text-red-400">FanTeam isn&apos;t configured on this platform yet.</p>
        </main>
      </div>
    );
  }
  const fanteamGame = fanteamGameRow;

  const { data: squadsRaw } = await supabase
    .from("squads")
    .select("id, name, free_transfers, wildcard_1_used_gameweek, wildcard_2_used_gameweek")
    .eq("user_id", user.id)
    .eq("game_id", fanteamGame.id)
    .order("created_at", { ascending: false });

  const header = (
    <div>
      <div className="mb-4">
        <GameSecondaryNav gameSlug="fanteam" gameDisplayName={fanteamGame.display_name} />
      </div>
      <h1 className="text-2xl font-semibold text-white">Fund a Target</h1>
      <p className="mt-1 text-sm text-navy-300">
        Pick any player and see whether a same-position swap - plus, if needed, one further legal sale elsewhere - can afford
        them right now.
      </p>
      <Link href="/ask-mary" className="mt-2 inline-block text-xs font-medium text-sky-400 hover:text-sky-300">
        ← Back to Ask Mary
      </Link>
    </div>
  );

  if (!squadsRaw || squadsRaw.length === 0) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-2xl">
          {header}
          <p className="mt-8 text-sm text-navy-300">You don&apos;t have a FanTeam squad yet.</p>
        </main>
      </div>
    );
  }

  const selectedSquad = squadsRaw.find((s) => s.id === Number(squadParam)) ?? squadsRaw[0];

  const { data: squadPlayersRaw } = await supabase.from("squad_players").select("game_player_id").eq("squad_id", selectedSquad.id);
  const ownedIds = new Set((squadPlayersRaw ?? []).map((p) => p.game_player_id));

  const allOptions = await fetchPlayerOptions(supabase, "fanteam");
  const targetOptions = allOptions.filter((p) => !ownedIds.has(p.gamePlayerId));

  const targetGamePlayerId = playerParam ? Number(playerParam) : null;
  const targetOption = targetGamePlayerId != null ? targetOptions.find((p) => p.gamePlayerId === targetGamePlayerId) ?? null : null;

  const analysis =
    targetOption != null
      ? await runAskMaryAnalysis(supabase, selectedSquad, fanteamGame, "balanced", undefined, targetOption.gamePlayerId)
      : null;

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        {header}

        {squadsRaw.length > 1 && (
          <div className="mt-4 flex flex-wrap gap-1 rounded-lg bg-navy-900 p-1">
            {squadsRaw.map((s) => (
              <Link
                key={s.id}
                href={`/ask-mary/fund-a-target?squad=${s.id}${targetGamePlayerId != null ? `&player=${targetGamePlayerId}` : ""}`}
                className={`rounded-md px-2.5 py-1 text-xs font-medium ${
                  s.id === selectedSquad.id ? "bg-sky-500 text-navy-950" : "text-navy-300 hover:text-white"
                }`}
              >
                {s.name}
              </Link>
            ))}
          </div>
        )}

        <div className="mt-4">
          <TargetPicker players={targetOptions} squadId={selectedSquad.id} selectedId={targetOption?.gamePlayerId ?? null} />
        </div>

        {targetGamePlayerId != null && !targetOption && (
          <p className="mt-4 text-sm text-amber-400">Couldn&apos;t find that player - they may already be in this squad.</p>
        )}

        {targetOption && !analysis && (
          <p className="mt-4 text-sm text-red-400">Couldn&apos;t run the analysis for this squad - try again shortly.</p>
        )}

        {targetOption && analysis && (
          <div className="mt-6">
            {analysis.targetPlan?.move ? (
              <>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-400">Fund now</h2>
                <p className="mt-1 text-xs text-navy-500">
                  {analysis.targetPlan.move.transfers.length > 1
                    ? `A same-position swap for ${targetOption.fullName}, plus one further legal sale elsewhere in your squad, together fund them right now.`
                    : `${targetOption.fullName} directly replaces one of your own squad in the same position - already affordable, no further sale needed.`}
                </p>
                <div className="mt-2">
                  <FavouredMoveCard move={analysis.targetPlan.move} squadId={selectedSquad.id} gameSlug="fanteam" />
                </div>
              </>
            ) : (
              <>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400">No two-transfer funding route found</h2>
                <div className="mt-2 rounded-xl border border-navy-700 bg-navy-900 p-4">
                  <p className="text-sm text-navy-200">
                    {targetOption.fullName} costs £{targetOption.price.toFixed(1)}m. Mary tested replacing one of your own{" "}
                    {targetOption.position}s with {targetOption.fullName} directly - using that player&apos;s sale value plus your
                    £{analysis.budgetRemaining.toFixed(1)}m in the bank - and, where that alone fell short, one further legal downgrade
                    elsewhere to close the gap. Neither closes it right now.
                  </p>
                  {analysis.targetPlan?.closestShortfall ? (
                    <p className="mt-2 text-sm text-navy-200">
                      Closest attempt: selling {analysis.targetPlan.closestShortfall.primaryOutName} to bring in{" "}
                      {targetOption.fullName}
                      {analysis.targetPlan.closestShortfall.secondaryOutName && analysis.targetPlan.closestShortfall.secondaryInName
                        ? `, plus ${analysis.targetPlan.closestShortfall.secondaryOutName} → ${analysis.targetPlan.closestShortfall.secondaryInName}`
                        : ""}{" "}
                      - still about £{analysis.targetPlan.closestShortfall.amount.toFixed(1)}m short.
                    </p>
                  ) : (
                    <p className="mt-2 text-sm text-navy-200">
                      Mary couldn&apos;t find any legal same-position replacement to try for this target - check your squad&apos;s club
                      limits at {targetOption.teamName}.
                    </p>
                  )}
                  <p className="mt-2 text-xs text-navy-400">
                    A path might still exist through more than two transfers, but that kind of multi-step search isn&apos;t built yet.
                  </p>
                </div>
              </>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
