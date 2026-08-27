import { redirect } from "next/navigation";

// Bare game root redirect (2026-08-27 site-wide rating consolidation) -
// the squad board that used to live at this exact route is deleted, but
// bookmarks/typed URLs/browser history still point straight here rather
// than through /games/dreamteam (whose own redirect this mirrors) - a
// real user report caught this 404ing in production. Every game gets
// its own copy rather than a shared redirect component, matching this
// app's own "never a shared branch on game slug" convention.
export default function DreamTeamRootPage() {
  redirect("/ratings?game=dreamteam");
}
