"use client";

import { useState, useTransition } from "react";
import { setCaptain } from "../actions";

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
        <div className="mb-4 rounded-xl border border-emerald-800 bg-emerald-950/30 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-emerald-400">Recommended</p>
          <p className="mt-1 text-sm text-white">
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

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <button
        onClick={handleSave}
        disabled={!captainId || !viceId || isPending}
        className="mb-4 rounded-lg bg-sky-500 px-4 py-1.5 text-sm font-medium text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? "Saving..." : "Save captain"}
      </button>

      <div className="overflow-x-auto rounded-xl border border-navy-700 bg-navy-900">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-navy-700 text-xs uppercase tracking-wide text-navy-400">
              <th className="px-4 py-2 font-medium">Player</th>
              <th className="px-4 py-2 text-right font-medium">Score</th>
              <th className="px-4 py-2 text-center font-medium">Captain</th>
              <th className="px-4 py-2 text-center font-medium">Vice</th>
            </tr>
          </thead>
          <tbody>
            {starters.map((s) => (
              <tr key={s.game_player_id} className="border-b border-navy-800 last:border-0">
                <td className="px-4 py-2 text-white">
                  {s.full_name} <span className="text-navy-400">({s.team_name}, {s.position})</span>
                </td>
                <td className="px-4 py-2 text-right text-navy-300">{s.hail_mary_score.toFixed(1)}</td>
                <td className="px-4 py-2 text-center">
                  <input
                    type="radio"
                    name="captain"
                    checked={captainId === s.game_player_id}
                    onChange={() => {
                      setCaptainId(s.game_player_id);
                      if (viceId === s.game_player_id) setViceId(null);
                    }}
                    className="accent-sky-500"
                  />
                </td>
                <td className="px-4 py-2 text-center">
                  <input
                    type="radio"
                    name="vice"
                    checked={viceId === s.game_player_id}
                    disabled={captainId === s.game_player_id}
                    onChange={() => setViceId(s.game_player_id)}
                    className="accent-sky-500"
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
