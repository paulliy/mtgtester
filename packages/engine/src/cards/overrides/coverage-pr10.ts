/** PR10 authored stack, copy and characteristic operations. Evidence is tracked in the manifest. */
import { countPermanents } from '../condition';
import {
  CHOSEN_SUBTYPE,
  SELF,
  allOf,
  anyOf,
  not,
  ofSubtype,
  ofSupertype,
  IS_TOKEN,
  OTHER,
  ofType,
  OPPONENTS,
  powerAtLeast,
  YOURS,
} from '../selector';
import { counterSpellTarget } from '../target-builders';
import { creatureToken } from '../tokens';
import {
  activated,
  loyaltyAbility,
  mana,
  onBeginCombat,
  onCast,
  onDrawStep,
  onEndStep,
  onEtb,
  spell,
  targetSlots,
  triggered,
} from '../templates';
import { constant } from '../value';
import { replaceCard } from './index';

/**
 * Every PR10 override, for the PR10 engine suites. `index.ts` registers each group only once its
 * cards' manifest and Card Test Lab evidence has landed.
 */
export function registerCoveragePr10Overrides(): void {
  registerPr10RetargetAndCopyOverrides();
  registerPr10CastCopyOverrides();
  registerPr10AbilityStackOverrides();
  registerPr10TriggerDoublingOverrides();
  registerPr10AnimationOverrides();
  registerPr10TokenCopyOverrides();
  registerPr10CharacteristicsOverrides();
}

/** PR10.01, 10.11, 10.06, 10.14, 10.12: retargeting and spell copies with new targets. */
export function registerPr10RetargetAndCopyOverrides(): void {
  // PR10.01: choosing new targets changes the targets of the same object; it is not a copy.
  const swat = targetSlots({ object: { kind: 'stackObject' } });
  replaceCard(
    'ae120613-97d6-4393-b39d-c3e6c076f5d6',
    'Deflecting Swat',
    ['You may choose new targets for target spell or ability.'],
    {
      spellAbility: spell({
        targets: swat.targets,
        effects: [{ op: 'chooseNewTargets', target: swat.slot.object }],
        description: 'You may choose new targets for target spell or ability',
      }),
    },
    'PR10 retargets the same stack object instead of copying it.',
  );

  // PR10.11: "change the target" must pick another legal target when one exists (CR 115.7a).
  const bend = targetSlots({ object: { kind: 'stackObject', spellHasSingleTarget: true } });
  replaceCard(
    'c20a96f7-aa5a-4c15-b8b1-806685c99b27',
    'Bolt Bend',
    [
      'This spell costs {3} less to cast if you control a creature with power 4 or greater.',
      'Change the target of target spell or ability with a single target.',
    ],
    {
      ruleStatics: [
        {
          kind: 'costReduction',
          amount: constant(3),
          selfOnly: true,
          condition: countPermanents(allOf(ofType('Creature'), powerAtLeast(4)), 'you', '>=', 1),
        },
      ],
      spellAbility: spell({
        targets: bend.targets,
        effects: [{ op: 'changeSingleTarget', target: bend.slot.object }],
        description: 'Change the target of target spell or ability with a single target',
      }),
    },
    'PR10 changes the single target of the same stack object instead of copying it.',
  );

  // PR10.06, 10.14, 10.12: a copy whose controller may choose new targets (CR 707.10c).
  const instantOrSorcery = anyOf(ofType('Instant'), ofType('Sorcery'));
  const copyOne = targetSlots({ spell: counterSpellTarget('spell', { filter: instantOrSorcery }) });
  const copyOneAbility = spell({
    targets: copyOne.targets,
    effects: [{ op: 'copyTargetSpell', target: copyOne.slot.spell, newTargets: true }],
    description: 'Copy target instant or sorcery spell. You may choose new targets for the copy',
  });
  replaceCard(
    'a1f55890-31c5-4ed4-a2cd-7a4a9f05f8ca',
    'Reverberate',
    ['Copy target instant or sorcery spell. You may choose new targets for the copy.'],
    { spellAbility: copyOneAbility },
    'PR10 lets the copy choose new targets instead of keeping the original ones.',
  );
  replaceCard(
    'f586ecb8-310c-4f40-a766-6a7ca46a254d',
    'Flare of Duplication',
    ['Copy target instant or sorcery spell. You may choose new targets for the copy.'],
    { spellAbility: copyOneAbility },
    'PR10 lets the copy choose new targets; the interpreter reads the sacrifice alternative cost.',
  );
  const copyMany = targetSlots({
    spells: {
      ...counterSpellTarget('spell', { filter: instantOrSorcery }),
      count: { min: 0, max: Infinity },
    },
  });
  replaceCard(
    '99140891-face-4015-aacd-1309e87d8f9f',
    'Display of Power',
    [
      "This spell can't be copied.",
      'Copy any number of target instant and/or sorcery spells. You may choose new targets for the copies.',
    ],
    {
      cantBeCopied: true,
      spellAbility: spell({
        targets: copyMany.targets,
        effects: [
          { op: 'copyEachTargetedSpell', targetSlot: copyMany.slot.spells, newTargets: true },
        ],
        description:
          'Copy any number of target instant and/or sorcery spells. You may choose new targets for the copies',
      }),
    },
    'PR10 cannot be copied, and each copy may choose new targets.',
  );
}

