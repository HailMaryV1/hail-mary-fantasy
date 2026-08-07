// Real branded icon tiles (user-generated, see frontend-v2/public/game-icons/)
// for the 6 live fantasy_games rows. Keyed by slug exactly as stored in the
// fantasy_games table. Falls back to a plain text tile for any future game
// added before its icon exists.
export const GAME_ICONS: Record<string, string> = {
  dreamteam: "/game-icons/dreamteam.jpg",
  fanteam: "/game-icons/fanteam.jpg",
  "nfl-fanteam": "/game-icons/nfl-fanteam.jpg",
  "fanteam-golf": "/game-icons/fanteam-golf.jpg",
  cloudff: "/game-icons/cloudff.jpg",
  eflfantasy: "/game-icons/eflfantasy.jpg",
};

export function getGameIcon(slug: string): string | null {
  return GAME_ICONS[slug] ?? null;
}
