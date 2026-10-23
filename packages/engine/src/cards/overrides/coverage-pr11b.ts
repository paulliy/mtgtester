/** PR11b authored layout cards: MDFC spell faces, transform, Class, Sagas, split cards, prepare, Rooms. */
import { allOf, ofType, SELF } from '../selector';
import {
  activated,
  mana,
  onChapter,
  onDies,
  spell,
  TAP,
  targetSlots,
  triggered,
} from '../templates';
import { CONSTRUCT_0_0_ARTIFACT_COUNT, INKLING_2_1_FLYING } from '../tokens';
import { constant } from '../value';
import { extendCard, replaceCard } from './index';

export function registerCoveragePr11bOverrides(): void {
  registerPr11bModalSpellFaces();
  registerPr11bTransform();
  registerPr11bClass();
  registerPr11bSagas();
}

/** PR11.02, .04: spell // land modal DFCs whose land backs were already authored. */
function registerPr11bModalSpellFaces(): void {
  // PR11.02: the life loss and the grant both need the target to be legal on resolution (CR
  // 608.2b). The granted trigger belongs to that creature object only, so a creature it returned
  // that dies again the same turn stays in the graveyard (CR 400.7).
  const rebirth = targetSlots({ creature: { kind: 'creature' } });
  replaceCard(
    'a731e87b-8d99-4b64-8ee3-8e540d652366',
    'Malakir Rebirth // Malakir Mire',
    [
      'Choose target creature. You lose 2 life. Until end of turn, that creature gains "When this creature dies, return it to the battlefield tapped under its owner\'s control."',
    ],
    {
      spellAbility: spell({
        targets: rebirth.targets,
        effects: [
          { op: 'loseLife', amount: constant(2) },
          {
            op: 'grantAbilityUntilEot',
            target: rebirth.slot.creature,
            ability: triggered(onDies(), {
              effects: [{ op: 'returnDiedSourceToBattlefield', tapped: true }],
              description:
                "When this creature dies, return it to the battlefield tapped under its owner's control",
            }),
          },
        ],
        description:
          'Choose target creature. You lose 2 life. Until end of turn, it gains "When this creature dies, return it to the battlefield tapped"',
      }),
    },
    'PR11b authors the Malakir Rebirth spell face beside the existing Malakir Mire land face.',
  );

  // PR11.04: any number includes none; the draw counts the cards actually put on the bottom.
  replaceCard(
    'ff0ab867-b710-4b1a-baed-95fc3cf68f79',
    'Valakut Awakening // Valakut Stoneforge',
    [
      'Put any number of cards from your hand on the bottom of your library, then draw that many cards plus one.',
    ],
    {
      spellAbility: spell({
        effects: [{ op: 'putAnyFromHandOnBottomThenDraw', extra: 1 }],
        description:
          'Put any number of cards from your hand on the bottom of your library, then draw that many plus one',
      }),
    },
    'PR11b authors the Valakut Awakening spell face beside the existing Valakut Stoneforge land face.',
  );
}

/** PR11.23: a transforming DFC whose front face flips on a three-creature attack. */
function registerPr11bTransform(): void {
  // PR11.23: the attack count is part of the event (CR 508.2a, 603.2), not an intervening if.
  // Adanto, the First Fort's mana and token abilities are read from the interpreted back face,
  // and a doubled trigger turns the card over once (CR 701.27f).
  extendCard(
    'f7d8b91b-6541-4d3e-af51-7e000eac69c1',
    "Legion's Landing // Adanto, the First Fort",
    ['When you attack with three or more creatures, transform ~.'],
    {
      triggers: [
        triggered(
          { when: 'attackDeclared', attacker: 'you', minAttackers: 3 },
          {
            effects: [{ op: 'transformSelf' }],
            description: "When you attack with three or more creatures, transform Legion's Landing",
          },
        ),
      ],
    },
  );
}

/** PR11.14: a Class whose levels are gained in order at sorcery speed (CR 716). */
function registerPr11bClass(): void {
  // PR11.14: level 2's trigger only exists from level 2 on, and "for the first time each turn"
  // is part of the life-loss event, so a Class that levels up after its controller has already
  // lost life that turn waits for the next turn. Level 3's end-step check is an intervening if
  // over a modified creature (CR 700.9) that died while its controller was this Class's.
  const levelUp = (cost: string, level: number) => ({
    ...activated({
      costs: [mana(cost)],
      timing: 'sorcery',
      effects: [{ op: 'gainClassLevel', level }],
      description: `${cost}: Gain Class level ${level}`,
    }),
    condition: { kind: 'sourceClassLevel', cmp: '==', n: level - 1 } as const,
  });
  const grown = targetSlots({ creature: { kind: 'creature', controller: 'you' } });
  replaceCard(
    '6c948f71-5c86-450c-8828-df4d8deaf1dd',
    'Intermediate Chirography',
    [
      'unsupported layout "class"',
      'unrecognized rules text: "When this Class enters, create a 2/1 white and black Inkling creature token with flying."',
      'unrecognized rules text: "{1}{B}: Level 2"',
      'unrecognized rules text: "Whenever you lose life for the first time each turn, put a +1/+1 counter on target creature you control."',
      'unrecognized rules text: "{2}{B}: Level 3"',
      'unrecognized rules text: "At the beginning of each end step, if a modified creature died under your control this turn, create a 2/1 white and black Inkling creature token with flying."',
    ],
    {
      triggers: [
        triggered(
          { when: 'enters', subject: { kind: 'self' } },
          {
            effects: [{ op: 'createToken', spec: INKLING_2_1_FLYING, count: constant(1) }],
            description: 'When this Class enters, create a 2/1 white and black Inkling with flying',
          },
        ),
      ],
      activatedAbilities: [levelUp('{1}{B}', 2), levelUp('{2}{B}', 3)],
      staticEffects: [
        {
          affects: SELF,
          condition: { kind: 'sourceClassLevel', cmp: '>=', n: 2 },
          op: {
            layer: 6,
            addTrigger: triggered(
              { when: 'losesLife', player: 'you', firstTimeEachTurn: true },
              {
                targets: grown.targets,
                effects: [
                  {
                    op: 'putCounters',
                    target: grown.slot.creature,
                    counter: '+1/+1',
                    count: constant(1),
                  },
                ],
                description:
                  'Whenever you lose life for the first time each turn, put a +1/+1 counter on target creature you control',
              },
            ),
          },
        },
        {
          affects: SELF,
          condition: { kind: 'sourceClassLevel', cmp: '>=', n: 3 },
          op: {
            layer: 6,
            addTrigger: triggered(
              { when: 'endStep', player: 'each' },
              {
                condition: { kind: 'modifiedCreatureDiedUnderYourControlThisTurn' },
                effects: [{ op: 'createToken', spec: INKLING_2_1_FLYING, count: constant(1) }],
                description:
                  'At the beginning of each end step, if a modified creature died under your control this turn, create a 2/1 white and black Inkling with flying',
              },
            ),
          },
        },
      ],
    },
    'PR11b implements the Class levels, the first-life-loss trigger and the modified-death check.',
  );
}

