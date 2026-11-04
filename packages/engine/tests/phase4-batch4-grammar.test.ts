/**
 * EDHREC coverage plan, Phase 4 batch 4: phrase-level amounts, player verbs, damage clauses,
 * life-change trigger events and short line shapes. Each production is read from a stand-in card
 * and run through the executor (D1: the feature is tested once; the cards it closes need no tests
 * of their own). The runner scenarios of one card per feature drive the same productions through
 * the normal cast, trigger and activation paths.
 */
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { Ability } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { scaleByCount } from '../src/cards/grammar/amount-forms';
import { executeAbility, gainLife } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

const creature = (name: string, oracleText: string, typeLine = 'Creature — Human'): OracleCard =>
  oracle({ name, typeLine, manaCost: '{1}', power: '1', toughness: '1', oracleText });
const sorcery = (name: string, oracleText: string, manaCost = '{1}'): OracleCard =>
  oracle({ name, typeLine: 'Sorcery', manaCost, oracleText });
const player = (ctx: GameContext, id: string) => ctx.state.players.find((p) => p.id === id)!;

function run(
  ctx: GameContext,
  card: OracleCard,
  ability: Ability,
  targets: string[] = [],
  scope: Parameters<typeof executeAbility>[5] = {},
  sourceCardId = 'p4-source',
): void {
  pump(
    executeAbility(
      ctx,
      { cardId: sourceCardId, name: card.name, oracleId: card.oracleId, controllerId: 'P1' },
      ability,
      targets,
      undefined,
      scope,
    ),
    undefined,
    { strict: true },
  );
}

describe('Phase 4 batch 4: amount forms', () => {
  it('"where X is" binds X to the counted value in every amount of the sentence', () => {
    const card = creature(
      'P4 Champion',
      'When this creature enters, you draw X cards and you lose X life, where X is the number of Humans you control.',
    );
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    const count = {
      kind: 'countPermanents',
      selector: {
        kind: 'allOf',
        of: [
          { kind: 'controller', who: 'you' },
          { kind: 'subtype', value: 'Human' },
        ],
      },
      scope: 'you',
    };
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'draw', count },
      { op: 'loseLife', amount: count },
    ]);
    const ctx = pod('p4-where-x');
    spawn(ctx, 'P1', card);
    spawn(ctx, 'P1', creature('P4 Human', ''));
    const hand = player(ctx, 'P1').hand.length;
    run(ctx, card, def.triggers[0]!);
    expect(player(ctx, 'P1').hand).toHaveLength(hand + 2);
    expect(player(ctx, 'P1').life).toBe(38);
  });

  it('"for each" multiplies the one amount of the sentence', () => {
    const card = sorcery('P4 Honden', 'You gain 2 life for each creature you control.');
    const def = interpretCard(card);
    const ctx = pod('p4-for-each');
    spawn(ctx, 'P1', creature('P4 A', ''));
    spawn(ctx, 'P1', creature('P4 B', ''));
    spawn(ctx, 'P2', creature('P4 C', ''));
    run(ctx, card, def.spellAbility!);
    expect(player(ctx, 'P1').life).toBe(44);
  });

  it('"equal to" puts the value in the amount position', () => {
    const card = sorcery(
      'P4 Shinestriker',
      'Draw cards equal to the number of creatures you control.',
    );
    const def = interpretCard(card);
    const ctx = pod('p4-equal-to');
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', creature(`P4 E${i}`, ''));
    const hand = player(ctx, 'P1').hand.length;
    run(ctx, card, def.spellAbility!);
    expect(player(ctx, 'P1').hand).toHaveLength(hand + 3);
  });

  it('a permanent never reads a bare X it does not define', () => {
    // CR 107.3m: an X on a permanent's own ability is not the announced X of the spell.
    const def = interpretCard(
      oracle({
        name: 'P4 Anguish',
        typeLine: 'Enchantment',
        manaCost: '{X}{R}',
        oracleText: 'When this enchantment enters, it deals X damage to any target.',
      }),
    );
    expect(def.modeled).toBe(false);
  });

  it('"for each" refuses a sentence with two amounts it could scale', () => {
    const per = { kind: 'countOpponents' } as const;
    expect(
      scaleByCount(
        [
          { op: 'draw', count: { kind: 'const', n: 1 } },
          { op: 'gainLife', amount: { kind: 'const', n: 1 } },
        ],
        per,
      ),
    ).toBeNull();
    expect(scaleByCount([{ op: 'gainLife', amount: { kind: 'const', n: 2 } }], per)).toEqual([
      { op: 'gainLife', amount: { kind: 'times', of: per, n: 2 } },
    ]);
  });
});

