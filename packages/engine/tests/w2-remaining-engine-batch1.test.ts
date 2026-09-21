import { conjure } from './fixtures';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectId, OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  computePriorityOptions,
  computeTargetOptions,
  costReductionFor,
  targetLifeTaxFor,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects, executeAbility } from '../src/effects/resolve';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import { makePermanent, queueCastTriggers, queueTriggersForObject } from '../src/state/objects';
import type { EngineCardObject, EngineStackObject, GameContext } from '../src/state/types';
import {
  copies,
  declareAttacks,
  declareNoAttacks,
  forest,
  gameConfig,
  oracle,
  pick,
  plains,
  pump,
  spawn,
} from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/w2-remaining-engine-batch1-oracle.json'),
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

function activate(ctx: GameContext, objectId: string) {
  return computePriorityOptions(ctx, playerOf(ctx, 'P1')).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === objectId;
  });
}

describe('W2 remaining engine-evidence batch 1 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Baxter Building',
      'Collective Effort',
      'Jacked Rabbit',
      'Mondrak, Glory Dominus',
      "Norn's Annex",
      'Pearl-Ear, Imperial Advisor',
      'Terror of the Peaks',
      'Zopandrel, Hunger Dominus',
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

describe('Baxter Building', () => {
  const card = pinned('Baxter Building');

  it('baxter-requires-a-creature-you-control-with-toughness-4+', () => {
    const ctx = pod('baxter-gate');
    const baxter = spawn(ctx, 'P1', card);
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', forest());
    expect(activate(ctx, baxter.id)).toBeUndefined();
    spawn(ctx, 'P2', oracle({ name: 'Their Wall', power: '0', toughness: '4' }));
    expect(activate(ctx, baxter.id)).toBeUndefined();
    spawn(ctx, 'P1', oracle({ name: 'Baxter Wall', power: '0', toughness: '4' }));
    expect(activate(ctx, baxter.id)).toBeDefined();
  });

  it('baxter-taps-and-draws-on-the-normal-activation-path', () => {
    const ctx = pod('baxter-draw');
    const player = playerOf(ctx, 'P1');
    const baxter = spawn(ctx, 'P1', card);
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', oracle({ name: 'Baxter Wall', power: '0', toughness: '4' }));
    const before = player.hand.length;
    pump(
      applyPriorityAction(ctx, player, activate(ctx, baxter.id)!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(baxter.tapped).toBe(true);
    pump(resolveTopOfStack(ctx));
    expect(player.hand).toHaveLength(before + 1);
  });
});

describe('Collective Effort', () => {
  const card = pinned('Collective Effort');

  it('collective-destroys-power-4+-not-smaller-creatures', () => {
    const ctx = pod('collective-targets');
    const large = spawn(
      ctx,
      'P2',
      oracle({ name: 'Collective Large', power: '4', toughness: '4' }),
    );
    const small = spawn(
      ctx,
      'P2',
      oracle({ name: 'Collective Small', power: '3', toughness: '3' }),
    );
    const slot = interpretCard(card).spellAbility!.targets[0]!;
    const legal = computeTargetOptions(ctx, slot, 'P1');
    expect(legal).toContain(large.id);
    expect(legal).not.toContain(small.id);
  });

  it('collective-executes-all-three-mode-bodies-against-announced-targets', () => {
    const ctx = pod('collective-modes');
    const def = interpretCard(card);
    const large = spawn(
      ctx,
      'P2',
      oracle({ name: 'Collective Large', power: '4', toughness: '4' }),
    );
    const enchantment = spawn(
      ctx,
      'P2',
      oracle({ name: 'Collective Enchantment', typeLine: 'Enchantment' }),
    );
    const survivor = spawn(ctx, 'P2', oracle({ name: 'Collective Survivor' }));
    const modes = def.spellAbility!.modes!.options;
    pump(
      executeAbility(
        ctx,
        { cardId: 'collective-card', oracleId: def.oracleId, name: def.name, controllerId: 'P1' },
        {
          kind: 'spell',
          targets: def.spellAbility!.targets,
          effects: modes.flatMap((mode) => mode.effects),
        },
        [large.id, enchantment.id, 'P2' as ObjectId],
      ),
    );
    expect(ctx.state.battlefield).not.toContain(large);
    expect(ctx.state.battlefield).not.toContain(enchantment);
    expect(survivor.counters['+1/+1']).toBe(1);
  });

  it('collective-normal-cast-of-the-destroy-creature-mode', () => {
    const ctx = pod('collective-cast');
    const player = playerOf(ctx, 'P1');
    for (let i = 0; i < 3; i++) spawn(ctx, 'P1', plains());
    const large = spawn(
      ctx,
      'P2',
      oracle({ name: 'Collective Large', power: '4', toughness: '4' }),
    );
    const spell = conjure(ctx, 'P1', card, 'hand');
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as Extract<PriorityActionPayload, { kind: 'castSpell' }>;
      return (
        payload.kind === 'castSpell' &&
        payload.objectId === spell.id &&
        payload.modes?.length === 1 &&
        payload.modes[0] === 0
      );
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, large.id]]),
      }),
    );
    pump(resolveTopOfStack(ctx));
    expect(ctx.state.battlefield).not.toContain(large);
  });
});

