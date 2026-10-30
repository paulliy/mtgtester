/** Oracle facet warnings (ADR 0034 decision 6). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CardDefinition } from '../src/cards/definition';
import { facetMismatches, facetText, irFacets, textFacets } from '../src/cards/facets';
import { oracle } from './fixtures';
import { pinStore } from './scenario/pin-store';

interface Regression {
  name: string;
  facet: string;
  before: CardDefinition;
  after: CardDefinition;
}

const regressions = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/facet-regressions.json'), 'utf8'),
  ) as { cards: Regression[] }
).cards;

describe('Oracle facets', () => {
  it.each(regressions.map((card) => [card.name, card] as const))(
    '%s: the definition before 5c8e41f warns on its facet, and the fix does not',
    (_name, card) => {
      const pinned = pinStore.get(card.name);
      expect(facetMismatches(pinned, card.before).map((mismatch) => mismatch.facet)).toEqual([
        card.facet,
      ]);
      expect(facetMismatches(pinned, card.after)).toEqual([]);
    },
  );

  it('reads the text as handledLines does: no reminder text, the name as ~', () => {
    const card = oracle({
      name: 'Kambal, Probe',
      typeLine: 'Legendary Creature',
      oracleText:
        'Whenever Kambal or another creature you control dies, target opponent loses 1 life. (Another reminder.)\nThis creature gets +1/+1 until end of turn.',
    });
    expect(facetText(card)).toBe(
      'Whenever ~ or another creature you control dies, target opponent loses 1 life. \n~ gets +1/+1 until end of turn.',
    );
    expect(textFacets(card)).toEqual({
      other: 0,
      interveningIf: 0,
      untilEndOfTurn: 1,
      optional: 0,
      targetCount: 1,
    });
  });

  it('counts each facet in the text, and not the words that only look like one', () => {
    const counts = (oracleText: string) =>
      textFacets(oracle({ name: 'Probe', typeLine: 'Creature', oracleText }));
    expect(
      counts('Whenever another creature enters, if you control an Island, you may draw a card.'),
    ).toMatchObject({ other: 1, interveningIf: 1, optional: 1 });
    expect(
      counts(
        'It is an artifact in addition to its other types. You may choose new targets for the copy. You may cast spells from the top. You may pay {2}.',
      ),
    ).toMatchObject({ other: 0, optional: 0 });
    expect(counts('Change the target of target spell with a single target.').targetCount).toBe(1);
    expect(counts('Enchant creature\nEnchanted creature gets +1/+1.').targetCount).toBe(1);
  });

  it('counts each facet in the IR, wherever it sits', () => {
    expect(
      irFacets({
        triggers: [
          {
            kind: 'triggered',
            optional: true,
            trigger: { condition: {}, subject: { selector: { kind: 'other' } } },
            targets: [{ kind: 'creature' }],
            effects: [
              { op: 'pumpUntilEot' },
              { op: 'gainControlTarget', duration: 'untilEndOfTurn' },
              { op: 'mayDiscardThenDraw' },
              { op: 'searchLibrary', filter: { kind: 'type', value: 'Land' } },
            ],
          },
        ],
        ruleStatics: [{ kind: 'triggerAdditionalForShamanOrOtherWizard' }],
      } as unknown as CardDefinition),
    ).toEqual({ other: 2, interveningIf: 1, untilEndOfTurn: 2, optional: 3, targetCount: 1 });
  });
});
