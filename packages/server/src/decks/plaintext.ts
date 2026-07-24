/**
 * Plaintext decklist parser (brief §8.1 fallback). Accepts the common `1 Sol Ring` line format
 * plus section headers so a commander (and optional companion) can be designated:
 *
 *   Commander
 *   1 Atraxa, Praetors' Voice
 *
 *   Deck
 *   1 Sol Ring
 *   ...
 *
 *   Companion
 *   1 Lutri, the Spellchaser
 *
 * Also tolerates `1x Name`, inline `Commander: Name`, `#`/`//` comments, and trailing set/foil
 * annotations (`1 Sol Ring (C21) 250 *F*`) that paste exports add. Parsing does not validate —
 * that is §8.3's job — it only structures the list.
 */

import type { ParsedDeck, ParsedDeckEntry } from '@mtg/shared';

type Section = 'deck' | 'commander' | 'companion' | 'sideboard';

const SECTION_HEADERS: Record<string, Section> = {
  commander: 'commander',
  commanders: 'commander',
  companion: 'companion',
  deck: 'deck',
  mainboard: 'deck',
  maindeck: 'deck',
  main: 'deck',
  sideboard: 'sideboard',
};

/**
 * Strip trailing set/collector/foil annotations a paste export appends, e.g.
 * `Sol Ring (C21) 250 *F*` → `Sol Ring`. Everything from a `(SET)` code (or `[SET]`, or a bare
 * `*F*` foil marker) to end of line is dropped.
 */
function stripAnnotations(name: string): string {
  return name
    .replace(/\s+\([A-Za-z0-9]{2,6}\).*$/, '')
    .replace(/\s+\[[^\]]*\].*$/, '')
    .replace(/\s+\*[A-Za-z]\*\s*$/, '')
    .trim();
}

/** Parse a single card line into `(quantity, name)`, or `null` if it isn't a card line. */
function parseCardLine(line: string): ParsedDeckEntry | null {
  const match = /^(\d+)\s*[xX]?\s+(.+)$/.exec(line);
  if (match) {
    const quantity = Number.parseInt(match[1] ?? '1', 10);
    const name = stripAnnotations(match[2] ?? '');
    return name ? { quantity, name } : null;
  }
  // A bare name with no leading quantity is treated as a single copy.
  const name = stripAnnotations(line);
  return name ? { quantity: 1, name } : null;
}

export function parsePlaintextDeck(
  text: string,
  meta: { sourceUrl?: string | null; name?: string | null; archetypeTag?: string | null } = {},
): ParsedDeck {
  const commanderNames: string[] = [];
  const cardMap = new Map<string, number>(); // name → merged quantity
  let companionName: string | null = null;
  let section: Section = 'deck';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;

    // Inline designation: "Commander: Atraxa, Praetors' Voice"
    const inline = /^(commander|companion)\s*:\s*(.+)$/i.exec(line);
    if (inline) {
      const kind = (inline[1] ?? '').toLowerCase();
      const entry = parseCardLine(inline[2] ?? '');
      if (entry) {
        if (kind === 'commander') commanderNames.push(entry.name);
        else companionName = entry.name;
      }
      continue;
    }

    // Section header line, e.g. "Commander", "Deck", "Sideboard (1)".
    const header = /^([A-Za-z ]+?)\s*(?:\(\d+\))?\s*:?\s*$/.exec(line);
    if (header) {
      const key = (header[1] ?? '').trim().toLowerCase();
      const mapped = SECTION_HEADERS[key];
      if (mapped) {
        section = mapped;
        continue;
      }
    }

    const entry = parseCardLine(line);
    if (!entry) continue;
    if (section === 'commander') {
      for (let i = 0; i < entry.quantity; i++) commanderNames.push(entry.name);
    } else if (section === 'companion') {
      companionName = entry.name;
    } else if (section === 'sideboard') {
      // Ignore sideboard cards; Commander has no sideboard beyond an explicit companion.
    } else {
      cardMap.set(entry.name, (cardMap.get(entry.name) ?? 0) + entry.quantity);
    }
  }

  const cards: ParsedDeckEntry[] = [...cardMap].map(([name, quantity]) => ({ name, quantity }));
  return {
    sourceType: 'plaintext',
    sourceUrl: meta.sourceUrl ?? null,
    name: meta.name ?? null,
    commanderNames,
    companionName,
    cards,
    archetypeTag: meta.archetypeTag ?? null,
  };
}
