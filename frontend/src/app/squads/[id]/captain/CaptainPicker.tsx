"use client";

import { useState, useTransition } from "react";
import { setCaptain } from "../../actions";

type Starter = {
  game_player_id: number;
  full_name: string;
  position: string;
  team_name: string;
  hail_mary_score: number;
};

export default function CaptainPicker({
  squadId,
  starters,
  currentCaptainId,
  currentViceCaptainId,
}: {
  squadId: number;
  starters: Starter[];
  currentCaptainId: number | null;
  currentViceCaptainId: number | null;
}) {
  const recommendedCaptain = starters[0];
  const recommendedVice = starters[1];

  const [captainId, setCaptainId] = useState<number | null>(currentCaptainId ?? recommendedCaptain?.game_player_id ?? null);
  const [viceId, setViceId] = useState<number | null>(currentViceCaptainId ?? recommendedVice?.game_player_id ?? null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setError(null);
    if (!captainId || !viceId) return;
    startTransition(async () => {
      const result = await setCaptain({ squadId, captainGamePlayerId: captainId, viceCaptainGamePlayerId: viceId });
      if (result?.error) setError(result.error);
    });
  }

  return (
    <div>
      {recommendedCaptain && (
        <div className="mb-4 rounded-xl border border-green-300 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950/30">
          <p className="text-xs font-medium uppercase tracking-wide text-green-700 dark:text-green-400">Recommended</p>
          <p className="mt-1 text-sm text-black dark:text-zinc-50">
            <span className="font-semibold">{recommendedCaptain.full_name}</span> ({recommendedCaptain.hail_mary_score.toFixed(1)}) as
            captain
            {recommendedVice && (
              <>
                , <span className="font-semibold">{recommendedVice.full_name}</span> ({recommendedVice.hail_mary_score.toFixed(1)}) as
                vice-captain
              </>
            )}
          </p>
        </div>
      )}

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}
      <button
        onClick={handleSave}
        disabled={!captainId || !viceId || isPending}
        className="mb-4 rounded-lg bg-black px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      >
        {isPending ? "Saving..." : "Save captain"}
      </button>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-200 text-xs uppercase tracking-wide text-zinc-500 dark:border-zinc-800">
              <th className="px-4 py-2 font-medium">Player</th>
              <th className="px-4 py-2 text-right font-medium">Score</th>
              <th className="px-4 py-2 text-center font-medium">Captain</th>
              <th className="px-4 py-2 text-center font-medium">Vice</th>
            </tr>
          </thead>
          <tbody>
            {starters.map((s) => (
              <tr key={s.game_player_id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-900">
                <td className="px-4 py-2 text-black dark:text-zinc-50">
                  {s.full_name} <span className="text-zinc-500">({s.team_name}, {s.position})</span>
                </td>
                <td className="px-4 py-2 text-right text-zinc-600 dark:text-zinc-400">{s.hail_mary_score.toFixed(1)}</td>
                <td className="px-4 py-2 text-center">
                  <input
                    type="radio"
                    name="captain"
                    checked={captainId === s.game_player_id}
                    onChange={() => {
                      setCaptainId(s.game_player_id);
                      if (viceId === s.game_player_id) setViceId(null);
                    }}
                  />
                </td>
                <td className="px-4 py-2 text-center">
                  <input
                    type="radio"
                    name="vice"
                    checked={viceId === s.game_player_id}
                    disabled={captainId === s.game_player_id}
                    onChange={() => setViceId(s.game_player_id)}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
