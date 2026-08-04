"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import PitchView, { type PitchPlayer } from "@/components/PitchView";
import { makeFanteamTransfer, reorderFanteamBench, setFanteamFormation, setFanteamCaptain, swapFanteamLineup } from "../actions";

export type FixtureTile = { opponentAbbr: string; isHome: boolean; difficulty: number };

export type BoardPlayer = {
  game_player_id: number;
  full_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  team_name: string;
  team_id: number;
  price: number;
  score: number | null;
  isCaptain: boolean;
  isViceCaptain: boolean;
  isStarting: boolean;
  // Real bench priority (1/2/3 for the 3 outfield reserves, null for
  // starters and the single reserve GK - a 15-man squad only ever has
  // one bench GK, so there's nothing to order there).
  benchOrder: number | null;
  fixtures: (FixtureTile | null)[];
  goalProjected: number;
  assistProjected: number;
  bonusProjected: number;
};

export type PoolPlayer = Omit<BoardPlayer, "isCaptain" | "isViceCaptain" | "isStarting" | "benchOrder">;

type DisplayMode = "next1" | "next2" | "next3" | "pts" | "pred";
type SortBy = "pts" | "goals" | "assists" | "bonus";

const SORT_OPTIONS: [SortBy, string][] = [
  ["pts", "Pts"],
  ["goals", "Goals"],
  ["assists", "Assists"],
  ["bonus", "Bonus"],
];
const VALUE_BANDS = [4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 9, 10, 12, 14];

function sortValue(p: PoolPlayer, sortBy: SortBy): number {
  switch (sortBy) {
    case "goals":
      return p.goalProjected;
    case "assists":
      return p.assistProjected;
    case "bonus":
      return p.bonusProjected;
    case "pts":
    default:
      return p.score ?? -Infinity;
  }
}

// attack_score is 0-1, higher = a better attacking fixture (easier) for
// that team - same tiering used on the Dream Team board.
function difficultyColor(d: number): string {
  if (d >= 0.6) return "bg-emerald-600";
  if (d >= 0.45) return "bg-emerald-800";
  if (d >= 0.35) return "bg-navy-700";
  if (d >= 0.25) return "bg-amber-800";
  return "bg-red-800";
}

function fixtureTilesFor(tiles: (FixtureTile | null)[], count: number): { label: string; colorClass: string }[] {
  return tiles
    .slice(0, count)
    .filter((t): t is FixtureTile => t !== null)
    .map((t) => ({
      label: t.isHome ? t.opponentAbbr : t.opponentAbbr.toLowerCase(),
      colorClass: difficultyColor(t.difficulty),
    }));
}

// FanTeam's real wildcard windows (WC1: gameweeks 2-19, WC2: 20-38) -
// mirrors the same real constants enforced server-side in
// makeFanteamTransfer, duplicated here only for the client-side
// availability preview (fixed real-world gameweek ranges, not
// application logic that can drift).
function wildcardWindowFor(gameweek: number): "wc1" | "wc2" | null {
  if (gameweek >= 2 && gameweek <= 19) return "wc1";
  if (gameweek >= 20 && gameweek <= 38) return "wc2";
  return null;
}

