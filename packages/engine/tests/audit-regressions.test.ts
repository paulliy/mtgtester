import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { resolveCondition } from '../src/cards/condition';
import { TAP_COST } from '../src/cards/definition';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { canPay, parseManaCost, planPayment } from '../src/mana/cost';
import { selectEntriesToSpend } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { queueCastTriggers } from '../src/state/objects';
import { landPlayLimitFor } from '../src/state/queries';
import { buildPlayerBoardState } from '../src/view/spectator';
import { buildPlayerView } from '../src/view/view';
import { conjure, gameConfig, oracle, pump, spawn } from './fixtures';

const context = () =>
  createGame(gameConfig([{ cards: [] }, { cards: [] }], { seed: 'audit-regressions' }));

describe('audit: exact mana and life payment', () => {
  it.each([
    ['W', 'U'],
    ['U', 'W'],
  ] as const)('spends overlapping hybrid pips from %s,%s', (a, b) => {
    const cost = parseManaCost('{W/U}{W/B}').cost!;
    const entries = [{ symbol: a }, { symbol: b }];
    expect(canPay(cost, entries, [])).toBe(true);
    expect(selectEntriesToSpend(entries, cost)).toHaveLength(2);
  });
  it('combines floating mana with sources without committing a hybrid color early', () => {
    const cost = parseManaCost('{W/U}{W/B}').cost!;
    const plan = planPayment(
      cost,
      [{ symbol: 'W' }],
      [{ cardId: 'island', units: [['U']], costs: TAP_COST }],
    );
    expect(plan?.tapCardIds).toEqual(['island']);
    expect(
      selectEntriesToSpend(
        [{ symbol: 'W' }, ...plan!.produced.map(({ symbol }) => ({ symbol }))],
        cost,
      ),
    ).toHaveLength(2);
  });
  it('rejects a missing color even with many flexible sources', () => {
    const sources = Array.from({ length: 32 }, (_, i) => ({
      cardId: `land-${i}`,
      units: [['G', 'W'] as ('G' | 'W')[]],
      costs: TAP_COST,
    }));
    expect(canPay(parseManaCost('{16}{U}').cost!, [], sources)).toBe(false);
  });
  it.each([0, 1, 2, 3])('only offers an affordable life payment at %i life', (life) => {
    const ctx = context();
    const player = ctx.state.players[0]!;
    player.life = life;
    const result = pump(
      resolveCondition(
        ctx,
        { kind: 'mayPayLife', n: 2 },
        { cardId: 'shock', controllerId: 'P1' },
        'Shock land',
      ),
    );
    expect(result.value).toBe(life >= 2);
    expect(player.life).toBe(life >= 2 ? life - 2 : life);
    if (life < 2) expect(result.decisions).toHaveLength(0);
  });
});

describe('audit: manifest entry and visibility', () => {
  it('enters as a nameless 2/2 without printed triggers, statics, counters, or choices', () => {
    const ctx = context();
    const top = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Manifest Secret',
        typeLine: 'Legendary Creature — Beast',
        manaCost: '{3}',
        power: '5',
        toughness: '5',
        oracleText: 'When this creature enters, draw a card.',
      }),
      'library',
    );
    const def = ctx.defs.get(top.oracleId)!;
    def.entersTapped = true;
    def.entersWithCounters = { '+1/+1': 3 };
    def.entersChoosingOption = {
      prompt: 'Choose a color',
      options: [{ key: 'red', label: 'Red' }],
    };
    def.ruleStatics = [{ kind: 'additionalLandDrops', count: { kind: 'const', n: 1 } }];
    def.ward = parseManaCost('{4}').cost!;
    const result = pump(
      executeAbility(
        ctx,
        { cardId: 'manifest', name: 'Manifest', oracleId: 'manifest', controllerId: 'P1' },
        { kind: 'spell', targets: [], effects: [{ op: 'manifestTop', player: 'you' }] },
        [],
      ),
    );
    expect(result.decisions).toHaveLength(0);
    const perm = ctx.state.battlefield[0]!;
    expect(perm.faceDown).toBe(true);
    expect(perm.tapped).toBe(false);
    expect(perm.counters).toEqual({});
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(computeCharacteristics(ctx, perm)).toMatchObject({
      power: 2,
      toughness: 2,
      supertypes: [],
      keywords: [],
      triggers: [],
      ward: null,
    });
    expect(landPlayLimitFor(ctx, 'P1')).toBe(1);
    expect(buildPlayerView(ctx, 'P2').battlefield[0]).toMatchObject({
      name: 'Face-down permanent',
    });
    expect(buildPlayerBoardState(ctx, 'P2').battlefield[0]).toMatchObject({
      name: 'Face-down permanent',
      oracleText: '',
      scryfallId: null,
    });
    expect(JSON.stringify(ctx.state.eventLog)).not.toContain('Manifest Secret');
  });
});

