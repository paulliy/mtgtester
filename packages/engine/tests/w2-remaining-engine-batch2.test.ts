import { conjure } from './fixtures';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { computeCharacteristics } from '../src/effects/continuous';
import { applyManaRider, executeAbility, payManaCost } from '../src/effects/resolve';
import { parseManaCost } from '../src/mana/cost';
import { createGame } from '../src/state/game';
import { makePermanent, queueTriggersForObject } from '../src/state/objects';
import type { EngineCardObject, EngineStackObject, GameContext } from '../src/state/types';
import { copies, forest, gameConfig, mountain, oracle, plains, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/w2-remaining-engine-batch2-oracle.json'),
    'utf8',
  ),
) as PinnedFixture;

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function pinned(name: string): OracleCard {
  return fixture.cards.find((entry) => entry.card.name === name)!.card;
}

function pod(seed: string, seats = 4): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: seats }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function playerOf(ctx: GameContext, id: string) {
  return ctx.state.players.find((player) => player.id === id)!;
}

describe('W2 remaining engine-evidence batch 2 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Endless Foot Assault',
      'Securitron Squadron',
      'Study Hall',
      'Tender Wildguide',
      'Twitching Doll',
      'Ultimate Nullification',
      'Verix Bladewing',
    ]);
    for (const entry of fixture.cards) {
      expect(entry.card.oracleId).not.toMatch(/^oracle-/);
      expect(entry.card.oracleText.length, entry.card.name).toBeGreaterThan(20);
      expect(
        createHash('sha256').update(canonical(entry.card)).digest('hex'),
        entry.card.name,
      ).toBe(entry.sha256);
    }
  });

  it('models the complete pinned Oracle text for real and fixture IDs', () => {
    for (const { card } of fixture.cards) {
      for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
        const def = interpretCard(candidate);
        expect(def.modeled, `${card.name} (${candidate.oracleId})`).toBe(true);
        expect(def.unmodeledReasons, card.name).toEqual([]);
      }
    }
  });
});

describe('Endless Foot Assault', () => {
  const card = pinned('Endless Foot Assault');

  it('endless-creates-squad-copies-and-one-attacking-ninja-per-opponent', () => {
    const ctx = pod('endless-squad');
    const source = spawn(ctx, 'P1', card);
    source.optionalCostCounts = { squad: 1 };
    const triggers = interpretCard(card).triggers;
    pump(executeAbility(ctx, source, triggers[0]!, []));
    expect(
      ctx.state.battlefield.filter((permanent) => permanent.name === 'Endless Foot Assault'),
    ).toHaveLength(2);

    pump(executeAbility(ctx, source, triggers[1]!, []));
    const ninjas = ctx.state.battlefield.filter((permanent) => permanent.name === 'Ninja');
    expect(ninjas).toHaveLength(3);
    expect(ninjas.map((ninja) => ninja.attacking).sort()).toEqual(['P2', 'P3', 'P4']);
  });

  it('endless-does-not-make-squad-copies-when-squad-was-not-paid', () => {
    const ctx = pod('endless-no-squad');
    const source = spawn(ctx, 'P1', card);
    pump(executeAbility(ctx, source, interpretCard(card).triggers[0]!, []));
    expect(
      ctx.state.battlefield.filter((permanent) => permanent.name === 'Endless Foot Assault'),
    ).toHaveLength(1);
  });
});

describe('Securitron Squadron', () => {
  const card = pinned('Securitron Squadron');

  it('securitron-puts-a-counter-only-on-another-creature-token', () => {
    const ctx = pod('securitron-counter');
    const squadron = spawn(ctx, 'P1', card);
    const token = spawn(ctx, 'P1', oracle({ name: 'Securitron Friend' }));
    token.isToken = true;
    queueTriggersForObject(ctx, 'enters', token);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(executeAbility(ctx, squadron, ctx.state.pendingTriggers[0]!.ability, [], token.cardId));
    expect(token.counters['+1/+1']).toBe(1);

    ctx.state.pendingTriggers = [];
    queueTriggersForObject(ctx, 'enters', squadron);
    expect(
      ctx.state.pendingTriggers.some((trigger) =>
        trigger.ability.effects.some(
          (effect) => effect.op === 'putCounters' && effect.counter === '+1/+1',
        ),
      ),
    ).toBe(false);
  });

  it('securitron-does-not-counter-a-nontoken-creature', () => {
    const ctx = pod('securitron-nontoken');
    spawn(ctx, 'P1', card);
    const friend = spawn(ctx, 'P1', oracle({ name: 'Securitron Nontoken' }));
    queueTriggersForObject(ctx, 'enters', friend);
    expect(
      ctx.state.pendingTriggers.some((trigger) =>
        trigger.ability.effects.some(
          (effect) => effect.op === 'putCounters' && effect.counter === '+1/+1',
        ),
      ),
    ).toBe(false);
  });
});

