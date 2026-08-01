import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSquadStatuses } from "@/lib/squadStatus";
import SquadCardActions from "./SquadCardActions";

// See rankings/page.tsx for why this is needed - Supabase's .rpc() POSTs
// to a fixed URL regardless of parameters, so Next's fetch Data Cache can
// serve stale per-squad projected scores here.
export const dynamic = "force-dynamic";

export default async function SquadsPage() {
  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const allStatuses = await getSquadStatuses(supabase, user!.id);

  // Only games the frontend actually supports (a game_squad_rules row
  // exists) get listed here - same signal app/page.tsx's dashboard and
  // NavBar.tsx already use. Cloud FF's provider sync writes a real squad
  // row directly (scripts/sync_provider_squads.py), bypassing this page's
  // normal creation flow entirely, so without this filter a real Cloud FF
  // squad would show up here with "Manage squad"/"Look ahead" links that
  // 404 or degrade (no game_squad_rules row for it) - this doesn't touch
  // that squad row, the provider link, or the sync pipeline at all, it
  // just isn't listed until the frontend actually supports the game.
  const { data: rulesRows } = await supabase.from("game_squad_rules").select("game_id");
  const configuredGameIds = new Set((rulesRows ?? []).map((r) => r.game_id));

  // Scratch squads (see migration 0059) are for testing an alternative
  // route through Ask Mary, not real entries - kept out of the main
  // per-game groups below entirely and shown in their own section, so
  // they're never mistaken for a real team.
  const statuses = allStatuses.filter((s) => !s.isScratch && configuredGameIds.has(s.gameId));
  const scratchStatuses = allStatuses.filter((s) => s.isScratch);
  const sourceNameById = new Map(allStatuses.map((s) => [s.id, s.name]));

  // Grouped by game (was one flat created_at-desc list before - a
  // FanTeam football squad and three FanTeam Golf squads interleaved by
  // recency with nothing telling them apart). Groups ordered by gameId
  // ascending - the same order NavBar.tsx's own `fantasy_games` query
  // uses (`.order("id")`), so the grouping here matches the nav's game
  // order rather than an arbitrary one. Squads within a group keep
  // getSquadStatuses' own created_at-desc order.
  const squadsByGame = new Map<string, { gameId: number; gameDisplayName: string; squads: typeof statuses }>();
  for (const s of statuses) {
    const group = squadsByGame.get(s.gameSlug);
    if (group) group.squads.push(s);
    else squadsByGame.set(s.gameSlug, { gameId: s.gameId, gameDisplayName: s.gameDisplayName, squads: [s] });
  }
  const groupedStatuses = Array.from(squadsByGame.values()).sort((a, b) => a.gameId - b.gameId);

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-2xl">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-white">My Squads</h1>
          <div className="flex gap-2">
            <Link
              href="/squads/new?game=dreamteam"
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-navy-950 hover:bg-sky-400"
            >
              + Dream Team squad
            </Link>
            <Link
              href="/squads/new?game=fanteam"
              className="rounded-lg border border-navy-700 bg-navy-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
            >
              + FanTeam squad
            </Link>
            <Link
              href="/squads/new?game=fanteam&scratch=1"
              title="Build a squad purely to test through Ask Mary - won't show up as a real team"
              className="rounded-lg border border-dashed border-navy-600 bg-navy-900 px-3 py-1.5 text-sm font-medium text-navy-300 hover:border-sky-500 hover:text-white"
            >
              + Test squad
            </Link>
          </div>
        </div>

        {allStatuses.length === 0 && (
          <p className="mt-8 text-sm text-navy-300">
            No squads yet - build one above.
          </p>
        )}

        <div className="mt-6 flex flex-col gap-8">
          {groupedStatuses.map((group) => (
            <div key={group.gameId}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">{group.gameDisplayName}</h2>
              <div className="mt-3 flex flex-col gap-3">
                {group.squads.map((s) => (
                  <div
                    key={s.id}
                    className="rounded-xl border border-navy-700 bg-navy-900 p-4"
                  >
                    <div className="flex items-center justify-between">
                      <Link href={`/squads/${s.id}`} className="font-medium text-white hover:text-sky-300">
                        {s.name}
                      </Link>
                      {s.needsAttention && (
                        <span className="rounded-full bg-amber-950 px-2 py-0.5 text-xs font-medium text-amber-400">
                          Starting XI not set
                        </span>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-navy-300">
                      <span>£{s.budgetRemaining.toFixed(1)}m in the bank</span>
                      {s.hasBench && <span>{s.freeTransfers} free transfer{s.freeTransfers === 1 ? "" : "s"}</span>}
                      {s.nextGameweekScore != null && (
                        <span className="text-sky-400">Projected GW{s.currentGameweek}: {s.nextGameweekScore.toFixed(1)} pts</span>
                      )}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <Link
                        href={`/squads/${s.id}`}
                        className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
                      >
                        Manage squad
                      </Link>
                      <Link
                        href={`/squads/${s.id}/analysis`}
                        className="rounded-lg border border-navy-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-navy-800"
                      >
                        Look ahead
                      </Link>
                    </div>

                    <SquadCardActions squadId={s.id} squadName={s.name} gameSlug={s.gameSlug} />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {scratchStatuses.length > 0 && (
          <div className="mt-10">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-navy-400">
              Test Squads <span className="text-navy-600">- not real teams</span>
            </h2>
            <div className="mt-3 flex flex-col gap-3">
              {scratchStatuses.map((s) => (
                <div key={s.id} className="rounded-xl border border-dashed border-navy-700 bg-navy-900/60 p-4">
                  <p className="font-medium text-white">{s.name}</p>
                  {s.scratchSourceSquadId != null && (
                    <p className="mt-0.5 text-xs text-navy-500">
                      Testing an alternative to {sourceNameById.get(s.scratchSourceSquadId) ?? "a deleted squad"}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Link
                      href={`/ask-mary?squad=${s.id}`}
                      className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-navy-950 hover:bg-sky-400"
                    >
                      Analyse in Ask Mary
                    </Link>
                  </div>
                  <SquadCardActions squadId={s.id} squadName={s.name} gameSlug={s.gameSlug} isScratch />
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