describe('audit: Sram only draws for the printed spell types', () => {
  it.each([
    ['Enchantment — Aura', 'P1', 1],
    ['Artifact — Equipment', 'P1', 1],
    ['Artifact — Vehicle', 'P1', 1],
    ['Artifact', 'P1', 0],
    ['Enchantment', 'P1', 0],
    ['Artifact — Equipment', 'P2', 0],
  ] as const)('%s cast by %s queues %i triggers', (typeLine, controllerId, count) => {
    const ctx = context();
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Sram, Senior Edificer',
        typeLine: 'Legendary Creature — Dwarf Advisor',
        oracleText: 'Whenever you cast an Aura, Equipment, or Vehicle spell, draw a card.',
      }),
    );
    const card = conjure(ctx, controllerId, oracle({ name: 'Sram Test Spell', typeLine }), 'hand');
    queueCastTriggers(ctx, {
      id: 'spell',
      kind: 'spell',
      controllerId,
      sourceId: card.id,
      sourceCardId: card.cardId,
      sourceOracleId: card.oracleId,
      description: card.name,
      card,
      ability: null,
      targets: [],
      isCommanderCast: false,
    });
    expect(ctx.state.pendingTriggers).toHaveLength(count);
  });
});

// These cards must remain visibly unsupported until their missing mechanics are implemented.
describe('audit: approximate cards fail closed', () => {
  it.each([
    [
      'Pearl-Ear, Imperial Advisor',
      'Enchantment spells you cast have affinity for Auras.\nWhenever you cast an Aura spell that targets a modified permanent you control, draw a card.',
    ],
    [
      'Killian, Decisive Mentor',
      'Whenever one or more creatures that are enchanted by an Aura you control attack, draw a card.',
    ],
    [
      "Sage's Reverie",
      "Enchanted creature gets +1/+1 for each Aura you control that's attached to a creature.",
    ],
    ['Spirit Mantle', 'Enchanted creature gets +1/+1 and has protection from creatures.'],
    [
      'Scriv, the Obligator',
      'Whenever this creature enters or attacks, create a white Aura enchantment token named Contract attached to target creature an opponent controls.',
    ],
    [
      "Songbirds' Blessing",
      "Whenever enchanted creature attacks, reveal cards from the top of your library until you reveal an Aura card. You may put that card onto the battlefield. If you don't, put it into your hand. Put the rest on the bottom of your library in a random order.",
    ],
    [
      'Promise of Loyalty',
      "Each player puts a vow counter on a creature they control and sacrifices the rest. Each of those creatures can't attack you or planeswalkers you control for as long as it has a vow counter on it.",
    ],
  ])('%s is not advertised as modeled', (name, oracleText) => {
    const def = interpretCard(oracle({ name, oracleText }));
    expect(def.modeled).toBe(false);
    expect(def.unmodeledReasons.length).toBeGreaterThan(0);
  });
});

// Both watchers must see the full event regardless of battlefield insertion order.
describe('audit: simultaneous deaths', () => {
  it.each([false, true])('preserves dying watchers (reverse order: %s)', async (reverse) => {
    const { priorityCheckpoint } = await import('../src/sba/sba');
    const ctx = context();
    const watcher = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Audit Death Watcher',
        typeLine: 'Creature — Beast',
        power: '2',
        toughness: '2',
        oracleText: 'Whenever another creature dies, draw a card.',
      }),
    );
    const victim = spawn(
      ctx,
      'P1',
      oracle({ name: 'Audit Victim', typeLine: 'Creature — Beast', power: '2', toughness: '2' }),
    );
    watcher.damageMarked = 2;
    victim.damageMarked = 2;
    if (reverse) ctx.state.battlefield.reverse();
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.players[0]!.graveyard).toHaveLength(2);
    expect(ctx.state.stack).toHaveLength(1);
  });
});