describe('Study Hall', () => {
  const card = pinned('Study Hall');

  it('study-hall-scries-only-when-its-mana-casts-your-commander', () => {
    const setup = (seed: string) => {
      const ctx = pod(seed);
      const player = playerOf(ctx, 'P1');
      const hall = interpretCard(card);
      spawn(ctx, 'P1', card);
      player.manaEntries.push({
        symbol: 'W',
        spendTrigger: hall.manaAbilities[1]!.spendTrigger!,
      });
      const commander = oracle({
        name: `Study Hall Commander ${seed}`,
        typeLine: 'Legendary Creature — Advisor',
        manaCost: '{W}',
      });
      ctx.defs.set(commander.oracleId, interpretCard(commander));
      player.commanderCastCount['study-commander-card'] = 3;
      return { ctx, player, commander };
    };

    const commanderCast = setup('study-commander');
    pump(
      payManaCost(commanderCast.ctx, commanderCast.player, parseManaCost('{W}').cost!, {
        kind: 'castSpell',
        oracleId: commanderCast.commander.oracleId,
        isCommander: true,
      }),
    );
    expect(commanderCast.ctx.state.pendingTriggers).toHaveLength(1);
    expect(commanderCast.ctx.state.pendingTriggers[0]!.ability.effects).toEqual([
      { op: 'scry', count: { kind: 'commanderCastCount', player: 'you' } },
    ]);

    const ordinaryCast = setup('study-ordinary');
    pump(
      payManaCost(ordinaryCast.ctx, ordinaryCast.player, parseManaCost('{W}').cost!, {
        kind: 'castSpell',
        oracleId: ordinaryCast.commander.oracleId,
        isCommander: false,
      }),
    );
    expect(ordinaryCast.ctx.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Tender Wildguide', () => {
  const card = pinned('Tender Wildguide');

  it('wildguide-creates-a-1/1-offspring-copy-only-when-paid', () => {
    const offspring = pod('wildguide-offspring');
    const parent = spawn(offspring, 'P1', card);
    parent.optionalCostCounts = { offspring: 1 };
    pump(executeAbility(offspring, parent, interpretCard(card).triggers[0]!, []));
    const child = offspring.state.battlefield.find(
      (permanent) => permanent.name === 'Tender Wildguide' && permanent.isToken,
    )!;
    expect(computeCharacteristics(offspring, child).power).toBe(1);
    expect(computeCharacteristics(offspring, child).toughness).toBe(1);

    const unpaid = pod('wildguide-plain');
    const plain = spawn(unpaid, 'P1', card);
    pump(executeAbility(unpaid, plain, interpretCard(card).triggers[0]!, []));
    expect(
      unpaid.state.battlefield.filter((permanent) => permanent.name === 'Tender Wildguide'),
    ).toHaveLength(1);
  });
});

describe('Twitching Doll', () => {
  const card = pinned('Twitching Doll');

  it('doll-adds-a-nest-counter-as-a-mana-rider-and-makes-spiders-for-all-counters', () => {
    const ctx = pod('twitching-doll');
    const doll = spawn(ctx, 'P1', card);
    const def = interpretCard(card);
    pump(applyManaRider(ctx, doll, playerOf(ctx, 'P1'), def.manaAbilities[0]!.onActivate![0]!));
    doll.counters['+1/+1'] = 1;
    expect(doll.counters['nest']).toBe(1);
    ctx.state.battlefield.splice(ctx.state.battlefield.indexOf(doll), 1);
    pump(
      executeAbility(ctx, doll, def.activatedAbilities[0]!.ability, [], undefined, {
        sourceCountersTotal: 2,
      }),
    );
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Spider')).toHaveLength(
      2,
    );
  });
});

describe('Ultimate Nullification', () => {
  const card = pinned('Ultimate Nullification');

  it('nullification-needs-a-legendary-creature-to-cast', () => {
    const ctx = pod('nullification-cost');
    const player = playerOf(ctx, 'P1');
    for (let i = 0; i < 5; i++) spawn(ctx, 'P1', plains());
    spawn(ctx, 'P1', oracle({ name: 'Common Sac Fodder' }));
    const spell = conjure(ctx, 'P1', card, 'hand');
    expect(
      computePriorityOptions(ctx, player).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.objectId === spell.id;
      }),
    ).toBe(false);

    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Legendary Sac Fodder',
        typeLine: 'Legendary Creature — Human',
      }),
    );
    expect(
      computePriorityOptions(ctx, player).some((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.objectId === spell.id;
      }),
    ).toBe(true);
  });

  it('nullification-exiles-creatures-and-graveyards-then-goes-to-the-bottom', () => {
    const ctx = pod('nullification-resolve');
    const def = interpretCard(card);
    ctx.defs.set(card.oracleId, def);
    spawn(ctx, 'P1', oracle({ name: 'Nullification Victim' }));
    const graveCard: EngineCardObject = {
      id: 'grave-object',
      cardId: 'grave-card',
      oracleId: forest().oracleId,
      ownerId: 'P2',
      name: 'Forest',
      typeLine: 'Basic Land — Forest',
      oracleText: '',
      manaCost: null,
      isToken: false,
      isCommander: false,
      zone: 'graveyard',
    };
    playerOf(ctx, 'P2').graveyard.push(graveCard);
    const spellCard: EngineCardObject = {
      ...graveCard,
      id: 'nullification-spell',
      cardId: 'nullification-card',
      oracleId: card.oracleId,
      ownerId: 'P1',
      name: card.name,
      typeLine: card.typeLine,
      oracleText: card.oracleText,
      manaCost: card.manaCost,
      zone: 'stack',
    };
    const stackObject: EngineStackObject = {
      id: spellCard.id,
      sourceId: spellCard.id,
      controllerId: 'P1',
      kind: 'spell',
      description: card.name,
      targets: [],
      card: spellCard,
      ability: def.spellAbility,
      sourceOracleId: card.oracleId,
      sourceCardId: spellCard.cardId,
      isCommanderCast: false,
    };
    pump(
      executeAbility(
        ctx,
        {
          cardId: spellCard.cardId,
          oracleId: card.oracleId,
          name: card.name,
          controllerId: 'P1',
          resolvingStackObject: stackObject,
        },
        def.spellAbility!,
        [],
      ),
    );
    expect(ctx.state.battlefield).toHaveLength(0);
    expect(ctx.state.players.every((player) => player.graveyard.length === 0)).toBe(true);
    expect(playerOf(ctx, 'P1').library.at(-1)?.name).toBe('Ultimate Nullification');
    expect(stackObject.card).toBeNull();
  });
});

