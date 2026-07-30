/**
 * Authored overrides for the remaining unmodeled cards in the Draconic Destruction precon
 * (ADR 0009 / ADR 0010, `packages/server/fixtures/coverage-decks/draconic-destruction.txt`).
 *
 * One module per deck (matching `urdragon.ts`'s intended shape) rather than one file per
 * card: these overrides share very little printed text with each other, but the deck itself
 * is the unit of "closed set" ADR 0009 describes — see that ADR for why chasing a specific
 * decklist's remaining cards is the tractable strategy, unlike chasing coverage in general.
 */

import { SELF_SUBJECT } from '../ability';
import { parseManaCost } from '../../mana/cost';
import { allOf, ofSubtype, YOURS } from '../selector';
import { constant } from '../value';
import { registerOverride } from './index';

registerOverride({
  oracleId: 'oracle-dragon-mage',
  name: 'Dragon Mage',
  handledLines: [
    'Whenever ~ deals combat damage to a player, each player discards their hand, then draws seven cards.',
  ],
  def: {
    triggers: [
      {
        kind: 'triggered',
        trigger: { when: 'dealsCombatDamageToPlayer', subject: SELF_SUBJECT },
        targets: [],
        effects: [{ op: 'eachPlayerDiscardHandThenDraw', count: constant(7) }],
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-runehorn-hellkite',
  name: 'Runehorn Hellkite',
  handledLines: [
    '{5}{R}, Exile this card from your graveyard: Each player discards their hand, then draws seven cards.',
  ],
  def: {
    activatedAbilities: [
      {
        costs: [
          { kind: 'mana', cost: parseManaCost('{5}{R}').cost! },
          { kind: 'exileSelfFromGraveyard' },
        ],
        timing: 'any',
        functionsInGraveyard: true,
        ability: {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'eachPlayerDiscardHandThenDraw', count: constant(7) }],
          description: 'each player discards their hand, then draws seven cards',
        },
      },
    ],
  },
});

registerOverride({
  oracleId: 'oracle-spit-flame',
  name: 'Spit Flame',
  handledLines: [
    'Whenever a Dragon you control enters, you may pay {R}. If you do, return this card from your graveyard to your hand.',
  ],
  def: {
    triggers: [
      {
        kind: 'triggered',
        functionsInGraveyard: true,
        trigger: {
          when: 'enters',
          subject: { kind: 'permanent', selector: allOf(ofSubtype('Dragon'), YOURS) },
        },
        targets: [],
        effects: [
          {
            op: 'conditionalEffect',
            condition: { kind: 'mayPayMana', cost: parseManaCost('{R}').cost! },
            then: [{ op: 'returnSelfFromGraveyardToHand' }],
            else: [],
          },
        ],
      },
    ],
  },
});