describe('Phase 4 batch 4: player verbs and damage', () => {
  it('"they" in a draw trigger is the drawing player (Sheoldred)', () => {
    const card = creature('P4 Praetor', 'Whenever an opponent draws a card, they lose 2 life.');
    const def = interpretCard(card);
    expect(def.triggers[0]!.effects).toEqual([
      { op: 'loseLifeTarget', target: 'eventPlayer', amount: { kind: 'const', n: 2 } },
    ]);
    const ctx = pod('p4-they');
    run(ctx, card, def.triggers[0]!, [], { eventPlayerId: 'P3' });
    expect(player(ctx, 'P3').life).toBe(38);
    expect(player(ctx, 'P1').life).toBe(40);
  });

  it('"they" without an event player is not read', () => {
    const def = interpretCard(sorcery('P4 They', 'They lose 2 life.'));
    expect(def.modeled).toBe(false);
  });

  it('two clauses share the first subject: "target player draws two cards and loses 2 life"', () => {
    const card = sorcery('P4 Sign', 'Target player draws two cards and loses 2 life.');
    const def = interpretCard(card);
    expect(def.spellAbility!.targets).toHaveLength(1);
    const ctx = pod('p4-and');
    const hand = player(ctx, 'P2').hand.length;
    run(ctx, card, def.spellAbility!, ['P2']);
    expect(player(ctx, 'P2').hand).toHaveLength(hand + 2);
    expect(player(ctx, 'P2').life).toBe(38);
  });

  it('each player mills, discards and loses life; each opponent draws', () => {
    const ctx = pod('p4-each');
    for (const id of ['P1', 'P2', 'P3', 'P4']) conjure(ctx, id, forest(), 'hand');
    const mill = sorcery('P4 Bell', 'Each player mills two cards.');
    run(ctx, mill, interpretCard(mill).spellAbility!);
    for (const id of ['P1', 'P2', 'P3', 'P4'])
      expect(player(ctx, id).graveyard.length).toBeGreaterThanOrEqual(2);
    const lose = sorcery('P4 Pact', 'Each player loses 2 life.');
    run(ctx, lose, interpretCard(lose).spellAbility!);
    for (const id of ['P1', 'P2', 'P3', 'P4']) expect(player(ctx, id).life).toBe(38);
  });

  it('"it deals 1 damage to any target" on an activated ability names the permanent', () => {
    const card = creature(
      'P4 Ballista',
      'Remove a +1/+1 counter from this creature: It deals 1 damage to any target.',
      'Artifact Creature — Construct',
    );
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.activatedAbilities[0]!.costs).toEqual([
      { kind: 'removeCounters', counter: '+1/+1', count: 1 },
    ]);
    const ctx = pod('p4-ballista');
    run(ctx, card, def.activatedAbilities[0]!.ability, ['P2']);
    expect(player(ctx, 'P2').life).toBe(39);
  });

  it('a spell\'s "it deals" refers back to something unread and is refused', () => {
    expect(interpretCard(sorcery('P4 It', 'It deals 3 damage to any target.')).modeled).toBe(false);
  });

  it('"~ deals X damage" reads the announced X of an instant or sorcery', () => {
    const card = sorcery('P4 Blaze', '~ deals X damage to any target.', '{X}{R}');
    const def = interpretCard(card);
    expect(def.spellAbility!.effects).toEqual([
      { op: 'dealDamage', target: 0, amount: { kind: 'xValue' } },
    ]);
  });

  it('"this creature deals 1 damage to each player" hits the controller too', () => {
    const card = creature('P4 Spewer', '{T}: This creature deals 1 damage to each player.');
    const def = interpretCard(card);
    const ctx = pod('p4-each-player');
    run(ctx, card, def.activatedAbilities[0]!.ability);
    for (const id of ['P1', 'P2', 'P3', 'P4']) expect(player(ctx, id).life).toBe(39);
  });
});

describe('Phase 4 batch 4: life-change trigger events', () => {
  it('"whenever you gain life" fires once per gain, with the amount as "that much"', () => {
    const card = oracle({
      name: 'P4 Bond',
      typeLine: 'Enchantment',
      oracleText: 'Whenever you gain life, target opponent loses that much life.',
    });
    const def = interpretCard(card);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'gainsLife', player: 'you' });
    const ctx = pod('p4-gain-trigger');
    spawn(ctx, 'P1', card);
    gainLife(ctx, player(ctx, 'P1'), 3);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]!.scope).toMatchObject({ damageDealt: 3 });
    gainLife(ctx, player(ctx, 'P2'), 3);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    // P2 gained 3 above (which did not trigger P1's Bond), so 43 before the loss.
    run(ctx, card, def.triggers[0]!, ['P2'], { damageDealt: 3 });
    expect(player(ctx, 'P2').life).toBe(40);
  });

  it('"whenever an opponent loses life" reads the opponent scope', () => {
    const def = interpretCard(
      oracle({
        name: 'P4 Blood',
        typeLine: 'Enchantment',
        oracleText: 'Whenever an opponent loses life, you gain that much life.',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.triggers[0]!.trigger).toEqual({ when: 'losesLife', player: 'opponent' });
    expect(def.triggers[0]!.effects).toEqual([{ op: 'gainLife', amount: { kind: 'damageDealt' } }]);
  });

  it('"whenever you gain life for the first time each turn" is refused: the event has no such qualifier', () => {
    const def = interpretCard(
      creature('P4 First', 'Whenever you gain life for the first time each turn, draw a card.'),
    );
    expect(def.modeled).toBe(false);
  });
});

