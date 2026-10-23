/** PR11b authored layout cards: MDFC spell faces, transform, Class, Sagas, split cards, prepare, Rooms. */
import { SELF } from '../selector';
import { activated, mana, onDies, spell, triggered } from '../templates';
import { INKLING_2_1_FLYING } from '../tokens';
import { constant } from '../value';
import { extendCard, replaceCard } from './index';

export function registerCoveragePr11bOverrides(): void {
  registerPr11bModalSpellFaces();
  registerPr11bTransform();
  registerPr11bClass();
}

/** PR11.02, .04: spell // land modal DFCs whose land backs were already authored. */
function registerPr11bModalSpellFaces(): void {
  // PR11.02: the life loss and the grant both need the target to be legal on resolution (CR
  // 608.2b). The granted trigger belongs to that creature object only, so a creature it returned
  // that dies again the same turn stays in the graveyard (CR 400.7).
  replaceCard(
    'a731e87b-8d99-4b64-8ee3-8e540d652366',
    'Malakir Rebirth // Malakir Mire',
    [
      'Choose target creature. You lose 2 life. Until end of turn, that creature gains "When this creature dies, return it to the battlefield tapped under its owner\'s control."',
    ],
    {
      spellAbility: spell({
        targets: [{ kind: 'creature' }],
        effects: [
          { op: 'loseLife', amount: constant(2) },
          {
            op: 'grantAbilityUntilEot',
            target: 0,
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
                targets: [{ kind: 'creature', controller: 'you' }],
                effects: [{ op: 'putCounters', target: 0, counter: '+1/+1', count: constant(1) }],
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
