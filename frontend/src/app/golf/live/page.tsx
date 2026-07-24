import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { computeTeamTotal, type GolfOptimizerPlayer } from "@/lib/golfTeamOptimizer";
import LiveRefreshBar from "./LiveRefreshBar";

export const dynamic = "force-dynamic";

type TournamentRow = {
  id: number;
  name: string;
  event_number: number | null;
  registration_time: string;
  end_time: string;
  leaderboard_leader_name: string | null;
  leaderboard_leader_score: number | null;
  leaderboard_leader_remaining_holes: number | null;
};

type SquadRow = {
  id: number;
  name: string;
  golf_captain_game_player_id: number | null;
  squad_players: { game_player_id: number; game_players: { golfers: { full_name: string } } | null }[];
};

type EntryRow = { game_player_id: number; price: number; raw: Record<string, unknown>; remaining_holes: number | null };

type ChangeEventRow = {
  game_player_id: number;
  created_at: string;
  details: { old_points?: number; new_points?: number; delta?: number } | null;
};

type LiveChange = { oldPoints: number; delta: number; at: string };

export default async function GolfLivePage() {
  // Captured once, right as this request starts rendering - not the
  // moment scripts/poll_golf_live_scores.py last ran (we don't track
  // that separately), but "as of" this page load, which is what the
  // auto-refresh loop needs to show a moving clock.
  const fetchedAt = new Date().toISOString();

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Same live-window definition scripts/poll_golf_live_scores.py uses -
  // registration_time is picks-locking (scoring starts), end_time the
  // tournament's final round finish.
  const nowIso = new Date().toISOString();
  const { data: tournaments } = await supabase
    .from("golf_tournaments")
    .select(
      "id, name, event_number, registration_time, end_time, leaderboard_leader_name, leaderboard_leader_score, leaderboard_leader_remaining_holes"
    )
    .lte("registration_time", nowIso)
    .gte("end_time", nowIso)
    .order("start_time", { ascending: false })
    .limit(1)
    .returns<TournamentRow[]>();
  const tournament = tournaments?.[0] ?? null;

  let teamRows: {
    id: number;
    name: string;
    total: number;
    captainId: number | null;
    underdogId: number | null;
    remainingHoles: number | null;
    players: (GolfOptimizerPlayer & { change: LiveChange | null })[];
  }[] = [];

  if (user && tournament) {
    const { data: squadsRaw } = await supabase
      .from("squads")
      .select("id, name, golf_captain_game_player_id, squad_players(game_player_id, game_players(golfers(full_name)))")
      .eq("golf_tournament_id", tournament.id)
      .eq("user_id", user.id)
      .returns<SquadRow[]>();
    const squads = squadsRaw ?? [];

    const allGamePlayerIds = Array.from(new Set(squads.flatMap((s) => s.squad_players.map((sp) => sp.game_player_id))));

    if (allGamePlayerIds.length > 0) {
      const { data: entries } = await supabase
        .from("golf_tournament_entries")
        .select("game_player_id, price, raw, remaining_holes")
        .eq("tournament_id", tournament.id)
        .in("game_player_id", allGamePlayerIds)
        .returns<EntryRow[]>();
      const entryByPlayer = new Map((entries ?? []).map((e) => [e.game_player_id, e]));

      // Most-recent golf_score_changed event per golfer - old_points/delta
      // are exactly what scripts/poll_golf_live_scores.py logged at the
      // moment it detected the change (see that script's log_event call),
      // reused here rather than storing a duplicate "previous score"
      // column anywhere.
      const { data: changeEvents } = await supabase
        .from("activity_log")
        .select("game_player_id, details, created_at")
        .eq("event_type", "golf_score_changed")
        .in("game_player_id", allGamePlayerIds)
        .order("created_at", { ascending: false })
        .returns<ChangeEventRow[]>();

      const latestChangeByPlayer = new Map<number, LiveChange>();
      for (const ev of changeEvents ?? []) {
        if (ev.game_player_id == null || latestChangeByPlayer.has(ev.game_player_id)) continue; // rows already ordered desc - first hit is the latest
        latestChangeByPlayer.set(ev.game_player_id, {
          oldPoints: Number(ev.details?.old_points ?? 0),
          delta: Number(ev.details?.delta ?? 0),
          at: ev.created_at,
        });
      }

      const nameByPlayer = new Map<number, string>();
      for (const s of squads) for (const sp of s.squad_players) nameByPlayer.set(sp.game_player_id, sp.game_players?.golfers?.full_name ?? "Unknown");

      teamRows = squads.map((s) => {
        // Borrowing GolfOptimizerPlayer/computeTeamTotal here for their
        // captain/underdog x1.25 math, not their projection meaning -
        // expectedPoints holds this golfer's LIVE FanTeam score, not a
        // Hail Mary projection.
        const players: GolfOptimizerPlayer[] = s.squad_players.map((sp) => {
          const entry = entryByPlayer.get(sp.game_player_id);
          const raw = entry?.raw as { points?: number } | undefined;
          return {
            gamePlayerId: sp.game_player_id,
            fullName: nameByPlayer.get(sp.game_player_id) ?? "Unknown",
            price: Number(entry?.price ?? 0),
            expectedPoints: raw?.points != null ? Number(raw.points) : 0,
            floor: 0,
            ceiling: 0,
            makeCutProbability: null,
          };
        });
        const { total, captainId, underdogId } = computeTeamTotal(players, s.golf_captain_game_player_id);
        // Sum of each golfer's own remaining-holes figure - null (not 0)
        // if ANY golfer's is still unknown, so a team never displays a
        // misleadingly-low RH just because one entry hasn't been polled
        // for this figure yet.
        const remainingHolesValues = s.squad_players.map((sp) => entryByPlayer.get(sp.game_player_id)?.remaining_holes ?? null);
        const remainingHoles = remainingHolesValues.every((v) => v != null)
          ? remainingHolesValues.reduce((sum: number, v) => sum + (v as number), 0)
          : null;
        return {
          id: s.id,
          name: s.name,
          total,
          captainId,
          underdogId,
          remainingHoles,
          players: players.map((p) => ({ ...p, change: latestChangeByPlayer.get(p.gamePlayerId) ?? null })),
        };
      });
      teamRows.sort((a, b) => b.total - a.total);
    }
  }

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-4xl">
        <Link href="/golf" className="text-sm text-navy-400 hover:text-sky-300">
          ← FanTeam Golf
        </Link>

        <h1 className="mt-3 text-2xl font-semibold text-white">Live Scores</h1>
        <p className="mt-1 text-sm text-navy-300">
          {tournament
            ? `${tournament.name}${tournament.event_number ? ` · Gameweek ${tournament.event_number}` : ""} · updates every ~5 minutes while the tournament is live`
            : "No tournament is live right now."}
        </p>
        {tournament && <LiveRefreshBar fetchedAt={fetchedAt} />}

        {tournament?.leaderboard_leader_name && tournament.leaderboard_leader_score != null && (
          <div className="mt-4 flex items-center justify-between rounded-lg border border-amber-800 bg-amber-950/40 px-4 py-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-amber-500">Contest leaderboard leader</p>
              <p className="text-sm font-semibold text-white">{tournament.leaderboard_leader_name}</p>
            </div>
            <div className="text-right">
              <p className="text-lg font-semibold text-amber-400">{tournament.leaderboard_leader_score.toFixed(1)} pts</p>
              {tournament.leaderboard_leader_remaining_holes != null && (
                <p className="text-xs text-amber-500/70">{tournament.leaderboard_leader_remaining_holes} holes remaining</p>
              )}
            </div>
          </div>
        )}

        {!user && (
          <p className="mt-8 text-sm text-navy-300">
            <Link href="/login" className="text-sky-400 hover:text-sky-300">Sign in</Link> to see your saved teams' live scores.
          </p>
        )}

        {user && tournament && teamRows.length === 0 && (
          <p className="mt-8 text-sm text-navy-300">
            No saved teams for this tournament yet. <Link href="/golf/team" className="text-sky-400 hover:text-sky-300">Build one →</Link>
          </p>
        )}

        <div className="mt-6 flex flex-col gap-6">
          {teamRows.map((team) => (
            <div key={team.id} className="overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
              <div className="flex items-center justify-between border-b border-navy-700 px-4 py-3">
                <p className="text-sm font-semibold text-white">{team.name}</p>
                <div className="text-right">
                  <p className="text-sm font-semibold text-sky-400">{team.total.toFixed(1)} pts live</p>
                  {tournament?.leaderboard_leader_score != null && (
                    <p className="text-xs text-navy-400">
                      {(() => {
                        const gap = team.total - tournament.leaderboard_leader_score!;
                        return gap >= 0 ? (
                          <span className="text-emerald-400">+{gap.toFixed(1)} ahead of the leader</span>
                        ) : (
                          `${Math.abs(gap).toFixed(1)} off the lead`
                        );
                      })()}
                    </p>
                  )}
                  {team.remainingHoles != null && <p className="text-xs text-navy-500">{team.remainingHoles} holes remaining</p>}
                </div>
              </div>
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-navy-800 text-xs uppercase tracking-wide text-navy-400">
                    <th className="px-4 py-2 font-medium">Golfer</th>
                    <th className="px-4 py-2 text-right font-medium">Current</th>
                    <th className="px-4 py-2 text-right font-medium">Previous</th>
                    <th className="px-4 py-2 text-right font-medium">Last change</th>
                  </tr>
                </thead>
                <tbody>
                  {team.players.map((p) => {
                    const isCaptain = p.gamePlayerId === team.captainId;
                    const isUnderdog = p.gamePlayerId === team.underdogId;
                    // Same rule computeTeamTotal already applies to the
                    // team total (captain OR underdog x1.25, not stacked
                    // if one golfer is both) - mirrored here per-row so
                    // the displayed number matches what this golfer
                    // actually contributed, the same convention FanTeam's
                    // own live pitch view uses (confirmed live: their
                    // displayed captain/underdog scores are already
                    // multiplied, not raw).
                    const multiplier = isCaptain || isUnderdog ? 1.25 : 1;
                    return (
                      <tr key={p.gamePlayerId} className="border-b border-navy-800 last:border-0">
                        <td className="px-4 py-2 font-medium text-white">
                          {p.fullName}
                          {isCaptain && (
                            <span className="ml-1.5 rounded bg-sky-950 px-1 py-0.5 text-[9px] font-bold text-sky-400">C</span>
                          )}
                          {isUnderdog && (
                            <span className="ml-1.5 rounded bg-emerald-950 px-1 py-0.5 text-[9px] font-bold text-emerald-400">UD</span>
                          )}
                          {multiplier > 1 && <span className="ml-1.5 text-[10px] text-navy-500">×1.25</span>}
                        </td>
                        <td className="px-4 py-2 text-right text-white">{(p.expectedPoints * multiplier).toFixed(1)}</td>
                        <td className="px-4 py-2 text-right text-navy-400">
                          {p.change ? (p.change.oldPoints * multiplier).toFixed(1) : "—"}
                        </td>
                        <td
                          className={`px-4 py-2 text-right font-semibold ${
                            !p.change ? "text-navy-500" : p.change.delta >= 0 ? "text-emerald-400" : "text-red-400"
                          }`}
                        >
                          {p.change
                            ? `${p.change.delta >= 0 ? "+" : ""}${(p.change.delta * multiplier).toFixed(1)}`
                            : "No change yet"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