export default function FanTeamBoard({
  squadId,
  squadName,
  transfers,
  bank,
  teamValue,
  planningGameweek,
  wildcard1UsedGameweek,
  wildcard2UsedGameweek,
  maxPerClub,
  seasonStarted,
  formations,
  currentFormationCode,
  isProviderSynced,
  squad,
  pool,
}: {
  squadId: number;
  squadName: string;
  transfers: number;
  bank: number;
  teamValue: number;
  planningGameweek: number;
  wildcard1UsedGameweek: number | null;
  wildcard2UsedGameweek: number | null;
  maxPerClub: number;
  seasonStarted: boolean;
  formations: string[];
  // Null when the current starting XI's GK/DEF/MID/FWD counts don't match
  // any of the 7 real formations - can genuinely happen (a squad synced
  // mid-transfer, or one that's never had a formation applied here yet).
  currentFormationCode: string | null;
  // Captain/vice-captain are read-only (via PitchView's existing C/VC
  // pills) whenever true - a provider-synced squad has them overwritten
  // by the next scheduled FanTeam sync regardless of what's picked here.
  isProviderSynced: boolean;
  squad: BoardPlayer[];
  pool: PoolPlayer[];
}) {
  const [displayMode, setDisplayMode] = useState<DisplayMode>("pts");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [useWildcard, setUseWildcard] = useState(false);
  const [isTransferPending, startTransferTransition] = useTransition();
  const [transferError, setTransferError] = useState<string | null>(null);
  const [isFormationPending, startFormationTransition] = useTransition();
  const [formationError, setFormationError] = useState<string | null>(null);
  const [isBenchPending, startBenchTransition] = useTransition();
  const [benchError, setBenchError] = useState<string | null>(null);
  const [isCaptainPending, startCaptainTransition] = useTransition();
  const [captainError, setCaptainError] = useState<string | null>(null);
  const [isSwapPending, startSwapTransition] = useTransition();
  const [swapError, setSwapError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [posFilter, setPosFilter] = useState<"ALL" | "GK" | "DEF" | "MID" | "FWD">("ALL");
  const [teamFilter, setTeamFilter] = useState<string>("ALL");
  const [maxValue, setMaxValue] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>("pts");

  const teams = Array.from(new Set(pool.map((p) => p.team_name))).sort();

  const wildcardWindow = wildcardWindowFor(planningGameweek);
  const wildcardActiveThisGameweek = wildcard1UsedGameweek === planningGameweek || wildcard2UsedGameweek === planningGameweek;
  const wc1Available = wildcardWindow === "wc1" && wildcard1UsedGameweek === null;
  const wc2Available = wildcardWindow === "wc2" && wildcard2UsedGameweek === null;
  const wildcardOfferable = seasonStarted && !wildcardActiveThisGameweek && (wc1Available || wc2Available);

  function statTextFor(p: { score: number | null }): string {
    switch (displayMode) {
      case "pred":
        return p.score != null ? `${p.score >= 0 ? "+" : ""}${p.score.toFixed(1)}` : "-";
      case "pts":
      default:
        return p.score != null ? `${p.score.toFixed(1)} pts` : "-";
    }
  }

  const fixtureModeCount: Record<string, number> = { next1: 1, next2: 2, next3: 3 };

  function toPitchPlayer(p: BoardPlayer): PitchPlayer {
    return {
      game_player_id: p.game_player_id,
      full_name: p.full_name,
      position: p.position,
      team_name: p.team_name,
      is_starting: p.isStarting,
      price: p.price,
      score: p.score,
      isCaptain: p.isCaptain,
      isViceCaptain: p.isViceCaptain,
      benchOrder: p.benchOrder,
      statText: displayMode in fixtureModeCount ? undefined : statTextFor(p),
      statTiles: displayMode in fixtureModeCount ? fixtureTilesFor(p.fixtures, fixtureModeCount[displayMode]) : undefined,
    };
  }

  const starters = squad.filter((p) => p.isStarting).map(toPitchPlayer);
  // Reserve GK first (never has a benchOrder - a 15-man squad only ever
  // has one), then the 3 outfield reserves in their real priority order.
  // benchOrder can be missing/duplicated on real data (see
  // reorderFanteamBench's docstring) - falls back to game_player_id here
  // so the display default matches exactly what the server would
  // normalize it to on first use, and the two never disagree.
  const benchGK = squad.filter((p) => !p.isStarting && p.position === "GK").map(toPitchPlayer);
  const benchOutfieldRaw = squad.filter((p) => !p.isStarting && p.position !== "GK");
  // Matches reorderFanteamBench's own "any null or duplicate triggers a
  // full renumber" rule exactly - filling only the gaps would risk
  // colliding with a real value still held by someone else (e.g. two
  // players missing an order both defaulting to the same slot a third
  // player already legitimately occupies).
  const outfieldOrders = benchOutfieldRaw.map((p) => p.benchOrder);
  const outfieldNeedsNormalizing = outfieldOrders.some((o) => o == null) || new Set(outfieldOrders).size !== outfieldOrders.length;
  const benchOutfield = benchOutfieldRaw
    .slice()
    .sort((a, b) => (a.benchOrder ?? 99) - (b.benchOrder ?? 99) || a.game_player_id - b.game_player_id)
    .map((p, i) => toPitchPlayer({ ...p, benchOrder: outfieldNeedsNormalizing ? i + 1 : p.benchOrder }));
  const bench = [...benchGK, ...benchOutfield];

  function handleReorderBench(gamePlayerId: number, targetOrder: number) {
    setBenchError(null);
    startBenchTransition(async () => {
      const result = await reorderFanteamBench({ squadId, gamePlayerId, targetOrder });
      if (result?.error) setBenchError(result.error);
    });
  }

  function handleFormationChange(formationCode: string) {
    setFormationError(null);
    startFormationTransition(async () => {
      const result = await setFanteamFormation({ squadId, formationCode });
      if (result?.error) setFormationError(result.error);
    });
  }

  // Server-confirmed captain/VC, from the squad prop.
  const serverCaptainId = squad.find((p) => p.isCaptain)?.game_player_id ?? null;
  const serverViceCaptainId = squad.find((p) => p.isViceCaptain)?.game_player_id ?? null;
  // Locally staged - captain and vice-captain are picked in two separate
  // dropdown changes, but the server requires both non-null and
  // different in one call. Without local staging, picking captain then
  // vice-captain (starting from neither set) would never actually submit:
  // each dropdown's onChange only knows the OTHER field's last
  // server-confirmed value, which is still null until a save succeeds.
  const [pendingCaptainId, setPendingCaptainId] = useState<number | null>(serverCaptainId);
  const [pendingViceCaptainId, setPendingViceCaptainId] = useState<number | null>(serverViceCaptainId);
  useEffect(() => {
    setPendingCaptainId(serverCaptainId);
    setPendingViceCaptainId(serverViceCaptainId);
  }, [serverCaptainId, serverViceCaptainId]);

  const starterOptions = squad.filter((p) => p.isStarting);

  function handleSetCaptain(newCaptainId: number | null, newViceCaptainId: number | null) {
    if (newCaptainId === null || newViceCaptainId === null || newCaptainId === newViceCaptainId) return;
    setCaptainError(null);
    startCaptainTransition(async () => {
      const result = await setFanteamCaptain({ squadId, captainGamePlayerId: newCaptainId, viceCaptainGamePlayerId: newViceCaptainId });
      if (result?.error) setCaptainError(result.error);
    });
  }

  function handleCaptainDropdownChange(newCaptainId: number) {
    setPendingCaptainId(newCaptainId);
    handleSetCaptain(newCaptainId, pendingViceCaptainId);
  }
  function handleViceCaptainDropdownChange(newViceCaptainId: number) {
    setPendingViceCaptainId(newViceCaptainId);
    handleSetCaptain(pendingCaptainId, newViceCaptainId);
  }

  // FanTeam has no hard transfer cap like Dream Team - a transfer is
  // always allowed, just at a real cost (see costPreview below).
  const selectedPlayer = selectedId != null ? squad.find((p) => p.game_player_id === selectedId) : undefined;

  // Same-position, opposite starting/bench status - a real sub, not a
  // transfer. Formation counts are automatically preserved by a
  // same-position swap, so nothing else needs checking client-side (the
  // server re-validates anyway).
  const legalSwapIds = new Set(
    selectedPlayer
      ? squad.filter((p) => p.position === selectedPlayer.position && p.isStarting !== selectedPlayer.isStarting).map((p) => p.game_player_id)
      : []
  );

  function handleSwapLineup(playerAId: number, playerBId: number) {
    setSwapError(null);
    startSwapTransition(async () => {
      const result = await swapFanteamLineup({ squadId, playerAId, playerBId });
      if (result?.error) setSwapError(result.error);
      else setSelectedId(null);
    });
  }

  // Real legality preview: same position, budget, and FanTeam's real
  // max-3-per-club limit. The server (makeFanteamTransfer) is the source
  // of truth and re-checks all of this - this is just so illegal pool
  // rows visibly dim before a doomed click.
  const clubCounts = new Map<number, number>();
  if (selectedPlayer) {
    for (const p of squad) {
      if (p.game_player_id === selectedPlayer.game_player_id) continue;
      clubCounts.set(p.team_id, (clubCounts.get(p.team_id) ?? 0) + 1);
    }
  }
  const legalPoolIds = new Set(
    selectedPlayer
      ? pool
          .filter(
            (p) =>
              p.position === selectedPlayer.position &&
              p.price <= bank + selectedPlayer.price &&
              (clubCounts.get(p.team_id) ?? 0) + 1 <= maxPerClub
          )
          .map((p) => p.game_player_id)
      : []
  );

  const costPreview = !seasonStarted
    ? "Free (pre-season)"
    : wildcardActiveThisGameweek || useWildcard
      ? "Free (wildcard)"
      : transfers > 0
        ? `Free (${transfers} transfer${transfers === 1 ? "" : "s"} left)`
        : "-4 pts (no free transfers left)";

  function handleTransfer(inGamePlayerId: number) {
    if (!selectedId) return;
    setTransferError(null);
    startTransferTransition(async () => {
      const result = await makeFanteamTransfer({ squadId, outGamePlayerId: selectedId, inGamePlayerId, useWildcard });
      if (result?.error) setTransferError(result.error);
      else {
        setSelectedId(null);
        setUseWildcard(false);
      }
    });
  }

  const filteredPool = pool
    .filter(
      (p) =>
        (posFilter === "ALL" || p.position === posFilter) &&
        (teamFilter === "ALL" || p.team_name === teamFilter) &&
        (search === "" || p.full_name.toLowerCase().includes(search.toLowerCase())) &&
        (maxValue === null || p.price <= maxValue)
    )
    .sort((a, b) => sortValue(b, sortBy) - sortValue(a, sortBy));

  const sortColumnLabel = SORT_OPTIONS.find(([v]) => v === sortBy)?.[1] ?? "Pts";

  // Captains score double - a simple sum, not the more elaborate
  // auto-sub-probability-weighted total used elsewhere.
  const projectedPoints = squad.filter((p) => p.isStarting).reduce((sum, p) => sum + (p.score ?? 0) * (p.isCaptain ? 2 : 1), 0);

  return (
    <div className="min-h-screen bg-navy-950 px-4 py-6 sm:px-6">
      <div className="mx-auto max-w-7xl">
        <Link href="/" className="text-sm font-medium text-navy-400 hover:text-sky-400">
          ← Back to main menu
        </Link>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatBox label="Transfers" value={seasonStarted ? String(transfers) : "Unlimited"} />
          <StatBox label="Bank" value={`£${bank.toFixed(1)}m`} />
          <StatBox label="Team Value" value={`£${teamValue.toFixed(1)}m`} />
          <StatBox label="Projected Points" value={projectedPoints.toFixed(1)} />
          <div className="rounded-xl border border-navy-700 bg-navy-900 p-3">
            <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Wildcard</p>
            <p className="mt-0.5 text-sm font-semibold text-white">
              {wildcardActiveThisGameweek
                ? "Active this GW"
                : wildcard1UsedGameweek != null && wildcard2UsedGameweek != null
                  ? "Both used"
                  : wc1Available || wc2Available
                    ? "Available"
                    : "Not in window"}
            </p>
          </div>
        </div>

        {!isProviderSynced && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-navy-700 bg-navy-900 p-3">
            <span className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Captain</span>
            <select
              value={pendingCaptainId ?? ""}
              disabled={isCaptainPending}
              onChange={(e) => handleCaptainDropdownChange(Number(e.target.value))}
              className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
            >
              {pendingCaptainId === null && <option value="">Pick a captain</option>}
              {starterOptions
                .filter((p) => p.game_player_id !== pendingViceCaptainId)
                .map((p) => (
                  <option key={p.game_player_id} value={p.game_player_id}>
                    {p.full_name}
                  </option>
                ))}
            </select>
            <span className="text-[10px] font-medium uppercase tracking-wide text-navy-500">Vice-Captain</span>
            <select
              value={pendingViceCaptainId ?? ""}
              disabled={isCaptainPending}
              onChange={(e) => handleViceCaptainDropdownChange(Number(e.target.value))}
              className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
            >
              {pendingViceCaptainId === null && <option value="">Pick a vice-captain</option>}
              {starterOptions
                .filter((p) => p.game_player_id !== pendingCaptainId)
                .map((p) => (
                  <option key={p.game_player_id} value={p.game_player_id}>
                    {p.full_name}
                  </option>
                ))}
            </select>
            {captainError && <p className="text-xs text-red-400">{captainError}</p>}
            {!captainError && (pendingCaptainId === null || pendingViceCaptainId === null) && (
              <p className="text-xs text-navy-500">Pick both to save.</p>
            )}
          </div>
        )}

        {selectedPlayer && (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-700 bg-sky-950/40 px-4 py-2.5">
            <p className="text-sm text-sky-200">
              <span className="font-semibold text-white">{selectedPlayer.full_name}</span> selected - pick a same-position
              replacement below to transfer, or click a highlighted {selectedPlayer.isStarting ? "bench" : "starting"} player on
              the pitch to sub instead. Next transfer: <span className="font-semibold text-white">{costPreview}</span>
            </p>
            <div className="flex items-center gap-3">
              {wildcardOfferable && (
                <label className="flex items-center gap-1.5 text-xs text-sky-200">
                  <input type="checkbox" checked={useWildcard} onChange={(e) => setUseWildcard(e.target.checked)} />
                  Use {wc1Available ? "Wildcard 1" : "Wildcard 2"}
                </label>
              )}
              <button
                onClick={() => {
                  setSelectedId(null);
                  setUseWildcard(false);
                }}
                className="text-xs font-medium text-sky-400 hover:text-sky-300"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {transferError && <p className="mt-2 text-xs text-red-400">{transferError}</p>}
        {swapError && <p className="mt-2 text-xs text-red-400">{swapError}</p>}
        {benchError && <p className="mt-2 text-xs text-red-400">{benchError}</p>}
        {formationError && <p className="mt-2 text-xs text-red-400">{formationError}</p>}

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-white">{squadName}</h2>
              <div className="flex items-center gap-2">
                <select
                  value={currentFormationCode ?? ""}
                  disabled={isFormationPending}
                  onChange={(e) => handleFormationChange(e.target.value)}
                  aria-label="Formation - picking a new one auto-fills the best 11 for it from your squad"
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
                >
                  {currentFormationCode === null && <option value="">Formation: custom</option>}
                  {formations.map((code) => (
                    <option key={code} value={code}>
                      Formation: {code}
                    </option>
                  ))}
                </select>
                <div className="relative">
                <button
                  onClick={() => setOptionsOpen((o) => !o)}
                  className="rounded-full border border-navy-700 bg-navy-900 px-3 py-1.5 text-xs font-medium text-navy-200 hover:border-sky-500"
                >
                  ☰ Options
                </button>
                {optionsOpen && (
                  <div className="absolute right-0 top-full z-10 mt-1 w-56 rounded-xl border border-navy-700 bg-navy-900 p-2 shadow-xl">
                    <p className="px-2 py-1 text-[10px] font-semibold uppercase text-navy-500">Show on players</p>
                    {(
                      [
                        ["next1", "Next GW Fix"],
                        ["next2", "Next 2 GW Fix"],
                        ["next3", "Next 3 GW Fix"],
                        ["pts", "Pts"],
                        ["pred", `Pred +/- GW${planningGameweek}`],
                      ] as [DisplayMode, string][]
                    ).map(([mode, label]) => (
                      <button
                        key={mode}
                        onClick={() => {
                          setDisplayMode(mode);
                          setOptionsOpen(false);
                        }}
                        className={`block w-full rounded-lg px-2 py-1.5 text-left text-xs ${
                          displayMode === mode ? "bg-sky-500 font-medium text-navy-950" : "text-navy-200 hover:bg-navy-800"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                </div>
              </div>
            </div>
            <PitchView
              starting={starters}
              bench={bench}
              selectedId={selectedId}
              swappableIds={selectedPlayer ? legalSwapIds : null}
              onSelect={(p) => {
                if (isTransferPending || isSwapPending) return;
                if (p.game_player_id === selectedId) {
                  setSelectedId(null);
                  return;
                }
                if (selectedPlayer && legalSwapIds.has(p.game_player_id)) {
                  handleSwapLineup(selectedPlayer.game_player_id, p.game_player_id);
                  return;
                }
                setSelectedId(p.game_player_id);
              }}
              onReorderBench={isBenchPending ? undefined : handleReorderBench}
            />
          </div>

          <div className="rounded-xl border border-navy-700 bg-navy-900 p-4">
            <h2 className="text-sm font-semibold text-white">Browse all available players</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {(["ALL", "GK", "DEF", "MID", "FWD"] as const).map((pos) => (
                <button
                  key={pos}
                  onClick={() => setPosFilter(pos)}
                  className={`rounded-full px-3 py-1 text-xs font-medium ${
                    posFilter === pos ? "bg-sky-500 text-navy-950" : "bg-navy-800 text-navy-300 hover:bg-navy-700"
                  }`}
                >
                  {pos}
                </button>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <select
                value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}
                className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              >
                <option value="ALL">All clubs</option>
                {teams.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <select
                value={maxValue ?? ""}
                onChange={(e) => setMaxValue(e.target.value === "" ? null : Number(e.target.value))}
                className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              >
                <option value="">All values</option>
                {VALUE_BANDS.map((v) => (
                  <option key={v} value={v}>
                    £{v}m or less
                  </option>
                ))}
              </select>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as SortBy)}
                className="rounded-lg border border-navy-700 bg-navy-950 px-2 py-1.5 text-xs text-navy-200 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
              >
                {SORT_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    Sort: {label}
                  </option>
                ))}
              </select>
            </div>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search player..."
              className="mt-2 w-full rounded-lg border border-navy-700 bg-navy-950 px-3 py-2 text-sm text-white placeholder:text-navy-500 focus:outline-none focus:ring-2 focus:ring-sky-400/40"
            />

            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-navy-500">
                    <th className="pb-2 pr-2 font-medium">Player</th>
                    <th className="pb-2 pr-2 font-medium">{sortColumnLabel}</th>
                    {Array.from({ length: 6 }, (_, i) => (
                      <th key={i} className="px-1 pb-2 text-center font-medium">
                        GW{planningGameweek + i}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredPool.slice(0, 50).map((p) => {
                    const isLegal = legalPoolIds.has(p.game_player_id);
                    const rowClickable = selectedPlayer && isLegal && !isTransferPending;
                    return (
                      <tr
                        key={p.game_player_id}
                        onClick={() => rowClickable && handleTransfer(p.game_player_id)}
                        className={`border-t border-navy-800 ${
                          selectedPlayer ? (isLegal ? "cursor-pointer bg-emerald-950/20 hover:bg-emerald-900/30" : "opacity-30") : ""
                        }`}
                      >
                        <td className="py-1.5 pr-2">
                          <div className="font-medium text-white">{p.full_name}</div>
                          <div className="text-[10px] text-navy-500">
                            {p.team_name} · {p.position} · £{p.price.toFixed(1)}m
                          </div>
                        </td>
                        <td className="py-1.5 pr-2 text-sky-400">
                          {sortBy === "pts" ? (p.score != null ? p.score.toFixed(1) : "-") : sortValue(p, sortBy).toFixed(2)}
                        </td>
                        {p.fixtures.slice(0, 6).map((f, i) => (
                          <td key={i} className="px-1 py-1.5 text-center">
                            {f ? (
                              <span className={`inline-block rounded px-1 py-0.5 text-[9px] font-bold text-white ${difficultyColor(f.difficulty)}`}>
                                {f.isHome ? f.opponentAbbr : f.opponentAbbr.toLowerCase()}
                              </span>
                            ) : (
                              <span className="text-navy-700">-</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredPool.length > 50 && (
                <p className="mt-2 text-center text-[10px] text-navy-500">Showing top 50 of {filteredPool.length} - narrow your search to see more.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-navy-700 bg-navy-900 p-3">
      <p className="text-[10px] font-medium uppercase tracking-wide text-navy-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}
