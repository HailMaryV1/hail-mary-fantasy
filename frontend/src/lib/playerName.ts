/**
 * "Bruno Fernandes" -> "B.Fernandes" - fits inside the narrow fixed-width
 * pitch chips/pool rows without truncating mid-surname. Mononyms
 * (Rodri, Gabriel, ...) are returned unchanged - there's no first name
 * to shorten.
 */
export function shortenPlayerName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length < 2) return fullName;
  const first = parts[0];
  const last = parts[parts.length - 1];
  if (!first || !last) return fullName;
  return `${first[0]}.${last}`;
}
