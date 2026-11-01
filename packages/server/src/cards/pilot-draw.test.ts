import { describe, expect, it } from 'vitest';
import type { RawScryfallCard } from './scryfall';
import { drawPilot, PILOT_SIZE } from '../../../../scripts/cards/pilot-draw';

type Raw = RawScryfallCard & { edhrec_rank?: number };

const raw = (name: string, rank: number | undefined, overrides: Partial<Raw> = {}): Raw => ({
  id: `00000000-0000-0000-0000-${String(rank ?? 0).padStart(12, '0')}`,
  oracle_id: `oracle-${name}`,
  name,
  layout: 'normal',
  mana_cost: '{2}{U}',
  type_line: 'Sorcery',
  // Text the interpreter cannot read, so the card is unmodeled.
  oracle_text: 'Each player chooses a number in secret, then reveals it.',
  colors: ['U'],
  color_identity: ['U'],
  keywords: [],
  legalities: { commander: 'legal' },
  ...(rank === undefined ? {} : { edhrec_rank: rank }),
  ...overrides,
});

describe('phase 6 pilot draw', () => {
  const bank: Raw[] = [
    ...Array.from({ length: 30 }, (_, index) => raw(`Unmodeled ${index}`, 100 + index)),
    raw('Modeled Bolt', 1, {
      mana_cost: '{R}',
      type_line: 'Instant',
      oracle_text: 'Modeled Bolt deals 3 damage to any target.',
    }),
    raw('Pinned Card', 2),
    raw('Banned Card', 3, { legalities: { commander: 'banned' } }),
    raw('Unranked Card', undefined),
    raw('Adventure Card', 4, { layout: 'adventure' }),
  ];
  const cards = drawPilot(bank, new Set(['Pinned Card']));

  it('draws the best-ranked unmodeled, unpinned, commander-legal cards outside adventures', () => {
    expect(cards.map((card) => card.name)).toEqual(
      Array.from({ length: PILOT_SIZE }, (_, index) => `Unmodeled ${index}`),
    );
    expect(cards.every((card) => card.reasons.length > 0)).toBe(true);
  });

  it('splits them ten and ten by the seed, the same way every time', () => {
    expect(cards.filter((card) => card.arm === 'new')).toHaveLength(PILOT_SIZE / 2);
    expect(drawPilot(bank, new Set(['Pinned Card']))).toEqual(cards);
    const other = drawPilot(bank, new Set(['Pinned Card']), 'another seed');
    expect(other.map((card) => card.arm)).not.toEqual(cards.map((card) => card.arm));
  });
});
