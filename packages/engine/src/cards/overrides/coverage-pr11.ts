/** PR11 authored protection, phasing, layout and lifecycle cards. Review status is in the manifest. */
import { allOf, hasCounter, OPPONENTS, ofType, YOURS } from '../selector';
import { activated, mana, TAP, triggered } from '../templates';
import { constant } from '../value';
import { KNIGHT_2_2_WHITE_VIGILANCE } from '../tokens';
import { extendCard, replaceCard } from './index';

export function registerCoveragePr11Overrides(): void {
  // PR11: the creatures are fixed at resolution (CR 611.2c) and "can't have" outlasts any later
  // grant of hexproof or shroud until end of turn.
  replaceCard(
    '30ac68e6-160a-41f9-9f0f-0e0eef383150',
    'Arcane Lighthouse',
    [
      "{1}, {T}: Until end of turn, creatures your opponents control lose hexproof and shroud and can't have hexproof or shroud.",
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{1}'), TAP],
          effects: [
            {
              op: 'denyKeywordsEachUntilEot',
              selector: allOf(ofType('Creature'), OPPONENTS),
              keywords: ['hexproof', 'shroud'],
            },
          ],
          description:
            "{1}, {T}: Until end of turn, creatures your opponents control lose hexproof and shroud and can't have them",
        }),
      ],
    },
    'PR11 removes and denies hexproof and shroud instead of granting menace.',
  );

  // PR11: protection from multicolored is read by the keyword line; the dies trigger reads the
  // dying creature's last known counters (CR 603.10a).
  extendCard(
    '57d0c688-6206-4c83-9fcb-27fd29e2a9ed',
    "Basri's Lieutenant",
    [
      'unrecognized rules text: "Whenever this creature or another creature you control dies, if it had a +1/+1 counter on it, create a 2/2 white Knight creature token with vigilance."',
    ],
    {
      triggers: [
        triggered(
          {
            when: 'dies',
            subject: { kind: 'permanent', selector: allOf(ofType('Creature'), YOURS) },
          },
          {
            condition: { kind: 'triggerObjectMatches', selector: hasCounter('+1/+1') },
            effects: [{ op: 'createToken', spec: KNIGHT_2_2_WHITE_VIGILANCE, count: constant(1) }],
            description:
              'When this or another creature you control dies with a +1/+1 counter, create a 2/2 white Knight with vigilance',
          },
        ),
      ],
    },
  );

  // PR11: a static of Shanna herself; spells may still target her.
  extendCard(
    '546201d0-3fa5-44e4-a526-ab0945711e49',
    "Shanna, Sisay's Legacy",
    ['unrecognized rules text: "~ can\'t be the target of abilities your opponents control."'],
    { ruleStatics: [{ kind: 'cantBeTargetedByOpponentAbilities' }] },
  );
}
