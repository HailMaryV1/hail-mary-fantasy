"use client";

import { useState, useTransition } from "react";
import { saveTeamForGameweek } from "../actions";

/**
 * Cloud FF's equivalent of LineupBuilder's "Save Team" button - games
 * with no bench (squad_size === starting_size) never edit a starting XI
 * separately from the squad itself, so there's nothing to build a full
 * LineupBuilder-style picker for. This just locks the squad's current,
 * already-legal composition in as the official submission for the next
 * gameweek, archiving Mary's current recommendation the same way
 * LineupBuilder's Save Team does (see squads/actions.ts's
 * saveTeamForGameweek) - without this, Cloud FF predictions would never
 * get recorded at all, since this game has no other lineup-locking action.
 */
export default function SaveTeamButton({
  squadId,
  formationCode,
  startingGamePlayerIds,
}: {
  squadId: number;
  formationCode: string | null;
  startingGamePlayerIds: number[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSaveTeam() {
    setError(null);
    if (!formationCode) {
      setError("Couldn't determine this squad's formation - can't lock it in.");
      return;
    }
    startTransition(async () => {
      const result = await saveTeamForGameweek({ squadId, formationCode, startingGamePlayerIds });
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        onClick={handleSaveTeam}
        disabled={!formationCode || isPending}
        title="Press once you've locked this team in on the real Cloud FF site - archives Mary's current recommendation so Performance Lab can grade it against what actually happened."
        className="w-fit rounded-lg border border-emerald-700 bg-emerald-950 px-4 py-1.5 text-sm font-medium text-emerald-400 transition-colors hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? "Saving..." : "Save Team"}
      </button>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