describe('Jacked Rabbit / Mondrak, Glory Dominus', () => {
  const rabbit = pinned('Jacked Rabbit');
  const mondrak = pinned('Mondrak, Glory Dominus');

  it('rabbit-ravenous-draws-only-when-announced-x-is-5+', () => {
    const resolveEntry = (seed: string, x: number) => {
      const ctx = pod(seed);
      const def = interpretCard(rabbit);
      ctx.defs.set(rabbit.oracleId, def);
      const object: EngineCardObject = {
        id: `rabbit-${seed}`,
        cardId: `rabbit-card-${seed}`,
        oracleId: rabbit.oracleId,
        ownerId: 'P1',
        name: rabbit.name,
        typeLine: rabbit.typeLine,
        oracleText: rabbit.oracleText,
        manaCost: rabbit.manaCost,
        isToken: false,
        isCommander: false,
        zone: 'stack',
        announcedX: x,
      };
      const perm = makePermanent(ctx, object, 'P1');
      ctx.state.battlefield.push(perm);
      const before = playerOf(ctx, 'P1').hand.length;
      queueTriggersForObject(ctx, 'enters', perm);
      for (const trigger of ctx.state.pendingTriggers) {
        pump(executeAbility(ctx, perm, trigger.ability, []));
      }
      return {
        perm,
        drawn: playerOf(ctx, 'P1').hand.length - before,
        queued: ctx.state.pendingTriggers.length,
      };
    };

    const five = resolveEntry('rabbit-x5', 5);
    expect(five.perm.counters['+1/+1']).toBe(5);
    expect(five.drawn).toBe(1);

    const four = resolveEntry('rabbit-x4', 4);
    expect(four.perm.counters['+1/+1']).toBe(4);
    expect(four.drawn).toBe(0);
  });

  it('mondrak-doubles-jacked-rabbit-attack-tokens', () => {
    const ctx = pod('mondrak-double');
    spawn(ctx, 'P1', mondrak);
    const attacker = spawn(ctx, 'P1', rabbit);
    attacker.counters['+1/+1'] = 2;
    const expected = computeCharacteristics(ctx, attacker).power * 2;
    pump(executeAbility(ctx, attacker, interpretCard(rabbit).triggers[1]!, []));
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Rabbit')).toHaveLength(
      expected,
    );
  });

  it('rabbit-attack-tokens-are-not-doubled-without-mondrak', () => {
    const ctx = pod('rabbit-plain');
    const attacker = spawn(ctx, 'P1', rabbit);
    attacker.counters['+1/+1'] = 2;
    const expected = computeCharacteristics(ctx, attacker).power;
    pump(executeAbility(ctx, attacker, interpretCard(rabbit).triggers[1]!, []));
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Rabbit')).toHaveLength(
      expected,
    );
  });
});

describe("Norn's Annex", () => {
  const card = pinned("Norn's Annex");

  it('annex-blocks-attacks-at-one-life-and-charges-two-life-when-payable', () => {
    const unaffordable = pod('annex-unaffordable');
    unaffordable.state.phase = 'combat';
    playerOf(unaffordable, 'P1').life = 1;
    spawn(unaffordable, 'P2', card);
    spawn(unaffordable, 'P1', oracle({ name: 'Annex Attacker A' }));
    pump(runCombatPhase(unaffordable), (decision) => {
      if (decision.decisionType === 'declareAttackers') {
        const subject = decision.presentationAttackDeclaration!.subjects[0]!;
        expect(subject.defenders.map((defender) => defender.playerId)).not.toContain('P2');
        return declareNoAttacks(decision);
      }
      return pick(decision, /Pass|does not/);
    });

    const payable = pod('annex-payable');
    payable.state.phase = 'combat';
    playerOf(payable, 'P1').life = 3;
    spawn(payable, 'P2', card);
    spawn(payable, 'P1', oracle({ name: 'Annex Attacker B' }));
    pump(runCombatPhase(payable), (decision) => {
      if (decision.decisionType === 'declareAttackers') {
        return declareAttacks(decision, () => 'P2');
      }
      return pick(decision, /Pass|does not/);
    });
    expect(playerOf(payable, 'P1').life).toBe(1);
  });
});

