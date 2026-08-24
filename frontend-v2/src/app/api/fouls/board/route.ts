/**
 * GET /api/fouls/board?fixtureId=19722194
 *
 * Both fouls ladders and the confirmed lineups for one fixture, shaped exactly
 * as the /fouls engine wants them. Returns 200 even when the fouls markets are
 * not posted yet or the lineups have not landed - `notes`, `hasFoulsMarkets`
 * and `lineupsConfirmed` say what is missing, because "not published yet" is a
 * normal state for this market rather than an error.
 */

import { NextResponse } from "next/server";
import { fetchLiveBoard } from "@/lib/sportmonksFouls";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const fixtureId = parseInt(searchParams.get("fixtureId") ?? "", 10);
  if (!isFinite(fixtureId)) {
    return NextResponse.json({ error: "fixtureId is required" }, { status: 400 });
  }

  const bookmakerId = parseInt(searchParams.get("bookmakerId") ?? "", 10);

  try {
    const result = await fetchLiveBoard(fixtureId, {
      bookmakerId: isFinite(bookmakerId) ? bookmakerId : undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