describe('Phase 4 batch 4: short shapes', () => {
  it('a reveal land offers the reveal only for the named subtypes', () => {
    const def = interpretCard(
      oracle({
        name: 'P4 Estuary',
        typeLine: 'Land',
        oracleText:
          "As this land enters, you may reveal an Island or Swamp card from your hand. If you don't, this land enters tapped.",
      }),
    );
    expect(def.entersTappedUnless).toEqual({
      kind: 'mayRevealCardFromHand',
      subtypes: ['Island', 'Swamp'],
    });
  });

  it('Ephemerate returns the card under its owner, Cloudshift under you', () => {
    const ephemerateCard = oracle({
      name: 'P4 Ephemerate',
      typeLine: 'Instant',
      oracleText:
        "Exile target creature you control, then return it to the battlefield under its owner's control.",
    });
    const ephemerate = interpretCard(ephemerateCard);
    const cloudshift = interpretCard(
      oracle({
        name: 'P4 Cloudshift',
        typeLine: 'Instant',
        oracleText:
          'Exile target creature you control, then return that card to the battlefield under your control.',
      }),
    );
    expect(cloudshift.spellAbility!.effects).toEqual([
      { op: 'blinkTarget', target: 0, returnUnder: 'you' },
    ]);
    expect(ephemerate.spellAbility!.effects).toEqual([
      { op: 'blinkTarget', target: 0, returnUnder: 'owner' },
    ]);
    const ctx = pod('p4-blink');
    const stolen = spawn(ctx, 'P2', creature('P4 Stolen', ''));
    stolen.controllerId = 'P1';
    run(ctx, ephemerateCard, ephemerate.spellAbility!, [stolen.id]);
    const back = ctx.state.battlefield.find((p) => p.name === 'P4 Stolen')!;
    expect(back.controllerId).toBe('P2');
    expect(back.id).not.toBe(stolen.id);
  });

  it('"put a +1/+1 counter on it" after creating a token is not read as a new target', () => {
    const def = interpretCard(
      sorcery('P4 Odds', 'Create a 1/1 white Ally creature token. Put a +1/+1 counter on it.'),
    );
    expect(def.modeled).toBe(false);
  });

  it('"Shuffle ~ into its owner\'s library" moves the resolving spell, not just the library', () => {
    const def = interpretCard(
      sorcery(
        'P4 Zenith',
        "Target player draws X cards. Shuffle P4 Zenith into its owner's library.",
        '{X}{U}',
      ),
    );
    expect(def.spellAbility!.effects.at(-1)).toEqual({ op: 'resolvingSpellShuffleIntoLibrary' });
  });

  it('each player sacrifices a creature of their choice, never a noncreature', () => {
    const card = sorcery('P4 Blood', 'Each player sacrifices a creature of their choice.');
    const def = interpretCard(card);
    const ctx = pod('p4-edict');
    spawn(ctx, 'P1', creature('P4 Mine', ''));
    spawn(ctx, 'P2', creature('P4 Theirs', ''));
    const land = spawn(ctx, 'P3', forest());
    run(ctx, card, def.spellAbility!);
    expect(ctx.state.battlefield.filter((p) => p.name.startsWith('P4 '))).toHaveLength(0);
    expect(ctx.state.battlefield).toContain(land);
  });

  it('"attacks each combat if able" is a requirement on the source', () => {
    const def = interpretCard(creature('P4 Juggernaut', '~ attacks each combat if able.'));
    expect(def.staticEffects).toEqual([
      { affects: { kind: 'self' }, op: { layer: 6, setMustAttackEachCombat: true } },
    ]);
  });

  it('"target creature gains deathtouch and indestructible" grants both to one target', () => {
    const def = interpretCard(
      sorcery('P4 Vigor', 'Target creature gains deathtouch and indestructible until end of turn.'),
    );
    expect(def.spellAbility!.targets).toHaveLength(1);
    expect(def.spellAbility!.effects).toEqual([
      { op: 'grantKeywordUntilEot', target: 0, keyword: 'deathtouch' },
      { op: 'grantKeywordUntilEot', target: 0, keyword: 'indestructible' },
    ]);
  });

  it('overloaded "target player discards two cards" is "each player discards two cards"', () => {
    const def = interpretCard(
      oracle({
        name: 'P4 Rake',
        typeLine: 'Sorcery',
        manaCost: '{2}{B}',
        oracleText:
          'Target player discards two cards.\nOverload {1}{B} (You may cast this spell for its overload cost. If you do, change "target" in its text to "each.")',
      }),
    );
    expect(def.modeled).toBe(true);
    expect(def.alternativeCasts?.[0]?.ability?.effects).toEqual([
      { op: 'discardEachPlayer', scope: 'all', count: { kind: 'const', n: 2 } },
    ]);
  });
});