/** PR10.19, 10.26: copies of a cast spell made by a cast trigger (CR 707.10c). */
export function registerPr10CastCopyOverrides(): void {
  // PR10.19: a one-shot delayed cast trigger that lapses at cleanup; flashback is interpreted.
  replaceCard(
    'c51ed6e3-813b-49c4-b1de-7f92a77f8f6e',
    'Galvanic Iteration',
    [
      'When you next cast an instant or sorcery spell this turn, copy that spell. You may choose new targets for the copy.',
    ],
    {
      spellAbility: spell({
        effects: [
          {
            op: 'nextCastThisTurn',
            filter: anyOf(ofType('Instant'), ofType('Sorcery')),
            ability: triggered(undefined, {
              effects: [{ op: 'copyCastSpell' }],
              description: 'Copy that spell. You may choose new targets for the copy',
            }),
          },
        ],
        description:
          'When you next cast an instant or sorcery spell this turn, copy that spell. You may choose new targets for the copy',
      }),
    },
    'PR10 copies the next instant or sorcery cast this turn, with new targets.',
  );

  // PR10.26: "your first main phase" is the precombat main phase (CR 505.1a).
  replaceCard(
    '2469c0b7-a045-4733-bf53-28f3fdbe3797',
    'Cosmic Crucible',
    [
      'At the beginning of your first main phase, add four mana in any combination of colors.',
      'Whenever you cast a noncreature spell, you may copy it. You may choose new targets for the copy. Do this only once each turn.',
    ],
    {
      triggers: [
        triggered(
          { when: 'precombatMain', player: 'you' },
          {
            effects: [{ op: 'addMana', amount: constant(4), colors: 'any' }],
            description: 'Add four mana in any combination of colors',
          },
        ),
        triggered(onCast('you', not(ofType('Creature'))), {
          effects: [{ op: 'copyCastSpell', optional: true, oncePerTurn: true }],
          description:
            'You may copy that noncreature spell. You may choose new targets for the copy. Do this only once each turn',
        }),
      ],
    },
    'PR10 adds the first-main-phase mana and copies one noncreature spell each turn.',
  );
}