describe('Verix Bladewing', () => {
  const card = pinned('Verix Bladewing');

  it('verix-makes-karox-only-from-a-kicked-entry', () => {
    const resolveEntry = (seed: string, kicked: boolean) => {
      const ctx = pod(seed);
      ctx.defs.set(card.oracleId, interpretCard(card));
      const object: EngineCardObject = {
        id: `verix-object-${seed}`,
        cardId: `verix-card-${seed}`,
        oracleId: card.oracleId,
        ownerId: 'P1',
        name: card.name,
        typeLine: card.typeLine,
        oracleText: card.oracleText,
        manaCost: card.manaCost,
        isToken: false,
        isCommander: false,
        zone: 'stack',
        ...(kicked ? { optionalCostCounts: { kicker: 1 } } : {}),
      };
      const verix = makePermanent(ctx, object, 'P1');
      ctx.state.battlefield.push(verix);
      queueTriggersForObject(ctx, 'enters', verix);
      for (const trigger of ctx.state.pendingTriggers) {
        pump(executeAbility(ctx, verix, trigger.ability, []));
      }
      return ctx;
    };

    const kicked = resolveEntry('verix-kicked', true);
    const karox = kicked.state.battlefield.find((permanent) =>
      permanent.name.toLowerCase().includes('karox bladewing'),
    );
    expect(karox).toBeDefined();
    expect(computeCharacteristics(kicked, karox!).keywords).toContain('flying');

    const plain = resolveEntry('verix-plain', false);
    expect(
      plain.state.battlefield.some((permanent) =>
        permanent.name.toLowerCase().includes('karox bladewing'),
      ),
    ).toBe(false);
  });

  it('verix-normal-cast-without-kicker', () => {
    const ctx = pod('verix-cast');
    const player = playerOf(ctx, 'P1');
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', mountain());
    spawn(ctx, 'P1', mountain());
    const spell = conjure(ctx, 'P1', card, 'hand');
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === spell.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(ctx.state.stack.at(-1)?.sourceCardId).toBe(spell.cardId);
  });
});