/** PR11.13, .21: Sagas — a lore counter as each enters and at each precombat main (CR 714). */
function registerPr11bSagas(): void {
  // PR11.13: the chapter III targets are chosen as the trigger goes on the stack, with the total
  // mana value budget checked then and again on resolution (CR 601.2c, 608.2b). The returned
  // creatures enter as artifacts with their counter, and stay artifacts while they remain.
  const returned = targetSlots({
    creatures: {
      kind: 'cardInGraveyard',
      filter: ofType('Creature'),
      count: { min: 0, max: 3 },
      totalManaValueAtMost: 8,
    },
  });
  replaceCard(
    '5924cbb0-19b5-449c-a7c5-722e744a54f8',
    'The War in Heaven',
    [
      'unsupported layout "saga"',
      'I — You draw three cards and you lose 3 life.',
      'II — Mill three cards.',
      "III — Choose up to three target creature cards with total mana value 8 or less in your graveyard. Return each of them to the battlefield with a necrodermis counter on it. They're artifacts in addition to their other types.",
    ],
    {
      triggers: [
        triggered(onChapter(1), {
          effects: [
            { op: 'draw', count: constant(3) },
            { op: 'loseLife', amount: constant(3) },
          ],
          description: 'I — You draw three cards and you lose 3 life',
        }),
        triggered(onChapter(2), {
          effects: [{ op: 'mill', count: constant(3) }],
          description: 'II — Mill three cards',
        }),
        triggered(onChapter(3), {
          targets: returned.targets,
          effects: [
            {
              op: 'reanimateEachChosen',
              targetSlot: returned.slot.creatures,
              counter: 'necrodermis',
              addTypes: ['Artifact'],
            },
          ],
          description:
            'III — Return up to three target creature cards with total mana value 8 or less from your graveyard to the battlefield with a necrodermis counter, as artifacts',
        }),
      ],
    },
    'PR11b implements Saga chapters, so the chapter abilities trigger on lore counters.',
  );

  // PR11.21: each "gains" lasts for as long as the Saga stays this object (CR 611.2c), so it
  // keeps both abilities until chapter III resolves and it is sacrificed (CR 714.4). Chapter III
  // reads the printed mana cost, so an {X} artifact or one without a mana cost is not found.
  replaceCard(
    '4c6a0c30-b547-4eff-8ff4-0ca25803c076',
    "Urza's Saga",
    [
      'unsupported layout "saga"',
      'unrecognized rules text: "I — ~ gains "{T}: Add {C}.""',
      'unrecognized rules text: "II — ~ gains "{2}, {T}: Create a 0/0 colorless Construct artifact creature token with \'~ gets +1/+1 for each artifact you control.\'""',
      'unrecognized rules text: "III — Search your library for an artifact card with mana cost {0} or {1}, put it onto the battlefield, then shuffle."',
    ],
    {
      triggers: [
        triggered(onChapter(1), {
          effects: [{ op: 'sourceGainsAbility', manaAbility: { units: [['C']] } }],
          description: 'I — This Saga gains "{T}: Add {C}"',
        }),
        triggered(onChapter(2), {
          effects: [
            {
              op: 'sourceGainsAbility',
              activatedAbility: activated({
                costs: [mana('{2}'), TAP],
                effects: [
                  { op: 'createToken', spec: CONSTRUCT_0_0_ARTIFACT_COUNT, count: constant(1) },
                ],
                description:
                  '{2}, {T}: Create a 0/0 Construct artifact token with "This creature gets +1/+1 for each artifact you control"',
              }),
            },
          ],
          description:
            'II — This Saga gains "{2}, {T}: Create a 0/0 colorless Construct artifact creature token"',
        }),
        triggered(onChapter(3), {
          effects: [
            {
              op: 'searchLibrary',
              filter: allOf(ofType('Artifact'), { kind: 'manaCostIs', manaCosts: ['{0}', '{1}'] }),
              destinations: [{ zone: 'battlefield' }],
            },
            { op: 'shuffle' },
          ],
          description:
            'III — Search your library for an artifact card with mana cost {0} or {1}, put it onto the battlefield, then shuffle',
        }),
      ],
    },
    "PR11b implements Saga chapters and the abilities Urza's Saga gains.",
  );
}