/** PR10.20, 10.27, 10.21, 10.22: countering, copying and watching abilities on the stack. */
export function registerPr10AbilityStackOverrides(): void {
  // PR10.20: the restriction is rechecked on resolution (CR 608.2b), after the sacrifice.
  const siren = targetSlots({
    object: { kind: 'stackObject', stackTargetsYouOrCreatureYouControl: true },
  });
  replaceCard(
    '59c7496b-19a2-478b-b28f-6f153c2458ae',
    'Siren Stormtamer',
    [
      '{U}, Sacrifice this creature: Counter target spell or ability that targets you or a creature you control.',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{U}'), { kind: 'sacrificeSelf' }],
          targets: siren.targets,
          effects: [{ op: 'counter', target: siren.slot.object }],
          description: 'Counter target spell or ability that targets you or a creature you control',
        }),
      ],
    },
    'PR10 counters only a spell or ability that targets you or a creature you control.',
  );

  // PR10.27: the Wizard check happens as Mana Sculpt resolves; the mana is what was spent.
  const sculpt = targetSlots({ spell: counterSpellTarget() });
  replaceCard(
    '35e2f82e-7ca3-4a92-9134-b7999eef5337',
    'Mana Sculpt',
    [
      'Counter target spell. If you control a Wizard, add an amount of {C} equal to the amount of mana spent to cast that spell at the beginning of your next main phase.',
    ],
    {
      spellAbility: spell({
        targets: sculpt.targets,
        effects: [
          {
            op: 'counter',
            target: sculpt.slot.spell,
            manaSpentAtNextMainPhase: {
              condition: countPermanents(ofSubtype('Wizard'), 'you', '>=', 1),
            },
          },
        ],
        description:
          'Counter target spell. If you control a Wizard, add {C} equal to the mana spent to cast it at the beginning of your next main phase',
      }),
    },
    'PR10 checks for a Wizard on resolution and adds the mana actually spent.',
  );

  // PR10.21: copies of a triggered ability on the stack (CR 707.10).
  const fantastic = targetSlots({
    ability: { kind: 'stackObject', stackKind: 'triggeredAbility', controller: 'you' },
  });
  replaceCard(
    'a8011dce-17fb-46e1-8297-81a4acccbd05',
    'Mister Fantastic',
    [
      '{R}{G}{W}{U}, {T}: Copy target triggered ability you control twice. You may choose new targets for the copies.',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{R}{G}{W}{U}'), { kind: 'tap' }],
          targets: fantastic.targets,
          effects: [
            { op: 'copyTargetAbility', target: fantastic.slot.ability, count: 2, newTargets: true },
          ],
          description:
            'Copy target triggered ability you control twice. You may choose new targets for the copies',
        }),
      ],
    },
    'PR10 copies a triggered ability on the stack twice, with new targets.',
  );

  // PR10.22: "if life was paid" is a fact of the activation (CR 603.4); the copy uses last known
  // information if the ability has already left the stack (CR 707.10).
  replaceCard(
    '04853f06-3fd2-445d-9b0d-d68d0f116635',
    'Verrak, Warped Sengir',
    [
      "Whenever you activate an ability that isn't a mana ability, if life was paid to activate it, you may pay that much life again. If you do, copy that ability. You may choose new targets for the copy.",
    ],
    {
      triggers: [
        triggered(
          { when: 'activatesAbility', player: 'you', lifePaid: true },
          {
            effects: [{ op: 'copyActivatedAbility', mayPayLifeAgain: true }],
            description:
              'You may pay that much life again. If you do, copy that ability. You may choose new targets for the copy',
          },
        ),
      ],
    },
    'PR10 copies an activated ability that cost life when its controller pays that life again.',
  );
}

/** PR10.24, 10.30: triggered abilities that trigger an additional time. */
export function registerPr10TriggerDoublingOverrides(): void {
  // PR10.24: ward and the creature type choice are interpreted; the type is the one chosen for it.
  replaceCard(
    '3640c29b-1534-4952-b297-619ade948431',
    'Roaming Throne',
    [
      '~ is the chosen type in addition to its other types.',
      'If a triggered ability of another creature you control of the chosen type triggers, it triggers an additional time.',
    ],
    {
      staticEffects: [{ affects: SELF, op: { layer: 4, addChosenSubtype: true } }],
      ruleStatics: [
        {
          kind: 'triggerAdditionalTime',
          filter: allOf(ofType('Creature'), CHOSEN_SUBTYPE),
          excludesSelf: true,
        },
      ],
    },
    'PR10 makes it the chosen type and doubles triggers of your other creatures of that type.',
  );

  // PR10.30: "it" is Annie Joins Up, an enchantment, so its own trigger is not doubled.
  const annie = targetSlots({
    victim: {
      kind: 'permanent',
      controller: 'opponent',
      filter: anyOf(ofType('Creature'), ofType('Planeswalker')),
    },
  });
  replaceCard(
    '4c3ad545-b375-44a7-a24e-58baacc4e4b6',
    'Annie Joins Up',
    [
      'When ~ enters, it deals 5 damage to target creature or planeswalker an opponent controls.',
      'If a triggered ability of a legendary creature you control triggers, that ability triggers an additional time.',
    ],
    {
      triggers: [
        triggered(onEtb(), {
          targets: annie.targets,
          effects: [{ op: 'dealDamage', target: annie.slot.victim, amount: constant(5) }],
          description: 'It deals 5 damage to target creature or planeswalker an opponent controls',
        }),
      ],
      ruleStatics: [
        {
          kind: 'triggerAdditionalTime',
          filter: allOf(ofType('Creature'), ofSupertype('Legendary')),
        },
      ],
    },
    'PR10 deals the enter damage and doubles triggers of your legendary creatures.',
  );
}

