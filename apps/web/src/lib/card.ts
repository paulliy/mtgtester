/** Scryfall type lines for tokens/emblems always contain "Token" (e.g. "Token Creature — Goblin"). */
export function isTokenTypeLine(typeLine: string): boolean {
  return typeLine.includes('Token');
}
