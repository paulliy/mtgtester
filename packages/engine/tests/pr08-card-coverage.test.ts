/** PR08's pin and containment gate; behavior tests accompany each restored card below. */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { addMana } from '../src/mana/pool';
import { playerById, moveObject } from '../src/state/objects';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { runPrioritySequence } from '../src/turn/priority';
import { cleanupStep } from '../src/turn/turn';
import { computeCharacteristics } from '../src/effects/continuous';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface Pin {
  sha256: string;
  card: OracleCard;
}
const pins = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
  ) as { cards: Pin[] }
).cards;
// Move a card into this set only with its complete behavioral tests and lab requirements.
const IMPLEMENTED = new Set<string>([
  'Mob Rule',
  'Cut a Deal',
  'Cytoplast Manipulator',
  'Humble Defector',
  'Druid of Purification',
  'Wishclaw Talisman',
  'Akroan Horse',
  'Reins of Power',
]);
function canonical(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonical);
  if (input !== null && typeof input === 'object')
    return Object.fromEntries(
      Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [key, canonical(value)]),
    );
  return input;
}

describe('PR08 Oracle pins and containment', () => {
  it('maps each implemented card to Oracle clauses, behavioral tests and real viewer scenarios', () => {
    const manifest = JSON.parse(
      readFileSync(resolve('packages/server/fixtures/card-verification-manifest.json'), 'utf8'),
    ) as {
      cards: Record<
        string,
        {
          oracleSha256: string;
          clauses: {
            id: string;
            oracleText: string;
            implementation: string[];
            engineTestIds: string[];
            viewerScenarioIds: string[];
          }[];
        }
      >;
    };
    const source = readdirSync(import.meta.dirname)
      .filter((name) => /^pr08.*\.test\.ts$/.test(name))
      .map((name) => readFileSync(join(import.meta.dirname, name), 'utf8'))
      .join('\n');
    const viewerSource = readFileSync(
      resolve('packages/server/src/cards/card-test-scenarios.ts'),
      'utf8',
    );
    for (const pin of pins.filter((pin) => IMPLEMENTED.has(pin.card.name))) {
      const card = manifest.cards[pin.card.oracleId];
      expect(card?.oracleSha256, pin.card.name).toBe(pin.sha256);
      expect(card?.clauses.length, pin.card.name).toBeGreaterThan(0);
      for (const clause of card!.clauses) {
        expect(pin.card.oracleText, clause.id).toContain(clause.oracleText);
        expect(clause.implementation.length, clause.id).toBeGreaterThan(0);
        expect(clause.engineTestIds.length, clause.id).toBeGreaterThan(0);
        expect(clause.viewerScenarioIds.length, clause.id).toBeGreaterThan(0);
        for (const id of clause.engineTestIds) expect(source, id).toContain(`${id} —`);
        for (const id of clause.viewerScenarioIds)
          expect(
            viewerSource +
              readFileSync(resolve('packages/server/src/cards/pr08-scenario-catalog.ts'), 'utf8'),
            id,
          ).toContain(id);
      }
    }
  });
  it('pins exactly the 23 distinct cards assigned to PR08', () => {
    expect(pins).toHaveLength(23);
    expect(new Set(pins.map((pin) => pin.card.oracleId)).size).toBe(23);
  });
  it.each(pins.map((pin) => [pin.card.name, pin] as const))(
    '%s retains its Oracle pin and explicit implementation status',
    (name, pin) => {
      expect(
        createHash('sha256')
          .update(JSON.stringify(canonical(pin.card)))
          .digest('hex'),
      ).toBe(pin.sha256);
      for (const card of [pin.card, { ...pin.card, oracleId: fixtureOracleId(name) }]) {
        const def = interpretCard(card);
        expect(def.modeled, card.oracleId).toBe(IMPLEMENTED.has(name));
        if (IMPLEMENTED.has(name)) expect(def.unmodeledReasons).toEqual([]);
        else expect(def.unmodeledReasons.length).toBeGreaterThan(0);
      }
    },
  );
});

function pinned(name: string): OracleCard {
  const pin = pins.find((entry) => entry.card.name === name);
  if (!pin) throw new Error(`Missing PR08 pin: ${name}`);
  return pin.card;
}

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
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

function castMobRule(ctx: GameContext, mode: number, beforeResolve?: () => void): void {
  const card = conjure(ctx, 'P1', pinned('Mob Rule'), 'hand');
  addMana(
    playerById(ctx, 'P1'),
    Array.from({ length: 6 }, (_, i) => ({ symbol: i < 2 ? ('R' as const) : ('C' as const) })),
  );
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return (
      payload.kind === 'castSpell' &&
      payload.objectId === card.id &&
      (payload.mode === mode || payload.modes?.[0] === mode)
    );
  });
  expect(option, `normal Mob Rule mode ${mode}`).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  beforeResolve?.();
  pump(runPrioritySequence(ctx), (decision) => ({
    index: Math.max(
      0,
      decision.options.findIndex((candidate) => candidate.type === 'pass'),
    ),
    targets: new Map(),
  }));
  expect(ctx.state.stack).toHaveLength(0);
}

const creature = (name: string, power: number, text = '') =>
  oracle({
    name,
    typeLine: 'Creature — Bear',
    power: String(power),
    toughness: '8',
    oracleText: text,
  });

