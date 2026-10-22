import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { resolveTopOfStack } from '../src/stack/stack';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { moveObject } from '../src/state/objects';
import type { GameContext, EnginePlayerState } from '../src/state/types';
import { copies, conjure, gameConfig, oracle, pump, spawn } from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
const pinned = fixture.cards.find(({ card }) => card.name === 'Chaos Warp');
if (pinned === undefined) throw new Error('Chaos Warp is missing from the pinned PR09 oracle');
if (createHash('sha256').update(JSON.stringify(pinned.card)).digest('hex') !== pinned.sha256) {
  throw new Error('Chaos Warp PR09 oracle pin hash mismatch');
}

const chaosWarp = pinned.card;
const permanent = (name: string, typeLine = 'Artifact') => oracle({ name, typeLine });
const nonpermanent = (name: string) => oracle({ name, typeLine: 'Instant' });

function setup(
  options: {
    seed?: string;
    mana?: 'enough' | 'noRed' | 'short';
    owner?: 'P1' | 'P2';
  } = {},
) {
  const ctx = createGame(
    gameConfig(
      [
        { id: 'P1', cards: copies(8, () => oracle({ name: 'P1 starter' })) },
        { id: 'P2', cards: copies(8, () => oracle({ name: 'P2 starter' })) },
      ],
      { seed: options.seed ?? 'pr09-chaos-default' },
    ),
  );
  const caster = player(ctx, 'P1');
  const ownerId = options.owner ?? 'P2';
  for (const p of ctx.state.players) p.library.length = 0;
  const spell = conjure(ctx, 'P1', chaosWarp, 'hand');
  const target = spawn(ctx, ownerId, permanent('Warp Target'));
  const top = conjure(ctx, ownerId, nonpermanent('Warp Top'), 'library');
  const tail = conjure(ctx, ownerId, permanent('Warp Tail'), 'library');
  // `conjure` puts each card on top; set an explicit, readable seeded starting order.
  player(ctx, ownerId).library = [top, tail];
  if (options.mana === 'enough' || options.mana === undefined) {
    addMana(caster, [{ symbol: 'R' }, { symbol: 'C' }, { symbol: 'C' }]);
  } else if (options.mana === 'noRed') {
    addMana(caster, [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
  } else {
    addMana(caster, [{ symbol: 'R' }, { symbol: 'C' }]);
  }
  return { ctx, caster, ownerId, spell, target, top, tail };
}

function player(ctx: GameContext, id: string): EnginePlayerState {
  const found = ctx.state.players.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`Missing player ${id}`);
  return found;
}

function castWarp(ctx: GameContext, caster: EnginePlayerState, spellId: string, targetId: string) {
  const option = computePriorityOptions(ctx, caster).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return (
      candidate.type === 'castSpell' && payload.kind === 'castSpell' && payload.objectId === spellId
    );
  });
  if (option === undefined) throw new Error('Chaos Warp cast action was not offered');
  pump(
    applyPriorityAction(ctx, caster, option.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, targetId]]),
    }),
  );
}

function resolveWarp(ctx: GameContext) {
  pump(resolveTopOfStack(ctx));
}

