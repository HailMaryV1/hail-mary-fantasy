import Link from "next/link";
import { createAuthServerClient } from "@/lib/supabaseServerClient";
import { getSeasonTiming } from "@/lib/gameweek";
import { detectFixtureRuns, type FixtureDifficultyRow, type FixtureRun } from "@/lib/fixtureRuns";
import { computeWatchlistStatus, WATCHLIST_STATUS_DISPLAY } from "@/lib/watchlistStatus";
import { computeWatchlistAlerts, type WatchlistEntryWithComputedState } from "@/lib/watchlistAlerts";
import { reconcileWatchlistSnapshot, type SnapshotUpdate } from "./actions";
import Badge from "../squads/Badge";
import StatusPill from "../StatusPill";
import WatchlistAlerts from "./WatchlistAlerts";
import WatchlistRowActions from "./WatchlistRowActions";
import WatchlistNotesInput from "./WatchlistNotesInput";
import GameSecondaryNav from "../GameSecondaryNav";

// Same reasoning as rankings/page.tsx and fixtures/page.tsx - this page
// calls .rpc() and reads searchParams, both of which need fresh data per
// request rather than Next's fetch Data Cache serving a stale response.
export const dynamic = "force-dynamic";

const GAMES = [
  { slug: "dreamteam", label: "Dream Team" },
  { slug: "fanteam", label: "FanTeam" },
] as const;

const REASON_LABELS: Record<string, string> = {
  fixture_swing: "Fixture Swing",
  differential: "Differential",
  form: "Form",
  price_watch: "Price Watch",
  injury_return: "Injury Return",
  minutes_increasing: "Minutes Increasing",
  buy_target: "Buy Target",
  sell_watch: "Sell Watch",
};

type WatchlistEntryRow = {
  id: number;
  game_player_id: number;
  watch_reasons: string[];
  notes: string | null;
  last_seen_score: number | null;
  last_seen_status: string | null;
  last_seen_swing_kind: string | null;
};

type RawFixtureJoin = {
  gameweek: number;
  fixtures: {
    id: number;
    home_team_id: number;
    away_team_id: number;
    home: { name: string };
    away: { name: string };
  } | null;
};

type PoolRow = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_id: number;
  team_name: string;
  price: number;
  hail_mary_score: number | null;
  lineup: string | null;
  status: string | null;
};

type HorizonRow = { game_player_id: number; avg_score: number; gameweeks_included: number };

function statusPillClasses(tone: "green" | "amber" | "red" | "gray") {
  if (tone === "green") return "bg-emerald-950 text-emerald-400";
  if (tone === "amber") return "bg-amber-950 text-amber-400";
  if (tone === "red") return "bg-red-950 text-red-400";
  return "bg-navy-800 text-navy-400";
}

