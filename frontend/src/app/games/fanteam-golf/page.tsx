import { redirect } from "next/navigation";

// FanTeam Golf's hub is structurally different from the generic
// squad-list one every other game uses (Single Gameweek/Season Game
// framing, not a persistent season-long squad - see the golf plan's
// "single-shot, not persistent-with-transfers" section) - it gets its
// own dedicated landing page instead. Next.js resolves this static
// segment ahead of the generic games/[slug] route, so the gateway
// page itself needs no special-casing (it still just links every game
// to /games/{slug}) - this is the one redirect that makes that land
// somewhere real for golf specifically.
export default function GamesFanteamGolfRedirect() {
  redirect("/golf");
}
