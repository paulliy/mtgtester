/**
 * The mana capacity bound (`fixedManaCapacity`, `mana/capacity.ts`) lets a priority menu rule out
 * a spell it cannot pay for before it gathers the casting preview's mana sources and searches for
 * a payment. Most priority windows offer only "pass", and that proof was most of their cost.
 *
 * The bound must never rule out a spell the full check offers: these tests sit on each edge of
 * it (exactly enough mana, one short, mana in the pool, a Phyrexian pip, a cost reduction,
 * convoke, a sacrifice source) and pin when it gives up and leaves the verdict to the full check.
 * `MTG_VERIFY_MANA_CAPACITY=1` runs the full check behind every rejection and throws on a
 * disagreement, for fuzz and benchmark runs.
 */
import { describe, expect, it } from 'vitest';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { fixedManaCapacity } from '../src/mana/capacity';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import type { GameContext } from '../src/state/types';
import { engineWork, engineWorkSince } from '../src/work-counters';
import { conjure, copies, forest, gameConfig, island, oracle, spawn } from './fixtures';

/** P2 holds priority on P1's turn, in P1's upkeep, with nothing on the battlefield yet. */
function game(): GameContext {
  const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'beginning';
  ctx.state.step = 'upkeep';
  return ctx;
}

const instant = (name: string, manaCost: string, oracleText = 'You gain 1 life.') =>
  oracle({ name, typeLine: 'Instant', manaCost, oracleText });

const castable = (ctx: GameContext, objectId: string): boolean =>
  computePriorityOptions(ctx, playerById(ctx, 'P2')).some((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });

const lands = (ctx: GameContext, n: number, tapped = false) => {
  for (let i = 0; i < n; i++) spawn(ctx, 'P2', forest(), { tapped });
};

describe('fixedManaCapacity', () => {
  it('counts the pool and each untapped fixed-count source once, at its largest ability', () => {
    const ctx = game();
    lands(ctx, 2);
    lands(ctx, 3, true);
    spawn(
      ctx,
      'P2',
      oracle({ name: 'Two Rock', typeLine: 'Artifact', oracleText: '{T}: Add {C}{C}.' }),
    );
    playerById(ctx, 'P2').manaEntries.push({ symbol: 'G' });
    expect(fixedManaCapacity(ctx, playerById(ctx, 'P2'))).toBe(5);
  });

  it('gives up on a source whose output or availability can change', () => {
    const ctx = game();
    lands(ctx, 2);
    const rock = spawn(
      ctx,
      'P2',
      oracle({ name: 'Counting Rock', typeLine: 'Artifact', oracleText: '{T}: Add {C}.' }),
    );
    ctx.defs.set(rock.oracleId, {
      ...ctx.defs.get(rock.oracleId)!,
      manaAbilities: [{ units: [['C']], amount: { kind: 'const', n: 1 } }],
    });
    expect(fixedManaCapacity(ctx, playerById(ctx, 'P2'))).toBeNull();
  });

  it('gives up on a source that sacrifices instead of tapping, even while tapped', () => {
    const ctx = game();
    lands(ctx, 1);
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Treasure',
        typeLine: 'Artifact — Treasure',
        oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.',
      }),
      { tapped: true },
    );
    expect(fixedManaCapacity(ctx, playerById(ctx, 'P2'))).toBeNull();
  });
});