export default async function WatchlistPage({ searchParams }: { searchParams: Promise<{ game?: string }> }) {
  const { game: gameParam } = await searchParams;
  const activeGame = GAMES.find((g) => g.slug === gameParam) ?? GAMES[1]; // default FanTeam - the only game with real status/gameweek data right now

  const supabase = await createAuthServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const secondaryNav = (
    <div className="mb-4">
      <GameSecondaryNav gameSlug={activeGame.slug} gameDisplayName={activeGame.label} />
    </div>
  );

  const gameToggle = (
    <nav className="mt-6 flex gap-2">
      {GAMES.map((g) => (
        <Link
          key={g.slug}
          href={`/watchlist?game=${g.slug}`}
          prefetch={false}
          className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
            g.slug === activeGame.slug ? "bg-sky-500 text-navy-950" : "bg-navy-900 text-navy-300 hover:bg-navy-800 hover:text-white"
          }`}
        >
          {g.label}
        </Link>
      ))}
    </nav>
  );

  if (!user) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-3xl">
          <h1 className="text-2xl font-semibold text-white">Watchlist</h1>
          <p className="mt-4 text-sm text-navy-300">
            <Link href="/login" className="text-sky-400 hover:text-sky-300">
              Sign in
            </Link>{" "}
            to use the watchlist.
          </p>
        </main>
      </div>
    );
  }

  const { data: game } = await supabase.from("fantasy_games").select("id, slug").eq("slug", activeGame.slug).single();
  if (!game) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-3xl">
          <p className="text-sm text-red-400">Unknown game.</p>
        </main>
      </div>
    );
  }

  const { data: entriesRaw } = await supabase
    .from("watchlist_entries")
    .select("id, game_player_id, watch_reasons, notes, last_seen_score, last_seen_status, last_seen_swing_kind")
    .eq("user_id", user.id)
    .eq("game_id", game.id)
    .order("added_at", { ascending: false })
    .returns<WatchlistEntryRow[]>();
  const entries = entriesRaw ?? [];
  const gamePlayerIds = entries.map((e) => e.game_player_id);

  if (gamePlayerIds.length === 0) {
    return (
      <div className="min-h-screen bg-navy-950 px-6 py-10">
        <main className="mx-auto max-w-6xl">
          {secondaryNav}
          <h1 className="text-2xl font-semibold text-white">Watchlist</h1>
          <p className="mt-1 text-sm text-navy-300">Players you&apos;re monitoring, with fixture-swing timing and status.</p>
          {gameToggle}
          <p className="mt-8 text-sm text-navy-300">
            No players watched yet for {activeGame.label}. Add players from the Fixture Swing Panel on your{" "}
            <Link href="/squads" className="text-sky-400 hover:text-sky-300">
              squad transfers page
            </Link>
            .
          </p>
        </main>
      </div>
    );
  }

  const { data: pool } = await supabase
    .from("game_player_pool")
    .select("*")
    .eq("game_slug", activeGame.slug)
    .in("game_player_id", gamePlayerIds)
    .returns<PoolRow[]>();
  const poolById = new Map((pool ?? []).map((p) => [p.game_player_id, p]));

  const { planningGameweek } = await getSeasonTiming(supabase, game.id);

  const { data: horizonRaw } =
    planningGameweek !== null
      ? await supabase.rpc("player_score_by_horizon_from", { p_game_slug: activeGame.slug, p_start_gameweek: planningGameweek, p_num_gameweeks: 5 })
      : await supabase.rpc("player_score_by_horizon", { p_game_slug: activeGame.slug, p_num_gameweeks: 5 });
  const horizonRows = horizonRaw as HorizonRow[] | null;
  const expectedPointsById = new Map((horizonRows ?? []).map((r) => [r.game_player_id, r.avg_score * r.gameweeks_included]));

  // Whole-season fixture data, deliberately NOT filtered to kickoff_at >=
  // now() unlike fixtures/page.tsx and FixtureSwingPanel - "Expired"
  // status needs to know about a good run that already ended, which a
  // future-only query would never surface at all.
  const { data: fixturesRaw } = await supabase
    .from("game_fixture_gameweeks")
    .select(
      "gameweek, fixtures(id, home_team_id, away_team_id, home:teams!fixtures_home_team_id_fkey(name), away:teams!fixtures_away_team_id_fkey(name))"
    )
    .eq("game_id", game.id)
    .order("gameweek");

  const { data: difficultyRaw } = await supabase
    .from("team_fixture_difficulty")
    .select("fixture_id, team_id, attack_score, clean_sheet_score")
    .eq("game_id", game.id);
  const difficultyByFixtureTeam = new Map((difficultyRaw ?? []).map((d) => [`${d.fixture_id}:${d.team_id}`, d]));

  const rows: FixtureDifficultyRow[] = [];
  for (const row of (fixturesRaw ?? []) as unknown as RawFixtureJoin[]) {
    const f = row.fixtures;
    if (!f) continue;
    for (const [teamId, teamName] of [
      [f.home_team_id, f.home.name],
      [f.away_team_id, f.away.name],
    ] as const) {
      const diff = difficultyByFixtureTeam.get(`${f.id}:${teamId}`);
      rows.push({
        teamName,
        gameweek: row.gameweek,
        attackScore: diff ? Number(diff.attack_score) : null,
        cleanSheetScore: diff ? Number(diff.clean_sheet_score) : null,
      });
    }
  }

  const runs = detectFixtureRuns(rows);
  const runsByTeam = new Map<string, FixtureRun[]>();
  for (const run of runs) {
    const list = runsByTeam.get(run.teamName) ?? [];
    list.push(run);
    runsByTeam.set(run.teamName, list);
  }

  function teamRunInfo(teamName: string) {
    const teamRuns = (runsByTeam.get(teamName) ?? []).slice().sort((a, b) => a.startGameweek - b.startGameweek);
    const goodRuns = teamRuns.filter((r) => r.kind === "good");
    const badRuns = teamRuns.filter((r) => r.kind === "bad");
    const gw = planningGameweek ?? 0;
    const nearestGoodRun = goodRuns.find((r) => r.endGameweek >= gw) ?? null;
    const nearestBadRun = badRuns.find((r) => r.endGameweek >= gw) ?? null;
    const lastGoodRunEndGameweek = goodRuns.length > 0 ? Math.max(...goodRuns.map((r) => r.endGameweek)) : null;
    return { nearestGoodRun, nearestBadRun, lastGoodRunEndGameweek };
  }

  function currentSwingKind(nearestGoodRun: FixtureRun | null, nearestBadRun: FixtureRun | null): "good" | "bad" | null {
    if (planningGameweek == null) return null;
    if (nearestBadRun && planningGameweek >= nearestBadRun.startGameweek && planningGameweek <= nearestBadRun.endGameweek) return "bad";
    if (nearestGoodRun && planningGameweek >= nearestGoodRun.startGameweek && planningGameweek <= nearestGoodRun.endGameweek) return "good";
    return null;
  }

  const rowsForDisplay = entries
    .map((entry) => {
      const player = poolById.get(entry.game_player_id);
      if (!player) return null;
      const { nearestGoodRun, nearestBadRun, lastGoodRunEndGameweek } = teamRunInfo(player.team_name);
      const status = computeWatchlistStatus({ planningGameweek, nearestBadRun, nearestGoodRun, lastGoodRunEndGameweek });
      const swingKind = currentSwingKind(nearestGoodRun, nearestBadRun);
      const hailMaryScore = player.hail_mary_score != null ? Number(player.hail_mary_score) : null;

      return {
        entry,
        player,
        status,
        swingKind,
        nearestGoodRun,
        expectedPointsNext5: expectedPointsById.get(entry.game_player_id) ?? null,
        hailMaryScore,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  // Alerts + snapshot reconciliation - diff each entry's freshly-computed
  // state against its last-seen snapshot, then persist the new snapshot
  // so the same change isn't re-alerted next load (see lib/watchlistAlerts.ts).
  const alertInputs: WatchlistEntryWithComputedState[] = rowsForDisplay.map((r) => ({
    entryId: r.entry.id,
    gamePlayerId: r.entry.game_player_id,
    fullName: r.player.full_name,
    teamName: r.player.team_name,
    currentScore: r.hailMaryScore,
    lastSeenScore: r.entry.last_seen_score != null ? Number(r.entry.last_seen_score) : null,
    status: r.player.status,
    lastSeenStatus: r.entry.last_seen_status,
    swingKind: r.swingKind,
    lastSeenSwingKind: r.entry.last_seen_swing_kind,
    nearestGoodRunStartsInGameweeks:
      r.nearestGoodRun && planningGameweek != null ? r.nearestGoodRun.startGameweek - planningGameweek : null,
  }));
  const alerts = computeWatchlistAlerts(alertInputs);

  const snapshotUpdates: SnapshotUpdate[] = rowsForDisplay.map((r) => ({
    id: r.entry.id,
    lastSeenScore: r.hailMaryScore,
    lastSeenLineup: r.player.lineup,
    lastSeenStatus: r.player.status,
    lastSeenSwingKind: r.swingKind,
  }));
  await reconcileWatchlistSnapshot(snapshotUpdates);

  return (
    <div className="min-h-screen bg-navy-950 px-6 py-10">
      <main className="mx-auto max-w-6xl">
        {secondaryNav}
        <h1 className="text-2xl font-semibold text-white">Watchlist</h1>
        <p className="mt-1 text-sm text-navy-300">Players you&apos;re monitoring, with fixture-swing timing and status.</p>
        {gameToggle}

        <div className="mt-6">
          <WatchlistAlerts alerts={alerts} />
        </div>

        <div className="overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
                <th className="px-4 py-3 font-medium">Player</th>
                <th className="px-4 py-3 font-medium">Team</th>
                <th className="px-4 py-3 font-medium">Pos</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">Hail Mary</th>
                <th className="px-4 py-3 text-right font-medium">xPts (5)</th>
                <th className="px-4 py-3 font-medium">Swing</th>
                <th className="px-4 py-3 font-medium">Starts GW</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Reason</th>
                <th className="px-4 py-3 font-medium">Notes</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rowsForDisplay.map(({ entry, player, status, swingKind, nearestGoodRun, expectedPointsNext5, hailMaryScore }) => {
                const statusDisplay = WATCHLIST_STATUS_DISPLAY[status];
                return (
                  <tr key={entry.id} className="border-b border-navy-800 last:border-0">
                    <td className="px-4 py-3 font-medium text-white">
                      <Link href={`/players/${entry.game_player_id}`} className="flex items-center hover:text-sky-300">
                        {player.full_name}
                        <StatusPill lineup={player.lineup} status={player.status} />
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-navy-300">
                      <div className="flex items-center gap-1.5">
                        <Badge teamName={player.team_name} size="sm" />
                        {player.team_name}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-navy-300">{player.position}</td>
                    <td className="px-4 py-3 text-right text-navy-300">£{Number(player.price).toFixed(1)}m</td>
                    <td className="px-4 py-3 text-right text-sky-400">{hailMaryScore != null ? hailMaryScore.toFixed(1) : "-"}</td>
                    <td className="px-4 py-3 text-right text-navy-300">
                      {expectedPointsNext5 != null ? expectedPointsNext5.toFixed(1) : "-"}
                    </td>
                    <td className="px-4 py-3">
                      {swingKind ? (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                            swingKind === "good" ? "bg-emerald-950 text-emerald-400" : "bg-red-950 text-red-400"
                          }`}
                        >
                          {swingKind === "good" ? "↑ Good" : "↓ Tough"}
                        </span>
                      ) : (
                        <span className="text-xs text-navy-500">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-navy-300">{nearestGoodRun ? `GW${nearestGoodRun.startGameweek}` : "-"}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusPillClasses(statusDisplay.tone)}`}>
                        {statusDisplay.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {entry.watch_reasons.map((r) => (
                          <span key={r} className="rounded bg-navy-800 px-1.5 py-0.5 text-[10px] text-navy-300">
                            {REASON_LABELS[r] ?? r}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <WatchlistNotesInput entryId={entry.id} initialNotes={entry.notes} />
                    </td>
                    <td className="px-4 py-3">
                      <WatchlistRowActions entryId={entry.id} gamePlayerId={entry.game_player_id} gameId={game.id} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