describe('Pearl-Ear, Imperial Advisor', () => {
  const card = pinned('Pearl-Ear, Imperial Advisor');

  it('pearl-ear-draws-only-when-an-aura-targets-your-modified-permanent', () => {
    const ctx = pod('pearl-ear-draw');
    spawn(ctx, 'P1', card);
    const modified = spawn(ctx, 'P1', oracle({ name: 'Modified Target' }));
    modified.counters['+1/+1'] = 1;
    const aura = oracle({
      name: 'W2 Test Aura',
      typeLine: 'Enchantment — Aura',
      oracleText: 'Enchant creature',
    });
    const auraDef = interpretCard(aura);
    ctx.defs.set(aura.oracleId, auraDef);
    const stackObject: EngineStackObject = {
      id: 'aura-spell',
      sourceId: 'aura-spell',
      controllerId: 'P1',
      kind: 'spell',
      description: aura.name,
      targets: [modified.id],
      card: null,
      ability: { kind: 'spell', targets: [{ kind: 'creature' }], effects: [] },
      sourceOracleId: aura.oracleId,
      sourceCardId: 'aura-card',
      isCommanderCast: false,
    };
    queueCastTriggers(ctx, stackObject);
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    ctx.state.pendingTriggers = [];
    const plain = spawn(ctx, 'P1', oracle({ name: 'Plain Target' }));
    stackObject.targets = [plain.id];
    queueCastTriggers(ctx, stackObject);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('pearl-ear-reduces-enchantment-spells-by-auras-you-control', () => {
    const ctx = pod('pearl-affinity');
    spawn(ctx, 'P1', card);
    for (const name of ['Affinity Aura A', 'Affinity Aura B']) {
      spawn(
        ctx,
        'P1',
        oracle({ name, typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature' }),
      );
    }
    const spell = oracle({
      name: 'Affinity Enchantment',
      typeLine: 'Enchantment',
      manaCost: '{4}{W}',
    });
    ctx.defs.set(spell.oracleId, interpretCard(spell));
    expect(costReductionFor(ctx, 'P1', spell.oracleId, 'affinity-card').generic).toBe(2);
  });
});

describe('Terror of the Peaks', () => {
  const card = pinned('Terror of the Peaks');

  it('terror-taxes-only-an-opposing-caster-who-targets-it', () => {
    const ctx = pod('terror-tax');
    const terror = spawn(ctx, 'P2', card);
    expect(targetLifeTaxFor(ctx, 'P1', [terror.id])).toBe(3);
    expect(targetLifeTaxFor(ctx, 'P2', [terror.id])).toBe(0);
  });

  it('terror-deals-the-entering-creature-power-and-ignores-self-entry', () => {
    const ctx = pod('terror-damage');
    const terror = spawn(ctx, 'P1', card);
    queueTriggersForObject(ctx, 'enters', terror);
    expect(
      ctx.state.pendingTriggers.some((trigger) =>
        trigger.ability.effects.some((effect) => effect.op === 'dealDamage'),
      ),
    ).toBe(false);

    ctx.state.pendingTriggers = [];
    const entering = spawn(
      ctx,
      'P1',
      oracle({ name: 'Terror Entrant', power: '3', toughness: '3' }),
    );
    entering.counters['+1/+1'] = 1;
    queueTriggersForObject(ctx, 'enters', entering);
    const damage = ctx.state.pendingTriggers.find((trigger) =>
      trigger.ability.effects.some((effect) => effect.op === 'dealDamage'),
    );
    expect(damage).toBeDefined();
    const before = playerOf(ctx, 'P2').life;
    pump(executeAbility(ctx, terror, damage!.ability, ['P2' as ObjectId], entering.cardId));
    expect(playerOf(ctx, 'P2').life).toBe(before - 4);
  });
});

describe('Zopandrel, Hunger Dominus', () => {
  const card = pinned('Zopandrel, Hunger Dominus');

  it('zopandrel-doubles-power-and-toughness-until-cleanup', () => {
    const ctx = pod('zopandrel-double');
    const zopandrel = spawn(ctx, 'P1', card);
    const bear = spawn(ctx, 'P1', oracle({ name: 'Zopandrel Bear', power: '2', toughness: '3' }));
    bear.counters['+1/+1'] = 1;
    pump(executeAbility(ctx, zopandrel, interpretCard(card).triggers[0]!, []));
    expect(computeCharacteristics(ctx, bear).power).toBe(6);
    expect(computeCharacteristics(ctx, bear).toughness).toBe(8);
    endUntilEotEffects(ctx);
    expect(computeCharacteristics(ctx, bear).power).toBe(3);
    expect(computeCharacteristics(ctx, bear).toughness).toBe(4);
  });

  it('zopandrel-pays-phyrexian-pips-with-life-and-needs-two-other-creatures', () => {
    const missing = pod('zopandrel-missing');
    playerOf(missing, 'P1').life = 4;
    const alone = spawn(missing, 'P1', card);
    spawn(missing, 'P1', oracle({ name: 'Only One' }));
    expect(activate(missing, alone.id)).toBeUndefined();

    const ctx = pod('zopandrel-activation');
    const player = playerOf(ctx, 'P1');
    player.life = 4;
    const zopandrel = spawn(ctx, 'P1', card);
    const first = spawn(ctx, 'P1', oracle({ name: 'Zopandrel Cost A' }));
    const second = spawn(ctx, 'P1', oracle({ name: 'Zopandrel Cost B' }));
    pump(
      applyPriorityAction(
        ctx,
        player,
        activate(ctx, zopandrel.id)!.payload as PriorityActionPayload,
        {
          index: 0,
          targets: new Map(),
        },
      ),
    );
    expect(player.life).toBe(0);
    expect(ctx.state.battlefield).not.toContain(first);
    expect(ctx.state.battlefield).not.toContain(second);
    pump(resolveTopOfStack(ctx));
    expect(zopandrel.counters['indestructible']).toBe(1);
  });
});