describe('the priority menu with the capacity bound', () => {
  it('offers a spell with exactly enough mana and rules it out one short', () => {
    const exact = game();
    lands(exact, 3);
    const spell = conjure(exact, 'P2', instant('Three Drop', '{2}{G}'), 'hand');
    expect(castable(exact, spell.id)).toBe(true);

    const short = game();
    lands(short, 2);
    lands(short, 1, true);
    const shortSpell = conjure(short, 'P2', instant('Three Drop', '{2}{G}'), 'hand');
    // Ruled out by the bound: no mana source listing of the preview, no payment search.
    const before = engineWork();
    expect(castable(short, shortSpell.id)).toBe(false);
    const work = engineWorkSince(before);
    expect(work.spellPaymentSearches).toBe(0);
    // The menu lists the player's sources once, for itself; the preview's listing is skipped.
    expect(work.manaSourceListings).toBe(1);
  });

  it('counts mana already in the pool', () => {
    const ctx = game();
    lands(ctx, 2);
    playerById(ctx, 'P2').manaEntries.push({ symbol: 'G' });
    const spell = conjure(ctx, 'P2', instant('Three Drop', '{2}{G}'), 'hand');
    expect(castable(ctx, spell.id)).toBe(true);
  });

  it('leaves a Phyrexian pip to life, so one land short still casts', () => {
    const ctx = game();
    lands(ctx, 1);
    const spell = conjure(ctx, 'P2', instant('Phyrexian Drop', '{1}{G/P}'), 'hand');
    expect(castable(ctx, spell.id)).toBe(true);
  });

  it('applies cost reductions before comparing', () => {
    const ctx = game();
    lands(ctx, 1);
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Medallion',
        typeLine: 'Artifact',
        oracleText: 'Instant and sorcery spells you cast cost {1} less to cast.',
      }),
    );
    const spell = conjure(ctx, 'P2', instant('Two Drop', '{1}{G}'), 'hand');
    expect(castable(ctx, spell.id)).toBe(true);
  });

  it('lets convoke creatures pay where the lands alone cannot', () => {
    const ctx = game();
    for (let i = 0; i < 3; i++)
      spawn(ctx, 'P2', oracle({ name: 'Green Bear', typeLine: 'Creature — Bear', colors: ['G'] }));
    const spell = conjure(
      ctx,
      'P2',
      instant(
        'Convoke Drop',
        '{2}{G}',
        "Convoke (Your creatures can help cast this spell. Each creature you tap while casting this spell pays for {1} or one mana of that creature's color.)\nYou gain 1 life.",
      ),
      'hand',
    );
    expect(castable(ctx, spell.id)).toBe(true);
  });

  it('leaves a sacrifice source to the full check', () => {
    const ctx = game();
    lands(ctx, 1);
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Test Treasure',
        typeLine: 'Artifact — Treasure',
        oracleText: '{T}, Sacrifice this artifact: Add one mana of any color.',
      }),
    );
    const spell = conjure(ctx, 'P2', instant('Two Drop', '{1}{G}'), 'hand');
    expect(castable(ctx, spell.id)).toBe(true);
  });

  it('leaves a board where a tap restores another source to the full check', () => {
    // Found in review (Codex on #86): while the artifact is untapped, lands P2 controls lose all
    // abilities, so before any tap only its {G} is visible. Tapping it for {G} gives the Island
    // back its {U}, and life pays the Phyrexian pip. Counting what is visible now ruled out a
    // spell the payment search can pay for.
    const ctx = game();
    spawn(ctx, 'P2', island());
    const suppressor = spawn(
      ctx,
      'P2',
      oracle({
        name: 'Suppressor',
        typeLine: 'Artifact',
        oracleText: '{T}: Add {G}. You gain 1 life.',
      }),
    );
    ctx.defs.set(suppressor.oracleId, {
      ...ctx.defs.get(suppressor.oracleId)!,
      staticEffects: [
        {
          affects: {
            kind: 'allOf',
            of: [
              { kind: 'type', value: 'Land' },
              { kind: 'controller', who: 'you' },
            ],
          },
          op: { layer: 6, loseAllAbilities: true },
          condition: { kind: 'isUntapped' },
        },
      ],
    });
    expect(fixedManaCapacity(ctx, playerById(ctx, 'P2'))).toBeNull();
    const spell = conjure(ctx, 'P2', instant('Hybrid Drop', '{G}{U}{G/P}'), 'hand');
    expect(castable(ctx, spell.id)).toBe(true);
  });

  it('counts a mana ability that works from the hand', () => {
    // Found in review (Codex on #86): with no lands, a card that exiles itself from the hand for
    // {R} pays for a {R} instant. Counting only the pool and the battlefield ruled it out.
    const ctx = game();
    conjure(
      ctx,
      'P2',
      oracle({
        name: 'Hand Guide',
        typeLine: 'Creature — Ape Spirit',
        manaCost: '{2}{R}',
        oracleText: 'Exile this card from your hand: Add {R}.',
      }),
      'hand',
    );
    const spell = conjure(ctx, 'P2', instant('Red Drop', '{R}'), 'hand');
    expect(fixedManaCapacity(ctx, playerById(ctx, 'P2'))).toBe(1);
    expect(castable(ctx, spell.id)).toBe(true);
  });
});
