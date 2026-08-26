"use client";

import { useState } from "react";
import { formatRating } from "@/lib/hailMaryRating";
import { formatFixtureShort } from "@/lib/fixtureFormat";
import Kit from "@/components/Kit";
import PlayerInfoPanel from "@/components/PlayerInfoPanel";

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

function TargetScoreRowItem({
  row,
  rank,
  horizon,
  onOpen,
}: {
  row: TargetScoreRow;
  rank: number;
  horizon: number;
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
        <span className="shrink-0 text-xs font-bold text-sky-300">{headline}/10</span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-1.5 pl-6">
        <span className="truncate text-[10px] text-navy-500">
          {formatFixtureShort(row.opponent_team_name, row.fixture_is_home, row.fixture_kickoff_at)}
          {horizon > 1 && row.end_gameweek != null && ` · thru GW${row.end_gameweek}`}
        </span>
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
  viewedGameweek,
  horizon,
}: {
  columns: { code: string; label: string }[];
  byPosition: Map<string, TargetScoreRow[]>;
  gameSlug: string;
  viewedGameweek: number;
  horizon: number;
}) {
  const [infoPlayerId, setInfoPlayerId] = useState<number | null>(null);

  if (infoPlayerId != null) {
    return (
      <PlayerInfoPanel
        gameSlug={gameSlug}
        gamePlayerId={infoPlayerId}
        viewedGameweek={viewedGameweek}
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
                  <TargetScoreRowItem key={r.game_player_id} row={r} rank={i + 1} horizon={horizon} onOpen={setInfoPlayerId} />
                ))}
              </ol>
            )}
          </div>
        );
      })}
    </div>
  );
}