/** PR10.29, 10.28, 10.15: animation and becoming a copy until end of turn. */
export function registerPr10AnimationOverrides(): void {
  // PR10.29: it stays an artifact; its colors become exactly red and green (CR 105.3).
  replaceCard(
    'eb287c04-97f5-4e47-beb1-66cc7d15e748',
    'Atarka Monument',
    [
      '{4}{R}{G}: ~ becomes a 4/4 red and green Dragon artifact creature with flying until end of turn.',
    ],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{4}{R}{G}')],
          effects: [
            {
              op: 'becomeCreatureUntilEot',
              target: 'source',
              subtypes: ['Dragon'],
              power: 4,
              toughness: 4,
              keywords: ['flying'],
              colors: ['R', 'G'],
            },
          ],
          description:
            'This artifact becomes a 4/4 red and green Dragon artifact creature with flying until end of turn',
        }),
      ],
    },
    'PR10 makes the animated Monument red and green.',
  );

  // PR10.28: no "in addition to its other types", so he stops being a planeswalker (CR 205.1a).
  const sarkhanBolt = targetSlots({ creature: { kind: 'creature' } });
  replaceCard(
    '80c26f58-04b0-4db0-b84e-9b136609abe0',
    'Sarkhan, the Dragonspeaker',
    [
      '+1: Until end of turn, ~ becomes a legendary 4/4 red Dragon creature with flying, indestructible, and haste.',
      '−6: You get an emblem with "At the beginning of your draw step, draw two additional cards" and "At the beginning of your end step, discard your hand."',
    ],
    {
      activatedAbilities: [
        loyaltyAbility(1, {
          effects: [
            {
              op: 'becomeCreatureUntilEot',
              target: 'source',
              subtypes: ['Dragon'],
              power: 4,
              toughness: 4,
              keywords: ['flying', 'indestructible', 'haste'],
              replaceTypes: ['Creature'],
              colors: ['R'],
              supertypes: ['Legendary'],
            },
          ],
          description:
            'Until end of turn, Sarkhan becomes a legendary 4/4 red Dragon creature with flying, indestructible, and haste',
        }),
        loyaltyAbility(-3, {
          targets: sarkhanBolt.targets,
          effects: [{ op: 'dealDamage', target: sarkhanBolt.slot.creature, amount: constant(4) }],
          description: 'Sarkhan deals 4 damage to target creature',
        }),
        loyaltyAbility(-6, {
          effects: [
            {
              op: 'createEmblem',
              name: 'Sarkhan, the Dragonspeaker emblem',
              abilities: [
                triggered(onDrawStep('you'), {
                  effects: [{ op: 'draw', count: constant(2) }],
                  description: 'At the beginning of your draw step, draw two additional cards',
                }),
                triggered(onEndStep('you'), {
                  effects: [{ op: 'discardHand' }],
                  description: 'At the beginning of your end step, discard your hand',
                }),
              ],
            },
          ],
          description: 'You get an emblem that draws two more cards and discards your hand',
        }),
      ],
    },
    'PR10 makes Sarkhan a legendary red Dragon creature only, and adds the emblem.',
  );

  // PR10.15: it copies the target's copiable values until end of turn (CR 707.2).
  const mirror = targetSlots({
    original: {
      kind: 'permanent',
      filter: anyOf(ofType('Artifact'), ofType('Creature'), ofType('Enchantment'), ofType('Land')),
    },
  });
  replaceCard(
    '6a84eda1-7e72-4b5a-849f-b6e177565aeb',
    'Mirage Mirror',
    ['{2}: ~ becomes a copy of target artifact, creature, enchantment, or land until end of turn.'],
    {
      activatedAbilities: [
        activated({
          costs: [mana('{2}')],
          targets: mirror.targets,
          effects: [{ op: 'becomeCopyOf', ref: mirror.slot.original, untilEot: true }],
          description:
            'This artifact becomes a copy of target artifact, creature, enchantment, or land until end of turn',
        }),
      ],
    },
    'PR10 copies the target until end of turn.',
  );

  // PR10.08: the card has no +1; "another target" cannot be the first target (CR 115.3).
  const saheeli = targetSlots({
    artifact: { kind: 'artifact', controller: 'you' },
    model: {
      kind: 'permanent',
      controller: 'you',
      filter: anyOf(ofType('Artifact'), ofType('Creature')),
    },
  });
  const [saheeliArtifact, saheeliModel] = saheeli.targets;
  replaceCard(
    'ab655810-f67e-4576-9174-35b16f5e3235',
    'Saheeli, Sublime Artificer',
    [
      "−2: Target artifact you control becomes a copy of another target artifact or creature you control until end of turn, except it's an artifact in addition to its other types.",
    ],
    {
      activatedAbilities: [
        loyaltyAbility(-2, {
          targets: [
            saheeliArtifact!,
            { ...saheeliModel!, differentFromSlots: [saheeli.slot.artifact] },
          ],
          effects: [
            {
              op: 'becomeCopyOfTarget',
              target: saheeli.slot.artifact,
              ref: saheeli.slot.model,
              untilEot: true,
              addTypes: ['Artifact'],
            },
          ],
          description:
            "Target artifact you control becomes a copy of another target artifact or creature you control until end of turn, except it's an artifact",
        }),
      ],
    },
    'PR10 has only the printed loyalty ability, and the copied object must be another target.',
  );
}

