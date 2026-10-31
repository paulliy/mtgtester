/**
 * Contract tests for the `amass` primitive, started with card:new --primitive: "Amass Orcs 1"
 * (CR 701.47a). With no Army, a 0/0 black Orc Army token is created first; then an Army the
 * controller chooses gets the counters and becomes an Orc if it isn't one. Contract tests may
 * not use the scenario runner (their evidence hashes this file's closure).
 */
import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { deriveCardCapabilities } from '../src/cards/capabilities';
import { EFFECT_REFERENCE_CONTRACTS } from '../src/cards/effect-reference-contracts';
import { interpretCard } from '../src/cards/interpret';
import { spell } from '../src/cards/templates';
import { constant } from '../src/cards/value';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { copies, forest, gameConfig, oracle, pick, pump, pumpStrict, spawn } from './fixtures';

const effect: Effect = { op: 'amass', subtype: 'Orc', count: constant(1) };
const ability = spell({ effects: [effect], description: 'Amass Orcs 1' });

function game(): GameContext {
  return createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(6, forest) })),
      { seed: 'amass-contract' },
    ),
  );
}

const source = (ctx: GameContext) =>
  spawn(ctx, 'P1', oracle({ name: 'Contract Amasser', typeLine: 'Artifact', manaCost: '{1}' }));
const army = (name: string, subtype: string) =>
  oracle({
    name,
    typeLine: `Creature — ${subtype} Army`,
    manaCost: '{1}',
    power: '0',
    toughness: '0',
    subtypes: [subtype, 'Army'],
  });
const armiesOf = (ctx: GameContext, seat: string) =>
  ctx.state.battlefield.filter(
    (perm) =>
      perm.controllerId === seat && computeCharacteristics(ctx, perm).subtypes.includes('Army'),
  );

describe('amass primitive contract', () => {
  it('executes through a real spell or ability, with the engine path', () => {
    const ctx = game();
    pumpStrict(executeAbility(ctx, source(ctx), ability, []));
    const [token] = armiesOf(ctx, 'P1');
    expect(armiesOf(ctx, 'P1')).toHaveLength(1);
    expect(token!.isToken).toBe(true);
    const chars = computeCharacteristics(ctx, token!);
    expect(chars.subtypes).toEqual(['Orc', 'Army']);
    expect(chars.colors).toEqual(['B']);
    expect([chars.power, chars.toughness]).toEqual([1, 1]);

    // A second amass grows the same Army rather than making another.
    pumpStrict(executeAbility(ctx, source(ctx), ability, []));
    expect(armiesOf(ctx, 'P1')).toHaveLength(1);
    expect(token!.counters['+1/+1']).toBe(2);
  });

  it('does nothing it should not: the negative case', () => {
    // An Army of another type is chosen, grows, and becomes an Orc too; no token is made, and
    // the opponent's Army is never offered.
    const ctx = game();
    const zombies = spawn(ctx, 'P1', army('Contract Zombie Army', 'Zombie'));
    const other = spawn(ctx, 'P1', army('Contract Elf Army', 'Elf'));
    spawn(ctx, 'P2', army('Contract Rival Army', 'Orc'));
    const asked: string[][] = [];
    pump(
      executeAbility(ctx, source(ctx), ability, []),
      (decision) => {
        asked.push(decision.options.map((option) => option.description));
        return pick(decision, /Contract Zombie Army/);
      },
      { strict: true },
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]!.join(' | ')).not.toMatch(/Rival/);
    expect(armiesOf(ctx, 'P1')).toHaveLength(2);
    expect(zombies.counters['+1/+1']).toBe(1);
    expect(computeCharacteristics(ctx, zombies).subtypes).toEqual(['Zombie', 'Army', 'Orc']);
    expect(other.counters['+1/+1']).toBeUndefined();
    expect(computeCharacteristics(ctx, other).subtypes).not.toContain('Orc');
  });

  it('validation rejects malformed IR for it', () => {
    const card = interpretCard(
      oracle({ name: 'Contract Card', typeLine: 'Sorcery', manaCost: '{B}' }),
    );
    const withEffect = (candidate: unknown) =>
      validateCardDefinition({
        ...card,
        modeled: true,
        unmodeledReasons: [],
        spellAbility: spell({ effects: [candidate as Effect], description: 'Amass' }),
      });
    expect(withEffect(effect)).toEqual([]);
    expect(withEffect({ op: 'amass', subtype: 'Orc' }).length).toBeGreaterThan(0);
    expect(
      withEffect({ op: 'amass', subtype: 'Orc', count: { kind: 'bogus' } }).length,
    ).toBeGreaterThan(0);
  });

  it('every reference it reads or writes resolves (effect-reference-contracts)', () => {
    // It reads no target slot or earlier result: the Army is chosen on resolution.
    expect(EFFECT_REFERENCE_CONTRACTS.amass).toEqual({});
  });

  it('its capability tag matches what the executor supports', () => {
    const definition = {
      ...interpretCard(oracle({ name: 'Contract Card', typeLine: 'Sorcery', manaCost: '{B}' })),
      spellAbility: ability,
    };
    expect(deriveCardCapabilities(definition)).toContain('Effect.amass');
  });
});