describe('Mob Rule (PR08.08)', () => {
  it('mob-rule-resolution-set — power is checked at resolution, after responses, rather than when the mode was announced', () => {
    const ctx = pod('mob-rule-resolution-set');
    const small = spawn(ctx, 'P2', creature('Growing witness', 3));
    castMobRule(ctx, 0, () => {
      expect(small.controllerId).toBe('P2');
      small.counters['+1/+1'] = 1;
    });
    expect(small.controllerId).toBe('P1');
    expect(computeCharacteristics(ctx, small).keywords).toContain('haste');
  });

  it('mob-rule-new-object — a creature that leaves and returns does not retain the old control or haste grant', () => {
    const ctx = pod('mob-rule-new-object');
    const old = spawn(ctx, 'P2', creature('Blinking witness', 4));
    castMobRule(ctx, 0);
    expect(old.controllerId).toBe('P1');
    const hand = pump(moveObject(ctx, old, { zone: 'hand' })).value;
    expect(hand).not.toBeNull();
    const returned = pump(
      moveObject(ctx, hand!, { zone: 'battlefield', controllerId: 'P2' }),
    ).value;
    if (!returned || returned.zone !== 'battlefield' || !('controllerId' in returned))
      throw new Error('Witness did not return');
    expect(returned.id).not.toBe(old.id);
    expect(returned.controllerId).toBe('P2');
    expect(computeCharacteristics(ctx, returned).keywords).not.toContain('haste');
  });
  it('mob-rule-cost-and-timing — requires six mana and normal sorcery timing and offers two untargeted modes', () => {
    const ctx = pod('mob-rule-cost-and-timing');
    const card = conjure(ctx, 'P1', pinned('Mob Rule'), 'hand');
    const player = playerById(ctx, 'P1');
    const casts = () =>
      computePriorityOptions(ctx, player).filter((candidate) => {
        const payload = candidate.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.objectId === card.id;
      });
    addMana(
      player,
      Array.from({ length: 5 }, () => ({ symbol: 'R' as const })),
    );
    expect(casts()).toHaveLength(0);
    addMana(player, [{ symbol: 'R' }]);
    expect(casts()).toHaveLength(2);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(casts()).toHaveLength(0);
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'combat';
    expect(casts()).toHaveLength(0);
  });
  it.each([0, 1])(
    'mob-rule-normal-cast-modes — mode %i steals exactly its power range, untaps your own creatures too, and expires at cleanup',
    (mode) => {
      const ctx = pod(`mob-rule-mode-${mode}`);
      const own = spawn(ctx, 'P1', creature('Own witness', mode === 0 ? 4 : 3));
      const small = spawn(ctx, 'P2', creature('Small witness', 3));
      const large = spawn(ctx, 'P3', creature('Large witness', 4));
      for (const permanent of [own, small, large]) {
        permanent.tapped = true;
        permanent.summoningSick = false;
      }
      castMobRule(ctx, mode);
      const stolen = mode === 0 ? large : small;
      const untouched = mode === 0 ? small : large;
      expect(stolen.controllerId).toBe('P1');
      expect(stolen.summoningSick).toBe(true);
      expect(stolen.tapped).toBe(false);
      expect(own.tapped).toBe(false);
      expect(own.summoningSick).toBe(false);
      expect(computeCharacteristics(ctx, stolen).keywords).toContain('haste');
      expect(computeCharacteristics(ctx, own).keywords).toContain('haste');
      expect(untouched.controllerId).not.toBe('P1');
      expect(untouched.tapped).toBe(true);
      expect(computeCharacteristics(ctx, untouched).keywords).not.toContain('haste');
      pump(cleanupStep(ctx));
      expect(small.controllerId).toBe('P2');
      expect(large.controllerId).toBe('P3');
      expect(computeCharacteristics(ctx, stolen).keywords).not.toContain('haste');
    },
  );

  it('mob-rule-frozen-set — control-dependent power changes do not change the stolen, untapped or haste-granted set', () => {
    const ctx = pod('mob-rule-frozen-set');
    const own = spawn(ctx, 'P1', creature('Initially small own creature', 2));
    const lord = spawn(ctx, 'P2', creature('Power lord', 3, 'Creatures you control get +2/+2.'));
    const other = spawn(ctx, 'P2', creature('Initially large opposing creature', 2));
    own.tapped = lord.tapped = other.tapped = true;
    expect(computeCharacteristics(ctx, other).power).toBe(4);
    castMobRule(ctx, 0);
    expect(lord.controllerId).toBe('P1');
    expect(other.controllerId).toBe('P1');
    expect(other.tapped).toBe(false);
    expect(computeCharacteristics(ctx, other).keywords).toContain('haste');
    expect(computeCharacteristics(ctx, own).power).toBe(4);
    expect(own.tapped).toBe(true);
    expect(computeCharacteristics(ctx, own).keywords).not.toContain('haste');
    pump(moveObject(ctx, lord, { zone: 'graveyard' }));
    expect(computeCharacteristics(ctx, other).power).toBe(2);
    expect(other.controllerId).toBe('P1');
    const late = spawn(ctx, 'P2', creature('Late large creature', 5));
    expect(late.controllerId).toBe('P2');
    expect(computeCharacteristics(ctx, late).keywords).not.toContain('haste');
  });
});