describe('Chaos Warp — pinned PR09 behavior', () => {
  it('pr09-chaos-target-domain — accepts permanent types and excludes players', () => {
    for (const [typeLine, name] of [
      ['Creature — Bear', 'Warp Creature'],
      ['Artifact', 'Warp Artifact'],
      ['Enchantment', 'Warp Enchantment'],
      ['Land', 'Warp Land'],
      ['Planeswalker — Jace', 'Warp Planeswalker'],
    ] as const) {
      const { ctx, caster, spell } = setup();
      const target = spawn(ctx, 'P2', permanent(name, typeLine));
      expect(() => castWarp(ctx, caster, spell.id, target.id)).not.toThrow();
    }
    const { ctx } = setup();
    const def = ctx.defs.get(chaosWarp.oracleId);
    expect(def?.spellAbility?.targets?.[0]?.kind).toBe('permanent');
    expect(def?.spellAbility?.targets?.[0]?.kind).not.toBe('player');
  });

  it('pr09-chaos-reveal-nonpermanent — publicly reveals the shuffled top nonpermanent and leaves it in the library', () => {
    let selectedSeed: string | undefined;
    for (let index = 0; index < 100; index += 1) {
      const trialSeed = `chaos-nonpermanent-${index}`;
      const trial = setup({ seed: trialSeed });
      castWarp(trial.ctx, trial.caster, trial.spell.id, trial.target.id);
      resolveWarp(trial.ctx);
      if (
        trial.ctx.state.eventLog.some(
          (event) => event.type === 'revealCard' && event.payload['name'] === trial.top.name,
        )
      ) {
        selectedSeed = trialSeed;
        break;
      }
    }
    // Rebuild under the selected seed so the assertion covers the actual run's PRNG stream.
    const run = setup({ seed: selectedSeed ?? 'chaos-nonpermanent-fallback' });
    castWarp(run.ctx, run.caster, run.spell.id, run.target.id);
    resolveWarp(run.ctx);
    const revealed = run.ctx.state.eventLog.filter((event) => event.type === 'revealCard');
    expect(revealed.map((event) => event.payload['name'])).toContain(run.top.name);
    expect(run.ownerId).toBe('P2');
    expect(player(run.ctx, run.ownerId).library[0]?.cardId).toBe(run.top.cardId);
    expect(player(run.ctx, run.ownerId).hand.some((card) => card.cardId === run.top.cardId)).toBe(
      false,
    );
    expect(run.ctx.state.eventLog.some((event) => event.type === 'draw')).toBe(false);
    expect(selectedSeed).toBeDefined();
  });

  it('pr09-chaos-permanent-result — puts a revealed permanent onto the battlefield under its owner', () => {
    let selectedSeed: string | undefined;
    for (let index = 0; index < 100; index += 1) {
      const trial = setup({ seed: `chaos-permanent-result-${index}` });
      const result = conjure(trial.ctx, trial.ownerId, permanent('Warp Result'), 'library');
      player(trial.ctx, trial.ownerId).library = [result];
      castWarp(trial.ctx, trial.caster, trial.spell.id, trial.target.id);
      resolveWarp(trial.ctx);
      if (trial.ctx.state.battlefield.some((object) => object.cardId === result.cardId)) {
        selectedSeed = `chaos-permanent-result-${index}`;
        break;
      }
    }
    expect(selectedSeed).toBeDefined();
    const { ctx, caster, ownerId, spell, target } = setup({ seed: selectedSeed! });
    const result = conjure(ctx, ownerId, permanent('Warp Result'), 'library');
    player(ctx, ownerId).library = [result];
    castWarp(ctx, caster, spell.id, target.id);
    resolveWarp(ctx);
    expect(ctx.state.battlefield.some((object) => object.cardId === result.cardId)).toBe(true);
    expect(
      ctx.state.battlefield.find((object) => object.cardId === result.cardId)?.controllerId,
    ).toBe(ownerId);
  });

  it('pr09-chaos-token-target — a token ceases instead of returning as a library card', () => {
    const { ctx, caster, spell } = setup();
    const token = spawn(ctx, 'P2', permanent('Warp Token'), { isToken: true });
    castWarp(ctx, caster, spell.id, token.id);
    resolveWarp(ctx);
    expect(player(ctx, 'P2').library.some((card) => card.cardId === token.cardId)).toBe(false);
    expect(ctx.state.battlefield.some((object) => object.cardId === token.cardId)).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'tokenCeased')).toBe(true);
    expect(player(ctx, 'P1').graveyard.some((card) => card.cardId === spell.cardId)).toBe(true);
  });

  it('pr09-chaos-fizzle — if the only target leaves before resolution, no shuffle or reveal occurs', () => {
    const { ctx, caster, spell, target } = setup();
    castWarp(ctx, caster, spell.id, target.id);
    pump(moveObject(ctx, target, { zone: 'exile' }));
    const before = [...player(ctx, 'P2').library];
    const revealCount = ctx.state.eventLog.filter((event) => event.type === 'revealCard').length;
    resolveWarp(ctx);
    expect(player(ctx, 'P2').library).toEqual(before);
    expect(ctx.state.eventLog.filter((event) => event.type === 'revealCard')).toHaveLength(
      revealCount,
    );
    expect(player(ctx, 'P1').graveyard.some((card) => card.cardId === spell.cardId)).toBe(true);
  });

  it('pr09-chaos-empty-library-token — token target with an empty owner library does not draw or lose', () => {
    const { ctx, caster, spell } = setup();
    const token = spawn(ctx, 'P2', permanent('Empty Library Token'), { isToken: true });
    player(ctx, 'P2').library.length = 0;
    castWarp(ctx, caster, spell.id, token.id);
    resolveWarp(ctx);
    expect(player(ctx, 'P2').library).toHaveLength(0);
    expect(player(ctx, 'P2').hasLost).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'draw')).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
  });

  it('pr09-chaos-commander-choice — owner may redirect a commander to command while still shuffling and revealing', () => {
    let selectedSeed: string | undefined;
    for (let index = 0; index < 100; index += 1) {
      const trial = setup({ seed: `chaos-commander-${index}` });
      const first = trial.top;
      const second = conjure(
        trial.ctx,
        trial.ownerId,
        nonpermanent('Warp Commander Tail'),
        'library',
      );
      const third = conjure(
        trial.ctx,
        trial.ownerId,
        nonpermanent('Warp Commander Third'),
        'library',
      );
      const library = player(trial.ctx, trial.ownerId);
      library.library = [first, second, third];
      const original = library.library.map((card) => card.cardId);
      const predicted = [...original];
      trial.ctx.rng.clone().shuffle(predicted);
      if (
        predicted[0] === first.cardId &&
        predicted.some((id, position) => id !== original[position])
      ) {
        selectedSeed = `chaos-commander-${index}`;
        break;
      }
    }
    expect(selectedSeed).toBeDefined();
    const { ctx, caster, ownerId, spell } = setup({ seed: selectedSeed! });
    const commander = spawn(ctx, ownerId, permanent('Warp Commander'), { isCommander: true });
    const revealed = conjure(ctx, ownerId, nonpermanent('Warp Commander Reveal'), 'library');
    const tail = conjure(ctx, ownerId, nonpermanent('Warp Commander Tail'), 'library');
    const third = conjure(ctx, ownerId, nonpermanent('Warp Commander Third'), 'library');
    player(ctx, ownerId).library = [revealed, tail, third];
    const expected = [revealed.cardId, tail.cardId, third.cardId];
    ctx.rng.clone().shuffle(expected);
    castWarp(ctx, caster, spell.id, commander.id);
    const result = pump(resolveTopOfStack(ctx), () => ({ index: 0, targets: new Map() }));
    expect(
      result.decisions.some((decision) => decision.decisionType === 'commanderReplacement'),
    ).toBe(true);
    expect(player(ctx, ownerId).commandZone.some((card) => card.cardId === commander.cardId)).toBe(
      true,
    );
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
    expect(player(ctx, ownerId).library.some((card) => card.cardId === commander.cardId)).toBe(
      false,
    );
    expect(player(ctx, ownerId).library.map((card) => card.cardId)).toEqual(expected);
    expect(player(ctx, ownerId).library[0]?.cardId).toBe(revealed.cardId);
  });

  it('pr09-chaos-blink-incarnation — a blinked target incarnation is not affected by the old target reference', () => {
    const { ctx, caster, spell, target } = setup();
    castWarp(ctx, caster, spell.id, target.id);
    pump(moveObject(ctx, target, { zone: 'exile' }));
    const returned = pump(
      moveObject(
        ctx,
        ctx.state.exile.find((card) => card.cardId === target.cardId)!,
        {
          zone: 'battlefield',
          controllerId: 'P2',
        },
      ),
    ).value;
    const before = [...player(ctx, 'P2').library];
    resolveWarp(ctx);
    expect(ctx.state.battlefield.some((object) => object.id === returned?.id)).toBe(true);
    expect(player(ctx, 'P2').library).toEqual(before);
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
  });

  it('pr09-chaos-seeded-repeatability — identical seeded casts produce identical shuffle and reveal results', () => {
    const run = (seed: string) => {
      const { ctx, caster, ownerId, spell, target } = setup({ seed });
      const owner = player(ctx, ownerId);
      owner.library.length = 0;
      const cards = [
        conjure(ctx, ownerId, nonpermanent('Repeat Instant'), 'library'),
        conjure(ctx, ownerId, permanent('Repeat Artifact'), 'library'),
        conjure(ctx, ownerId, permanent('Repeat Land', 'Land'), 'library'),
      ];
      owner.library = cards;
      castWarp(ctx, caster, spell.id, target.id);
      resolveWarp(ctx);
      return {
        library: owner.library.map((card) => card.name),
        battlefield: ctx.state.battlefield.map((object) => object.name),
        reveals: ctx.state.eventLog
          .filter((event) => event.type === 'revealCard')
          .map((event) => event.payload['name']),
      };
    };
    expect(run('pr09-chaos-repeat')).toEqual(run('pr09-chaos-repeat'));
  });
});
