import { redirect } from "next/navigation";

// Bare game root redirect (2026-08-27 site-wide rating consolidation) -
// see dreamteam/page.tsx's own comment for the full rationale. FanTeam's
// old root page was the synced-squad picker, also deleted along with the
// real-squad sync flow.
export default function FanTeamRootPage() {
  redirect("/ratings?game=fanteam");
}
