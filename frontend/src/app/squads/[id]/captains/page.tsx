import { notFound } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getMatchDaysForSquad, ensureAutoPicks } from "@/lib/matchDayCaptains";
import GameSecondaryNav from "@/app/GameSecondaryNav";
import MatchDayCaptainPicker from "./MatchDayCaptainPicker";

// Squad state (captain picks) changes from a server action elsewhere -
// same "never serve a stale cached response" reasoning as every other
// data-driven page here.
export const dynamic = "force-dynamic";

// How many gameweeks ahead to show - matches Ask Mary's own planning
// window (askMaryEngine.ts's GAMEWEEK_PLAN_LENGTH) so the Captains page
// and Mary's per-match-day recommendations never disagree about which
// days are even in view.
const PLAN_LENGTH_GAMEWEEKS = 3;

export default async function CaptainsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const squadId = Number(id);
  if (!Number.isInteger(squadId)) notFound();

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: squad } = await supabase
    .from("squads")
    .select("id, name, user_id, game_id, fantasy_games(id, slug, display_name)")
    .eq("id", squadId)
    .single();
  if (!squad || squad.user_id !== user?.id) notFound();

  const game = squad.fantasy_games as unknown as { id: number; slug: string; display_name: string };
  // Cloud FF is the only game with this real per-match-day captain rule
  // (see migration 0083's docstring) - every other game keeps the
  // single-captain-per-gameweek picker on the squad page itself.
  if (game.slug !== "cloudff") notFound();

  const { data: gwRow } = await supabase
    .from("game_fixture_gameweeks")
    .select("gameweek, fixtures!inner(kickoff_at)")
    .eq("game_id", game.id)
    .gte("fixtures.kickoff_at", new Date().toISOString())
    .order("gameweek", { ascending: true })
    .limit(1)
    .maybeSingle();
  const currentGameweek = gwRow?.gameweek ?? null;

  const header = (
    <div>
      <div className="mb-4">
        <GameSecondaryNav gameSlug={game.slug} gameDisplayName={game.display_name} />
      </div>
      <h1 className="text-2xl font-semibold text-white">Captains</h1>
      <p className="mt-1 text-sm text-navy-300">
        {squad.name} · one captain per match-day - only players with a real fixture that day are eligible.
      </p>
    </div>
  );

  if (currentGameweek === null) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-3xl">
          {header}
          <p className="mt-8 text-sm text-red-400">No gameweek calendar published yet - can&apos;t show match-days without one.</p>
        </main>
      </div>
    );
  }

  const matchDays = await getMatchDaysForSquad(supabase, game.id, squadId, currentGameweek, currentGameweek + PLAN_LENGTH_GAMEWEEKS - 1);
  await ensureAutoPicks(supabase, squadId, matchDays);

  const { data: existingPicksRaw } = await supabase
    .from("squad_match_day_captains")
    .select("match_date, captain_game_player_id, vice_captain_game_player_id, auto_picked")
    .eq("squad_id", squadId);
  const pickByMatchDate = new Map((existingPicksRaw ?? []).map((p) => [p.match_date as string, p]));

  const daysByGameweek = new Map<number, typeof matchDays>();
  for (const day of matchDays) {
    const list = daysByGameweek.get(day.gameweek) ?? [];
    list.push(day);
    daysByGameweek.set(day.gameweek, list);
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-3xl">
        {header}

        {matchDays.length === 0 ? (
          <p className="mt-8 text-sm text-navy-400">No upcoming fixtures found for this squad&apos;s players yet.</p>
        ) : (
          <div className="mt-6 flex flex-col gap-8">
            {Array.from(daysByGameweek.entries()).map(([gameweek, days]) => (
              <div key={gameweek}>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">Gameweek {gameweek}</h2>
                <div className="mt-3 flex flex-col gap-4">
                  {days.map((day) => {
                    const existing = pickByMatchDate.get(day.matchDate);
                    return (
                      <MatchDayCaptainPicker
                        key={day.matchDate}
                        squadId={squadId}
                        matchDate={day.matchDate}
                        eligiblePlayers={day.eligiblePlayers}
                        currentCaptainId={existing?.captain_game_player_id ?? null}
                        currentViceCaptainId={existing?.vice_captain_game_player_id ?? null}
                        autoPicked={existing?.auto_picked ?? false}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
