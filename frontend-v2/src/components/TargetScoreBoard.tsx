"use client";

import { useState } from "react";
import { formatRating } from "@/lib/hailMaryRating";
import Kit from "@/components/Kit";
import PlayerInfoPanel from "@/components/PlayerInfoPanel";

type WindowFixture = { opponent_team_name: string | null; is_home: boolean; kickoff_at: string | null };

export type TargetScoreRow = {
  position: string;
  rnk: number;
  game_player_id: number;
  full_name: string;
  team_id: number;
  team_name: string;
  hail_mary_rating: number | null;
  target_score: number | null;
  form_rating: number | null;
  fixture_difficulty_rating: number | null;
  fixture_quantity_rating: number | null;
  live_odds_rating: number | null;
  end_gameweek: number | null;
  opponent_team_name: string | null;
  fixture_is_home: boolean | null;
  fixture_kickoff_at: string | null;
  window_fixtures: WindowFixture[] | null;
  last_gw: number | null;
  last_gw_points: number | null;
};

// "When its ranking them i dont want 9/10 Nailed on - it means
// nothing.. I want a breakdown" (2026-08-23 user request) - replaces
// the old tier pill + basis pill with the 4 real sub-ratings that
// actually explain the number, blank (never "0") wherever that signal
// genuinely doesn't exist for this player.
function SubStat({ label, title, value }: { label: string; title: string; value: number | null }) {
  return (
    <span title={title} className={`inline-flex items-baseline gap-0.5 ${value == null ? "text-navy-700" : "text-navy-300"}`}>
      <span className="text-[9px] font-semibold uppercase text-navy-600">{label}</span>
      <span className="text-[10px] font-bold">{value ?? "—"}</span>
    </span>
  );
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

// "it should show the next fixtures that occur during those gameweeks
// selected" (2026-08-26 user request) - every real fixture in the
// window, not just the nearest one. A 1-gameweek window naturally has
// just one entry, so this looks identical to the old single-fixture
// display there - no special-casing needed.
function WindowFixtures({ fixtures }: { fixtures: WindowFixture[] | null }) {
  if (!fixtures || fixtures.length === 0) return <span className="truncate text-[10px] text-navy-600">No fixture in this window.</span>;
  return (
    <span className="truncate text-[10px] text-navy-500">
      {fixtures.map((f, i) => (
        <span key={i}>
          {i > 0 && ", "}
          {f.is_home ? "vs" : "at"} {f.opponent_team_name ?? "TBC"}
          {f.kickoff_at ? ` (${shortDate(f.kickoff_at)})` : ""}
        </span>
      ))}
    </span>
  );
}

function TargetScoreRowItem({
  row,
  rank,
  horizon,
  isLive,
  liveGameweek,
  onOpen,
}: {
  row: TargetScoreRow;
  rank: number;
  horizon: number;
  isLive: boolean;
  liveGameweek: number | null;
  onOpen: (gamePlayerId: number) => void;
}) {
  // CLUB rows' full_name is the synthetic "<Team> Team" pick label (EFL
  // Fantasy's club-pick naming, migration 0087) - team_name ("Millwall")
  // is the real display name everywhere else this shows up.
  const displayName = row.position === "CLUB" ? row.team_name : row.full_name;
  // Design decision (see plan): horizon=1 keeps the EXISTING Hail Mary
  // Rating as the headline number (it's also what actually drove this
  // row's rank at horizon=1) - target_score only becomes the headline
  // once it's also what's doing the ranking, horizon >= 2.
  const headline = formatRating(horizon === 1 ? row.hail_mary_rating : row.target_score);
  // Live Gameweek tab: "what mary predicted... and whats actually
  // happening" - only ever shows a real actual result once this exact
  // gameweek has genuinely been graded (last_gw === liveGameweek);
  // still pending otherwise, never a stale prior gameweek's number.
  const actualPoints = isLive && row.last_gw === liveGameweek ? row.last_gw_points : undefined;

  return (
    <li className="flex flex-col gap-1 border-b border-navy-800 pb-2 last:border-b-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => onOpen(row.game_player_id)}
          className="flex min-w-0 items-center gap-2 text-left hover:opacity-80"
        >
          <span className="w-4 shrink-0 text-[10px] font-bold text-navy-500">{rank}</span>
          <Kit teamName={row.team_name} size="sm" />
          <span className="truncate text-xs font-medium text-white">{displayName}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          {isLive && (
            <span className={`text-[10px] font-semibold ${actualPoints != null ? "text-emerald-400" : "text-navy-600"}`}>
              {actualPoints != null ? `${actualPoints.toFixed(1)} pts` : "pending"}
            </span>
          )}
          <span className="text-xs font-bold text-sky-300">{headline}/10</span>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-1.5 pl-6">
        <WindowFixtures fixtures={row.window_fixtures} />
        <div className="flex shrink-0 items-center gap-2">
          <SubStat label="F" title="Form" value={row.form_rating} />
          <SubStat label="D" title="Fixture Difficulty" value={row.fixture_difficulty_rating} />
          <SubStat label="Q" title="Fixture Quantity" value={row.fixture_quantity_rating} />
          <SubStat label="O" title="Live Odds" value={row.live_odds_rating} />
        </div>
      </div>
    </li>
  );
}

export default function TargetScoreBoard({
  columns,
  byPosition,
  gameSlug,
  anchorGameweek,
  horizon,
  isLive = false,
}: {
  columns: { code: string; label: string }[];
  byPosition: Map<string, TargetScoreRow[]>;
  gameSlug: string;
  // The gameweek this view's ranking/breakdown is actually anchored to -
  // for horizon=1 this is whichever gameweek the switcher is browsing;
  // for horizon>=2 it's always the gameweek right after the live one
  // (see ratings/page.tsx); for the Live Gameweek tab it's the live
  // gameweek itself. Threaded straight into PlayerInfoPanel so the
  // detail panel and downloadable card always agree with what's shown.
  anchorGameweek: number;
  horizon: number;
  isLive?: boolean;
}) {
  const [infoPlayerId, setInfoPlayerId] = useState<number | null>(null);

  if (infoPlayerId != null) {
    return (
      <PlayerInfoPanel
        gameSlug={gameSlug}
        gamePlayerId={infoPlayerId}
        viewedGameweek={anchorGameweek}
        horizon={horizon}
        onBack={() => setInfoPlayerId(null)}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
                  <TargetScoreRowItem
                    key={r.game_player_id}
                    row={r}
                    rank={i + 1}
                    horizon={horizon}
                    isLive={isLive}
                    liveGameweek={isLive ? anchorGameweek : null}
                    onOpen={setInfoPlayerId}
                  />
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
}
