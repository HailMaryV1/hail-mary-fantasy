/**
 * "Bruno Fernandes" -> "B.Fernandes" - fits inside narrow fixed-width pitch
 * chips/pool rows. Mononyms are returned unchanged.
 */
export function shortenPlayerName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return fullName;
  return `${first[0]}.${last}`;
}
