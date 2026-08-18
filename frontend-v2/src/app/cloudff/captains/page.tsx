import Link from "next/link";
import { redirect } from "next/navigation";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { getMatchDaysForSquad, ensureAutoPicks, fetchScoresForMatchDays, type MatchDay } from "@/lib/matchDayCaptains";
import MatchDayCaptainPicker from "./MatchDayCaptainPicker";

// Squad state (captain picks) changes from a server action elsewhere -
// same "never serve a stale cached response" reasoning as every other
// data-driven page here.
export const dynamic = "force-dynamic";

// How many gameweeks ahead to show - matches the old frontend's Captains
// page window (which itself matched Ask Mary's own planning window), so
// this and any future per-match-day recommendations never disagree about
// which days are even in view.
const PLAN_LENGTH_GAMEWEEKS = 3;

export default async function CloudFFCaptainsPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: game } = await supabase.from("fantasy_games").select("id, display_name").eq("slug", "cloudff").maybeSingle();

  // Squad lookup and season timing both only need game.id and don't
  // depend on each other's result - one Promise.all instead of two
  // sequential round trips, same fix already applied to the board page.
  const [{ data: squad }, seasonTiming] = game
    ? await Promise.all([
        supabase
          .from("squads")
          .select("id, name")
          .eq("game_id", game.id)
          .eq("user_id", user.id)
          .eq("is_archived", false)
          .order("created_at")
          .limit(1)
          .maybeSingle<{ id: number; name: string }>(),
        getSeasonTiming(supabase, game.id),
      ])
    : [{ data: null }, { seasonStarted: false, planningGameweek: null }];

  const header = (
    <div>
      <Link href="/cloudff" className="text-sm font-medium text-navy-400 hover:text-sky-400">
        ← Back to squad
      </Link>
      <h1 className="mt-4 text-2xl font-semibold text-white">Captains</h1>
      <p className="mt-1 text-sm text-navy-300">
        {squad?.name ?? "Cloud FF"} · one captain per match-day - only players with a real fixture that day are eligible.
      </p>
    </div>
  );

  if (!game || !squad) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-3xl">
          {header}
          <p className="mt-8 text-sm text-navy-300">No squad yet.</p>
        </main>
      </div>
    );
  }

  const { planningGameweek } = seasonTiming;

  if (planningGameweek === null) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-3xl">
          {header}
          <p className="mt-8 text-sm text-red-400">No gameweek calendar published yet - can&apos;t show match-days without one.</p>
        </main>
      </div>
    );
  }

  const matchDays = await getMatchDaysForSquad(supabase, game.id, squad.id, planningGameweek, planningGameweek + PLAN_LENGTH_GAMEWEEKS - 1);
  const scoresByGameweek = await fetchScoresForMatchDays(supabase, matchDays);
  await ensureAutoPicks(supabase, squad.id, matchDays, scoresByGameweek);

  const { data: existingPicksRaw } = await supabase
    .from("squad_match_day_captains")
    .select("match_date, captain_game_player_id, vice_captain_game_player_id, auto_picked")
    .eq("squad_id", squad.id);
  const pickByMatchDate = new Map((existingPicksRaw ?? []).map((p) => [p.match_date as string, p]));

  const daysByGameweek = new Map<number, MatchDay[]>();
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
                        squadId={squad.id}
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
