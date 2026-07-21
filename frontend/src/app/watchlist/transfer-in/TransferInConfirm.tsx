"use client";

import { useState, useTransition } from "react";
import { makeTransfer } from "../../squads/actions";

export default function TransferInConfirm({
  squadId,
  outGamePlayerId,
  inGamePlayerId,
}: {
  squadId: number;
  outGamePlayerId: number;
  inGamePlayerId: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleConfirm() {
    setError(null);
    startTransition(async () => {
      const result = await makeTransfer({ squadId, outGamePlayerId, inGamePlayerId });
      if (result?.error) setError(result.error);
      // On success makeTransfer redirects to /squads/{squadId}.
    });
  }

  return (
    <div>
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      <button
        onClick={handleConfirm}
        disabled={isPending}
        className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-navy-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {isPending ? "Confirming..." : "Confirm Transfer"}
      </button>
    </div>
  );
}
