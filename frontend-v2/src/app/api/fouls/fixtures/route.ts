/**
 * GET /api/fouls/fixtures?days=7
 *
 * Upcoming fixtures in the leagues the Spreadex scraper covers, for the
 * fixture picker on /fouls.
 */

import { NextResponse } from "next/server";
import { listFixtures } from "@/lib/spreadexFouls";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const days = Math.min(Math.max(parseInt(searchParams.get("days") ?? "7", 10) || 7, 1), 21);

  const from = new Date();
  const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);

  try {
    const fixtures = await listFixtures(iso(from), iso(to));
    return NextResponse.json({ fixtures });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message, fixtures: [] }, { status: 502 });
  }
}
