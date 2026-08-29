/**
 * GET /api/fouls/board?fixtureId=123
 *
 * Fouls Committed, Tackles and confirmed lineups for one fixture (our own
 * fixtures.id, not a SportMonks id), shaped for the /fouls page. Returns 200
 * even when markets are not posted yet or lineups have not landed - `notes`,
 * `hasFoulsMarkets`/`hasTacklesMarkets` and `lineupsConfirmed` say what is
 * missing, because "not published yet" is a normal state for this market
 * rather than an error.
 */

import { NextResponse } from "next/server";
import { fetchLiveBoard } from "@/lib/spreadexFouls";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fixtureId = parseInt(searchParams.get("fixtureId") ?? "", 10);
  if (!isFinite(fixtureId)) {
    return NextResponse.json({ error: "fixtureId is required" }, { status: 400 });
  }

  try {
    const result = await fetchLiveBoard(fixtureId);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
