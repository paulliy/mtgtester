import { creatureToken } from '../tokens';
import { spell } from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

export function registerWhiteBlackControlPerchOverrides(): void {
  replaceCard(
    '295fe873-ecb5-4d5e-a73c-3af6c478afc5',
    'Perch Protection',
    [
      'unrecognized rules text: "Gift an extra turn"',
      'unrecognized rules text: "Create four 2/2 blue Bird creature tokens with flying. If the gift was promised, all permanents you control phase out, and until your next turn, your life total can\'t change and you gain protection from everything."',
    ],
    {
      gift: 'extraTurn',
      spellAbility: spell({
        effects: [
          {
            op: 'createToken',
            count: constant(4),
            spec: creatureToken({
              name: 'Bird',
              subtypes: ['Bird'],
              colors: ['U'],
              power: 2,
              toughness: 2,
              keywords: ['flying'],
            }),
          },
          {
            op: 'conditionalEffect',
            condition: { kind: 'giftPromised' },
            then: [{ op: 'phaseOutAndProtectControllerUntilNextTurn' }],
            else: [],
          },
          { op: 'resolvingSpellExile' },
        ],
        description:
          'Create four flying Birds; promised gift phases out your permanents and protects you until your next turn; exile this spell',
      }),
    },
    'Extra turns are inserted after the current turn in most-recent-first order. Phasing preserves object identity and attachments without zone events; player shielding expires as the next own turn begins.',
  );
}
