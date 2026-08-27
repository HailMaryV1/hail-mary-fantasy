import { redirect } from "next/navigation";

// Bare game root redirect (2026-08-27 site-wide rating consolidation) -
// see dreamteam/page.tsx's own comment for the full rationale.
export default function EFLFantasyRootPage() {
  redirect("/ratings?game=eflfantasy");
}