/** PR10.17, 10.16: tokens that are copies of their source. */
export function registerPr10TokenCopyOverrides(): void {
  // PR10.17: the land count is read as the trigger resolves; the copy uses last known
  // information if Scute Swarm has left the battlefield (CR 707.2, 608.2h).
  replaceCard(
    'aa854d50-444c-49d9-bfb1-5476b33c1c0b',
    'Scute Swarm',
    [
      "Whenever a land you control enters, create a 1/1 green Insect creature token. If you control six or more lands, create a token that's a copy of this creature instead.",
    ],
    {
      triggers: [
        triggered(
          {
            when: 'enters',
            subject: { kind: 'permanent', selector: allOf(ofType('Land'), YOURS) },
          },
          {
            effects: [
              {
                op: 'conditionalEffect',
                condition: countPermanents(ofType('Land'), 'you', '>=', 6),
                then: [{ op: 'createTokenCopyOf', ref: 'source', count: constant(1) }],
                else: [
                  {
                    op: 'createToken',
                    count: constant(1),
                    spec: creatureToken({
                      name: 'Insect',
                      subtypes: ['Insect'],
                      colors: ['G'],
                      power: 1,
                      toughness: 1,
                    }),
                  },
                ],
              },
            ],
            description:
              "Create a 1/1 green Insect, or a token that's a copy of this creature if you control six or more lands",
          },
        ),
      ],
    },
    'PR10 creates an Insect, or a copy of Scute Swarm with six or more lands.',
  );

  // PR10.16: the exemption covers every creature you control, including the copies (CR 704.5j).
  replaceCard(
    '33fa949c-f29e-4a98-9381-ecfa9e5c3f6d',
    'Council of Reeds',
    [
      'The "legend rule" doesn\'t apply to creatures you control.',
      "At the beginning of combat on your turn, if you've cast a noncreature spell this turn, create a token that's a copy of ~.",
    ],
    {
      ruleStatics: [{ kind: 'legendRuleDoesntApply', filter: ofType('Creature') }],
      triggers: [
        triggered(onBeginCombat('you'), {
          condition: { kind: 'castSpellThisTurn', category: 'noncreature', cmp: '>=', n: 1 },
          effects: [{ op: 'createTokenCopyOf', ref: 'source', count: constant(1) }],
          description: "Create a token that's a copy of Council of Reeds",
        }),
      ],
    },
    'PR10 exempts your creatures from the legend rule and copies Council of Reeds at combat.',
  );

  // PR10.18: only the creatures that entered from, or were cast from, a graveyard are "them".
  // The surveil enter trigger is interpreted and kept.
  replaceCard(
    '05d7222b-cc08-4f1f-8e35-6058599572ba',
    'Twilight Diviner',
    [
      "Whenever one or more other creatures you control enter, if they entered or were cast from a graveyard, create a token that's a copy of one of them. This ability triggers only once each turn.",
    ],
    {
      triggers: [
        triggered(
          {
            when: 'enters',
            subject: {
              kind: 'permanent',
              selector: allOf(ofType('Creature'), YOURS, { kind: 'other' }),
            },
            aggregate: true,
            entersFrom: { zone: 'graveyard', orCastFrom: true },
            oncePerTurn: true,
          },
          {
            effects: [{ op: 'createTokenCopyOfEventGroupMember', count: constant(1) }],
            description: "Create a token that's a copy of one of them",
          },
        ),
      ],
    },
    'PR10 copies one creature that entered or was cast from a graveyard, once each turn.',
    'append',
  );

  // PR10.07: the target is chosen only after the energy is paid (CR 603.12).
  const radiant = targetSlots({ original: { kind: 'permanent', controller: 'you' } });
  replaceCard(
    '20f602b3-814f-406c-b7eb-2d1fc98f8cf1',
    'Saheeli, Radiant Creator',
    [
      'Whenever you cast an Artificer or artifact spell, you get {E} .',
      "At the beginning of combat on your turn, you may pay {E}{E}{E}. When you do, create a token that's a copy of target permanent you control, except it's a 5/5 artifact creature in addition to its other types and has haste. Sacrifice it at the beginning of the next end step.",
    ],
    {
      triggers: [
        triggered(onCast('you', anyOf(ofSubtype('Artificer'), ofType('Artifact'))), {
          effects: [{ op: 'gainEnergy', amount: constant(1) }],
          description: 'You get {E}',
        }),
        triggered(onBeginCombat('you'), {
          effects: [
            {
              op: 'mayPayEnergyThenReflexive',
              min: 3,
              exact: true,
              then: triggered(undefined, {
                targets: radiant.targets,
                effects: [
                  {
                    op: 'createTokenCopyOf',
                    ref: radiant.slot.original,
                    count: constant(1),
                    addTypes: ['Artifact', 'Creature'],
                    powerOverride: 5,
                    toughnessOverride: 5,
                    addKeywords: ['haste'],
                    sacrificeAt: 'endStep',
                  },
                ],
                description:
                  "Create a token that's a copy of target permanent you control, except it's a 5/5 artifact creature with haste. Sacrifice it at the beginning of the next end step",
              }),
            },
          ],
          description: 'You may pay {E}{E}{E}. When you do, copy target permanent you control',
        }),
      ],
    },
    'PR10 chooses the copy target after the energy is paid.',
  );

  // PR10.22: the goad static is part of the copiable values (CR 707.9b), and "this creature"
  // reads the Doppelganger's copied name. Flash is interpreted and kept.
  replaceCard(
    '3b8eb602-01e8-432e-8dfc-8fdb62c3aa43',
    'Mocking Doppelganger',
    [
      'You may have this creature enter as a copy of a creature an opponent controls, except it has "Other creatures with the same name as this creature are goaded."',
    ],
    {
      entersAsCopy: {
        selector: allOf(ofType('Creature'), OPPONENTS),
        addStaticEffects: [
          {
            affects: allOf(ofType('Creature'), { kind: 'other' }, { kind: 'sameNameAsSource' }),
            op: { layer: 6, addGoad: true },
          },
        ],
      },
    },
    "PR10 copies an opponent's creature and goads the other creatures sharing its name.",
  );
}

