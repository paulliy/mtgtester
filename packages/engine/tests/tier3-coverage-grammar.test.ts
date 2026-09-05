import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { createTokens, queueCastTriggers } from '../src/state/objects';
import type { EngineStackObject, GameContext } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

function pod(seed = 'tier3-coverage-grammar'): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  for (const player of ctx.state.players) {
    conjure(ctx, player.id, forest(), 'library');
    conjure(ctx, player.id, forest(), 'library');
  }
  return ctx;
}

function spell(ctx: GameContext, controllerId: 'P1' | 'P2', name: string): EngineStackObject {
  const card = conjure(
    ctx,
    controllerId,
    oracle({ name, typeLine: 'Sorcery', manaCost: '{1}', oracleText: 'Draw a card.' }),
    'hand',
  );
  return {
    id: card.id,
    sourceId: card.id,
    controllerId,
    kind: 'spell',
    description: card.name,
    targets: [],
    card,
    ability: null,
    sourceOracleId: card.oracleId,
    sourceCardId: card.cardId,
    isCommanderCast: false,
  };
}

describe('Tier 3 residual generic grammar', () => {
  it('parses aggregate token entry, token creation, and trigger-object follow-up effects', () => {
    const tokenEntry = interpretCard(
      oracle({
        name: 'Token Entry Watcher',
        oracleText: 'Whenever one or more tokens you control enter, you may draw a card.',
      }),
    );
    const tokenCreation = interpretCard(
      oracle({
        name: 'Creature Token Watcher',
        oracleText:
          'Whenever you create one or more creature tokens, put a story counter on this artifact.',
        typeLine: 'Artifact',
      }),
    );
    const entrant = interpretCard(
      oracle({
        name: 'Entrant Watcher',
        oracleText:
          'Whenever another nontoken creature you control enters, put a +1/+1 counter on it. It gains haste until end of turn.',
      }),
    );

    expect(tokenEntry.modeled, tokenEntry.unmodeledReasons.join('; ')).toBe(true);
    expect(tokenEntry.triggers[0]?.trigger).toMatchObject({ when: 'enters', aggregate: true });
    expect(tokenCreation.modeled, tokenCreation.unmodeledReasons.join('; ')).toBe(true);
    expect(tokenCreation.triggers[0]?.trigger).toMatchObject({
      when: 'tokenCreated',
      aggregate: true,
    });
    expect(entrant.modeled, entrant.unmodeledReasons.join('; ')).toBe(true);
    expect(entrant.triggers[0]?.effects).toEqual([
      { op: 'putCounters', target: 'triggerObject', counter: '+1/+1', count: 1 },
      { op: 'grantKeywordUntilEot', target: 'triggerObject', keyword: 'haste' },
    ]);
  });

  it('fires one aggregate token-entry trigger for a created batch', () => {
    const ctx = pod('tier3-token-entry-grammar');
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Token Entry Watcher Runtime',
        oracleText: 'Whenever one or more tokens you control enter, draw a card.',
      }),
    );
    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const before = player.hand.length;

    createTokens(
      ctx,
      {
        name: 'Servo',
        typeLine: 'Artifact Creature — Servo',
        types: ['Artifact', 'Creature'],
        subtypes: ['Servo'],
        colors: [],
        power: 1,
        toughness: 1,
      },
      3,
      'P1',
    );

    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.scope?.triggerCount).toBe(3);
    pump(runPrioritySequence(ctx));
    expect(player.hand).toHaveLength(before + 1);
  });

  it('tracks casts centrally and fires an ordinal trigger only on the matching spell', () => {
    const ctx = pod('tier3-ordinal-casts');
    const watcher = oracle({
      name: 'Second Spell Watcher',
      oracleText: 'Whenever an opponent casts their second noncreature spell each turn, draw a card.',
    });
    const def = interpretCard(watcher);
    expect(def.modeled, def.unmodeledReasons.join('; ')).toBe(true);
    expect(def.triggers[0]?.trigger).toMatchObject({
      when: 'castsSpell',
      caster: 'opponent',
      ordinal: 2,
    });
    spawn(ctx, 'P1', watcher);

    queueCastTriggers(ctx, spell(ctx, 'P2', 'First Test Spell'));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    queueCastTriggers(ctx, spell(ctx, 'P2', 'Second Test Spell'));
    expect(ctx.state.players.find((player) => player.id === 'P2')?.spellsCastThisTurn).toBe(2);
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
    const before = player.hand.length;
    pump(runPrioritySequence(ctx));
    expect(player.hand).toHaveLength(before + 1);
  });

  it('parses reusable trigger, copy, combat, pump, and replacement forms', () => {
    const cards = [
      oracle({
        name: 'Ghostly Flicker Test',
        typeLine: 'Instant',
        oracleText:
          'Exile two target artifacts, creatures, and/or lands you control, then return those cards to the battlefield under your control.',
      }),
      oracle({
        name: 'Quantum Misalignment Test',
        typeLine: 'Sorcery',
        oracleText:
          "Create a token that's a copy of target creature you control, except it isn't legendary.",
      }),
      oracle({
        name: 'Aggravated Assault Test',
        typeLine: 'Enchantment',
        oracleText:
          '{3}{R}{R}: Untap all creatures you control. After this main phase, there is an additional combat phase followed by an additional main phase. Activate only as a sorcery.',
      }),
      oracle({
        name: 'Seize the Day Test',
        typeLine: 'Sorcery',
        oracleText:
          'Untap target creature. After this main phase, there is an additional combat phase followed by an additional main phase.',
      }),
      oracle({
        name: 'Kessig Wolf Run Test',
        typeLine: 'Land',
        manaCost: null,
        oracleText:
          '{X}{R}{G}, {T}: Target creature gets +X/+0 and gains trample until end of turn.',
      }),
      oracle({
        name: 'Medusa Test',
        oracleText:
          'Whenever a player casts a noncreature spell, put a +1/+1 counter on this creature.',
      }),
      oracle({
        name: 'Up the Beanstalk Test',
        typeLine: 'Enchantment',
        oracleText:
          'When this enchantment enters and whenever you cast a spell with mana value 5 or greater, draw a card.',
      }),
      oracle({
        name: 'Encroaching Dragonstorm Test',
        typeLine: 'Enchantment',
        oracleText:
          "When a Dragon you control enters, return this enchantment to its owner's hand.",
      }),
      oracle({
        name: 'Cactusfolk Sureshot Test',
        oracleText:
          'At the beginning of combat on your turn, other creatures you control with power 4 or greater gain trample and haste until end of turn.',
      }),
      oracle({
        name: 'Twinflame Tyrant Test',
        oracleText:
          'If a source you control would deal damage to an opponent or a permanent an opponent controls, it deals double that damage instead.',
      }),
    ];

    for (const card of cards) {
      const def = interpretCard(card);
      expect(def.modeled, `${card.name}: ${def.unmodeledReasons.join('; ')}`).toBe(true);
    }
    const ghostly = interpretCard(cards[0]!);
    expect(ghostly.spellAbility?.targets[0]?.count).toEqual({ min: 2, max: 2 });
    const beanstalk = interpretCard(cards[6]!);
    expect(beanstalk.triggers).toHaveLength(2);
  });

  it('parses target-relative values, beneficiaries, and remaining threshold forms', () => {
    const cards = [
      oracle({ name: 'Borrowing Arrows Test', typeLine: 'Sorcery', oracleText: 'Draw a card for each tapped creature target opponent controls.' }),
      oracle({ name: 'Keep Watch Test', typeLine: 'Instant', oracleText: 'Draw a card for each attacking creature.' }),
      oracle({ name: 'Recurring Insight Test', typeLine: 'Sorcery', oracleText: "Draw cards equal to the number of cards in target opponent's hand." }),
      oracle({ name: 'Warstorm Surge Test', typeLine: 'Enchantment', oracleText: 'Whenever a creature you control enters, it deals damage equal to its power to any target.' }),
      oracle({ name: 'Black Bolt Test', oracleText: 'Lethal Voice \u2014 Whenever this creature becomes the target of a spell or ability an opponent controls, destroy target nonland permanent that player controls.' }),
      oracle({ name: 'Hunted Phantasm Test', oracleText: 'When this creature enters, target opponent creates five 1/1 red Goblin creature tokens.' }),
      oracle({ name: 'Death by Dragons Test', typeLine: 'Sorcery', oracleText: 'Each player other than target player creates a 5/5 red Dragon creature token with flying.' }),
      oracle({ name: 'Reach the Horizon Test', typeLine: 'Sorcery', oracleText: 'Search your library for up to two basic land cards and/or Town cards with different names, put them onto the battlefield tapped, then shuffle.' }),
      oracle({ name: 'Winds of Abandon Test', typeLine: 'Sorcery', oracleText: "Exile target creature you don't control. For each creature exiled this way, its controller searches their library for a basic land card. Those players put those cards onto the battlefield tapped, then shuffle." }),
      oracle({ name: 'Invisible Force Field Test', typeLine: 'Instant', oracleText: 'Up to four target permanents you control gain indestructible until end of turn.\nRebound' }),
      oracle({ name: 'Fantastic Elasticity Test', typeLine: 'Instant', oracleText: "Choose one \u2014\n\u2022 Return target nonland permanent to its owner's hand.\n\u2022 Return target instant or sorcery card from your graveyard to your hand.\nRebound" }),
      oracle({ name: 'Unwind Test', typeLine: 'Instant', oracleText: 'Counter target noncreature spell. Untap up to three lands.' }),
      oracle({ name: 'Vicious Shadows Test', typeLine: 'Enchantment', oracleText: "Whenever a creature dies, you may have this enchantment deal damage to target player equal to the number of cards in that player's hand." }),
      oracle({ name: 'Dingus Staff Test', typeLine: 'Artifact', oracleText: "Whenever a creature dies, this artifact deals 2 damage to that creature's controller." }),
      oracle({ name: 'Cadira Test', oracleText: 'Whenever this creature deals combat damage to a player, for each token you control, create a 1/1 white Rabbit creature token.' }),
      oracle({ name: 'Noise Marine Test', oracleText: "Sonic Blaster \u2014 When this creature enters, it deals damage equal to the number of spells you've cast this turn to any target." }),
      oracle({ name: 'Rishkar Expertise Test', typeLine: 'Sorcery', oracleText: 'Draw cards equal to the greatest power among creatures you control.\nYou may cast a spell with mana value 5 or less from your hand without paying its mana cost.' }),
      oracle({ name: 'Ruby Test', oracleText: 'Whenever this creature attacks while you control a creature with power 4 or greater, this creature gets +2/+2 until end of turn.' }),
    ];

    for (const card of cards) {
      const def = interpretCard(card);
      expect(def.modeled, `${card.name}: ${def.unmodeledReasons.join('; ')}`).toBe(true);
    }

    const ctx = pod('tier3-target-relative-values');
    const recurring = interpretCard(cards[2]!);
    const p1 = ctx.state.players.find((player) => player.id === 'P1')!;
    const p2 = ctx.state.players.find((player) => player.id === 'P2')!;
    const before = p1.hand.length;
    conjure(ctx, 'P2', forest(), 'hand');
    conjure(ctx, 'P2', forest(), 'hand');
    pump(executeAbility(ctx, { cardId: 'recurring', oracleId: cards[2]!.oracleId, name: cards[2]!.name, controllerId: 'P1' }, recurring.spellAbility!, [p2.id]));
    expect(p1.hand.length).toBe(before + p2.hand.length);
  });

  it('parses variable-count blink and returns a stolen permanent under its owner\'s control', () => {
    const oji = oracle({
      name: 'Oji, the Exquisite Blade',
      oracleText:
        "Whenever you cast your second spell each turn, exile up to one target creature you control, then return it to the battlefield under its owner's control.",
    });
    const circle = oracle({
      name: 'Teleportation Circle',
      typeLine: 'Enchantment',
      oracleText:
        "At the beginning of your end step, exile up to one target artifact or creature you control, then return that card to the battlefield under its owner's control.",
    });
    const ojiDef = interpretCard(oji);
    const circleDef = interpretCard(circle);
    expect(ojiDef.modeled, ojiDef.unmodeledReasons.join('; ')).toBe(true);
    expect(circleDef.modeled, circleDef.unmodeledReasons.join('; ')).toBe(true);
    expect(circleDef.triggers[0]?.effects).toEqual([
      { op: 'blinkEachChosen', targetSlot: 0, returnUnder: 'owner' },
    ]);

    const ctx = pod('tier3-variable-blink');
    const source = spawn(ctx, 'P1', oji);
    const stolen = spawn(
      ctx,
      'P2',
      oracle({ name: 'Stolen Test Creature', oracleText: '', typeLine: 'Creature' }),
    );
    stolen.controllerId = 'P1';
    pump(
      executeAbility(
        ctx,
        {
          cardId: source.cardId,
          oracleId: source.oracleId,
          name: source.name,
          controllerId: source.controllerId,
        },
        ojiDef.triggers[0]!,
        [],
        undefined,
        undefined,
        { 0: [stolen.id] },
      ),
    );

    const returned = ctx.state.battlefield.find((permanent) => permanent.cardId === stolen.cardId);
    expect(returned?.id).not.toBe(stolen.id);
    expect(returned?.controllerId).toBe('P2');
  });

  it('parses reusable keyword-cost, compound grant, and bounded tutor forms', () => {
    const outlast = interpretCard(
      oracle({ name: 'Outlast Test', oracleText: 'Outlast {1}{W}' }),
    );
    const equipCommander = interpretCard(
      oracle({
        name: 'Commander Equipment Test',
        typeLine: 'Artifact — Equipment',
        oracleText: 'Equip commander {2}',
      }),
    );
    const stronghold = interpretCard(
      oracle({
        name: 'Stronghold Test',
        typeLine: 'Land',
        manaCost: null,
        oracleText:
          '{R}{W}, {T}: Target creature gets +2/+0 and gains vigilance and haste until end of turn.',
      }),
    );
    const veil = interpretCard(
      oracle({
        name: 'Veil Test',
        typeLine: 'Instant',
        oracleText:
          'Put a +1/+1 counter on target creature you control. It gains hexproof until end of turn.',
      }),
    );
    const route = interpretCard(
      oracle({
        name: 'Route Test',
        typeLine: 'Sorcery',
        oracleText:
          'Search your library for up to two basic land cards and/or Gate cards, put them onto the battlefield tapped, then shuffle.',
      }),
    );

    for (const def of [outlast, equipCommander, stronghold, veil, route]) {
      expect(def.modeled, `${def.name}: ${def.unmodeledReasons.join('; ')}`).toBe(true);
    }
    expect(outlast.activatedAbilities[0]?.timing).toBe('sorcery');
    expect(equipCommander.activatedAbilities[0]?.ability.targets[0]?.filter).toEqual({
      kind: 'isCommander',
    });
    expect(stronghold.activatedAbilities[0]?.ability.effects).toHaveLength(3);
    expect(veil.spellAbility?.targets[0]?.controller).toBe('you');
    expect(route.spellAbility?.effects[0]).toMatchObject({
      op: 'searchLibrary',
      count: { kind: 'const', n: 2 },
    });
  });
});