/** PR10.13 and the characteristic group: cards whose characteristics come from other objects. */
export function registerPr10CharacteristicsOverrides(): void {
  const imprint = targetSlots({ exiled: { kind: 'creature', filter: not(IS_TOKEN) } });
  // PR10.13: the exile is optional on resolution, but the target is chosen as the trigger is put
  // on the stack (CR 603.3d). Its static ability reads the cards still exiled with this object.
  replaceCard(
    'ea86abfa-6cab-4ef0-8463-34136fc25b59',
    'Duplicant',
    [
      'When this creature enters, you may exile target nontoken creature.',
      "As long as a card exiled with this creature is a creature card, this creature has the power, toughness, and creature types of the last creature card exiled with it. It's still a Shapeshifter.",
    ],
    {
      triggers: [
        triggered(onEtb(), {
          optional: true,
          targets: imprint.targets,
          effects: [{ op: 'exileTargetWithSource', target: imprint.slot.exiled }],
          description: 'You may exile target nontoken creature',
        }),
      ],
      copyLastExiledCreature: true,
    },
    'PR10 links the exiled cards to this object and sets base P/T and creature types from the last creature card.',
  );

  // PR10.15: a characteristic-defining ability (CR 604.3), counting each card type once across
  // all opponents' graveyards. Flying, deathtouch and lifelink are interpreted and kept.
  replaceCard(
    '379ed4ec-8f2e-448b-9ed2-a3181e2f877e',
    'Nighthawk Scavenger',
    [
      "~'s power is equal to 1 plus the number of card types among cards in your opponents' graveyards.",
      // The printed "1+*" is defined by the layer 7a ability below.
      'non-numeric power/toughness "1+*"',
    ],
    {
      staticEffects: [
        {
          affects: SELF,
          op: {
            layer: 7,
            sublayer: 'a',
            power: { kind: 'plus', of: { kind: 'cardTypesInOpponentsGraveyards' }, n: 1 },
            toughness: constant(3),
          },
        },
      ],
    },
    "PR10 counts card types among cards in opponents' graveyards only.",
  );

  // PR10.28: devotion counts hybrid symbols once (CR 700.5a); while it is below seven Xenagos loses
  // the creature type and the God creature type with it (CR 205.1a). X is locked in as the
  // trigger resolves (CR 608.2h).
  const revel = targetSlots({ pumped: { kind: 'creature', controller: 'you', filter: OTHER } });
  replaceCard(
    'cb15a8dd-57fe-466f-847e-66476b690a1f',
    'Xenagos, God of Revels',
    [
      "As long as your devotion to red and green is less than seven, ~ isn't a creature.",
      "At the beginning of combat on your turn, another target creature you control gains haste and gets +X/+X until end of turn, where X is that creature's power.",
    ],
    {
      staticEffects: [
        {
          affects: SELF,
          op: { layer: 4, removeCreatureType: true },
          condition: {
            kind: 'compareValues',
            left: { kind: 'devotionTo', color: 'R', and: 'G' },
            cmp: '<=',
            right: constant(6),
          },
        },
      ],
      triggers: [
        triggered(onBeginCombat('you'), {
          targets: revel.targets,
          effects: [
            { op: 'grantKeywordUntilEot', target: revel.slot.pumped, keyword: 'haste' },
            {
              op: 'pumpUntilEot',
              target: revel.slot.pumped,
              power: { kind: 'powerOfTarget', target: revel.slot.pumped },
              toughness: { kind: 'powerOfTarget', target: revel.slot.pumped },
            },
          ],
          description:
            "Another target creature you control gains haste and gets +X/+X until end of turn, where X is that creature's power",
        }),
      ],
    },
    "PR10 removes the creature type below seven devotion and doubles another creature's power at combat.",
  );

  // PR10.09: every activated ability of each artifact card in your graveyard, mana abilities
  // included (CR 605.1a), read again whenever the graveyard changes. Deathtouch is interpreted.
  replaceCard(
    '1ef3b48a-55ef-422e-ac7f-e1c1057eec2c',
    'Trazyn the Infinite',
    [
      'Prismatic Gallery — As long as ~ is on the battlefield, it has all activated abilities of all artifact cards in your graveyard.',
    ],
    { artifactGraveyardAbilities: true },
    'PR10 grants the activated and mana abilities of artifact cards in your graveyard.',
  );
}
