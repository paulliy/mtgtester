import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { PendingDecision } from '../src/decisions';
import type { Effect } from '../src/cards/ability';
import { computePriorityOptions } from '../src/actions/legal';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { registerWhiteBlackControlHandOverrides } from '../src/cards/overrides/white-black-control-hand';
import { constant } from '../src/cards/value';
import { createGame } from '../src/state/game';
import type { EnginePlayerState, GameContext } from '../src/state/types';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { copies, conjure, gameConfig, oracle, pick, pump, spawn, swamp } from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/white-black-control-oracle.json'), 'utf8'),
) as { cards: PinnedCard[] };

function pinned(name: string): OracleCard {
  const entry = fixture.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
  return entry.card;
}

const duress = pinned('Duress');
const thoughtseize = pinned('Thoughtseize');
const darkConfidant = pinned('Dark Confidant');

// Install local replacements while the root override registry is not yet wired to this file.
if (![duress, thoughtseize, darkConfidant].every((card) => interpretCard(card).modeled))
  registerWhiteBlackControlHandOverrides();

function pod(seed = 'white-black-control-hand'): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, swamp) })),
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

function player(ctx: GameContext, id: string): EnginePlayerState {
  const result = ctx.state.players.find((candidate) => candidate.id === id);
  if (result === undefined) throw new Error(`Missing player ${id}`);
  return result;
}

function handCard(name: string, typeLine = 'Sorcery', manaCost: string | null = '{1}'): OracleCard {
  return oracle({ name, typeLine, manaCost, power: null, toughness: null });
}

function castAndResolve(
  ctx: GameContext,
  card: OracleCard,
  targetId?: string,
  chooseCard?: (decision: PendingDecision) => number | undefined,
): void {
  spawn(ctx, 'P1', swamp());
  conjure(ctx, 'P1', card, 'hand');
  let cast = false;
  pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority' && decision.player === 'P1' && !cast) {
      const index = decision.options.findIndex(
        (option) => option.type === 'castSpell' && option.description.includes(card.name),
      );
      if (index >= 0) {
        cast = true;
        return {
          index,
          targets: targetId === undefined ? new Map() : new Map([[0, targetId]]),
        };
      }
    }
    if (decision.decisionType === 'priority') return pick(decision, /Pass|does not/i);
    const selected = chooseCard?.(decision);
    return { index: selected ?? 0, targets: new Map() };
  });
  expect(cast, `cast ${card.name} from hand through priority`).toBe(true);
}

function castPermanent(ctx: GameContext, card: OracleCard): void {
  spawn(ctx, 'P1', swamp());
  spawn(ctx, 'P1', swamp());
  conjure(ctx, 'P1', card, 'hand');
  let cast = false;
  pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority' && decision.player === 'P1' && !cast) {
      const index = decision.options.findIndex(
        (option) => option.type === 'castSpell' && option.description.includes(card.name),
      );
      if (index >= 0) {
        cast = true;
        return { index, targets: new Map() };
      }
    }
    if (decision.decisionType === 'priority') return pick(decision, /Pass|does not/i);
    return { index: 0, targets: new Map() };
  });
  expect(cast, `cast ${card.name} from hand through priority`).toBe(true);
  expect(ctx.state.battlefield.some((permanent) => permanent.name === card.name)).toBe(true);
}

describe('white-black-control hand spells', () => {
  it('casts Duress, reveals every card, and lets its controller choose only a noncreature, nonland card', () => {
    const ctx = pod();
    player(ctx, 'P2').life = 40;
    const creature = handCard('Duress Creature', 'Creature — Soldier', '{1}{W}');
    const land = handCard('Duress Land', 'Basic Land — Forest', null);
    const eligibleEnchantment = handCard('Duress Eligible Enchantment', 'Enchantment', '{1}{B}');
    const eligibleArtifact = handCard('Duress Eligible Artifact', 'Artifact', '{2}');
    for (const card of [creature, land, eligibleEnchantment, eligibleArtifact])
      conjure(ctx, 'P2', card, 'hand');

    const seenChoiceNames: string[][] = [];
    castAndResolve(ctx, duress, 'P2', (decision) => {
      if (!decision.prompt.includes("P2's revealed hand")) return undefined;
      expect(decision.player).toBe('P1');
      const names = decision.options.map((option) => option.description.replace(/^Discard /, ''));
      seenChoiceNames.push(names);
      expect(names).toEqual(['Duress Eligible Enchantment', 'Duress Eligible Artifact']);
      return decision.options.findIndex((option) =>
        option.description.includes('Duress Eligible Artifact'),
      );
    });

    expect(seenChoiceNames).toHaveLength(1);
    expect(
      ctx.state.eventLog
        .filter((event) => event.type === 'revealCard')
        .map((event) => event.payload['name']),
    ).toEqual([
      'Duress Creature',
      'Duress Land',
      'Duress Eligible Enchantment',
      'Duress Eligible Artifact',
    ]);
    expect(player(ctx, 'P2').graveyard.map((card) => card.name)).toEqual([
      'Duress Eligible Artifact',
    ]);
    expect(player(ctx, 'P2').hand.map((card) => card.name)).toEqual([
      'Duress Creature',
      'Duress Land',
      'Duress Eligible Enchantment',
    ]);
    expect(player(ctx, 'P2').life).toBe(40);
  });

  it('Duress reveals an empty hand without asking for a discard', () => {
    const ctx = pod();
    castAndResolve(ctx, duress, 'P2');

    expect(player(ctx, 'P2').hand).toHaveLength(0);
    expect(player(ctx, 'P2').graveyard).toHaveLength(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'resolved')).toBe(true);
  });

  it('Duress cannot target its caster', () => {
    const ctx = pod();
    spawn(ctx, 'P1', swamp());
    const spell = conjure(ctx, 'P1', duress, 'hand');
    const action = computePriorityOptions(ctx, player(ctx, 'P1')).find(
      (option) =>
        option.type === 'castSpell' &&
        (option.payload as { objectId?: string }).objectId === spell.id,
    );

    expect(action?.targets?.[0]?.options).toEqual(['P2', 'P3', 'P4']);
  });

  it('Duress reveals a creature-and-land-only hand but offers no discard choice', () => {
    const ctx = pod();
    conjure(ctx, 'P2', handCard('Only Creature', 'Creature — Soldier', '{1}{W}'), 'hand');
    conjure(ctx, 'P2', handCard('Only Land', 'Basic Land — Forest', null), 'hand');
    const prompts: string[] = [];
    castAndResolve(ctx, duress, 'P2', (decision) => {
      prompts.push(decision.prompt);
      return undefined;
    });

    expect(prompts.some((prompt) => prompt.includes("P2's revealed hand"))).toBe(false);
    expect(
      ctx.state.eventLog
        .filter((event) => event.type === 'revealCard')
        .map((event) => event.payload['name']),
    ).toEqual(['Only Creature', 'Only Land']);
    expect(player(ctx, 'P2').hand.map((card) => card.name)).toEqual(['Only Creature', 'Only Land']);
    expect(player(ctx, 'P2').graveyard).toHaveLength(0);
  });

  it('casts Thoughtseize and loses two life even when the target has no nonland card', () => {
    const ctx = pod();
    player(ctx, 'P1').life = 40;
    const land = handCard('Thoughtseize Only Land', 'Basic Land — Swamp', null);
    conjure(ctx, 'P2', land, 'hand');

    castAndResolve(ctx, thoughtseize, 'P2');

    expect(player(ctx, 'P1').life).toBe(38);
    expect(player(ctx, 'P2').hand.map((card) => card.name)).toEqual(['Thoughtseize Only Land']);
    expect(player(ctx, 'P2').graveyard).toHaveLength(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Thoughtseize can choose and discard a creature from the target player’s hand', () => {
    const ctx = pod();
    player(ctx, 'P1').life = 40;
    const creature = handCard('Thoughtseize Creature', 'Creature — Wizard', '{1}{B}');
    conjure(ctx, 'P2', creature, 'hand');
    conjure(ctx, 'P2', handCard('Thoughtseize Reserve', 'Artifact', '{2}'), 'hand');

    castAndResolve(ctx, thoughtseize, 'P2', (decision) => {
      if (!decision.prompt.includes("P2's revealed hand")) return undefined;
      expect(decision.options.map((option) => option.description)).toContain(
        'Discard Thoughtseize Creature',
      );
      return decision.options.findIndex((option) =>
        option.description.includes('Thoughtseize Creature'),
      );
    });

    expect(player(ctx, 'P1').life).toBe(38);
    expect(player(ctx, 'P2').graveyard.map((card) => card.name)).toEqual(['Thoughtseize Creature']);
    expect(player(ctx, 'P2').hand.map((card) => card.name)).toEqual(['Thoughtseize Reserve']);
  });

  it('Thoughtseize may target its controller and discard from their own hand', () => {
    const ctx = pod();
    player(ctx, 'P1').life = 40;
    conjure(ctx, 'P1', handCard('Thoughtseize Self Card', 'Artifact', '{2}'), 'hand');

    castAndResolve(ctx, thoughtseize, 'P1', (decision) => {
      if (!decision.prompt.includes("P1's revealed hand")) return undefined;
      expect(decision.options.map((option) => option.description)).toContain(
        'Discard Thoughtseize Self Card',
      );
      return decision.options.findIndex((option) =>
        option.description.includes('Thoughtseize Self Card'),
      );
    });

    expect(player(ctx, 'P1').life).toBe(38);
    expect(player(ctx, 'P1').graveyard.map((card) => card.name)).toContain(
      'Thoughtseize Self Card',
    );
  });
});

describe('Dark Confidant upkeep reveal', () => {
  it('reveals and puts the top card into hand, loses its mana value, and does not draw', () => {
    const ctx = pod();
    player(ctx, 'P1').life = 40;
    castPermanent(ctx, darkConfidant);
    const confidant = ctx.state.battlefield.find(
      (permanent) => permanent.name === darkConfidant.name,
    )!;
    const top = handCard('Confidant Reveal', 'Artifact', '{2}{B}');
    player(ctx, 'P1').library.splice(0);
    conjure(ctx, 'P1', top, 'library');
    const cardsDrawnBefore = player(ctx, 'P1').cardsDrawnThisTurn;

    ctx.state.step = 'upkeep';
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));

    expect(player(ctx, 'P1').hand.map((card) => card.name)).toEqual(['Confidant Reveal']);
    expect(player(ctx, 'P1').life).toBe(37);
    expect(player(ctx, 'P1').cardsDrawnThisTurn).toBe(cardsDrawnBefore);
    expect(ctx.state.eventLog.filter((event) => event.type === 'revealCard')).toHaveLength(1);
    expect(ctx.state.eventLog.some((event) => event.type === 'draw')).toBe(false);
    expect(ctx.state.players.find((candidate) => candidate.id === 'P1')?.hasLost).toBe(false);
    expect(ctx.state.battlefield).toContain(confidant);
  });

  it('does nothing with an empty library and does not lose the game', () => {
    const ctx = pod();
    player(ctx, 'P1').life = 40;
    castPermanent(ctx, darkConfidant);
    const confidant = ctx.state.battlefield.find(
      (permanent) => permanent.name === darkConfidant.name,
    )!;
    player(ctx, 'P1').library.splice(0);
    const cardsDrawnBefore = player(ctx, 'P1').cardsDrawnThisTurn;

    ctx.state.step = 'upkeep';
    queueStepTriggers(ctx, 'upkeep');
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));

    expect(player(ctx, 'P1').life).toBe(40);
    expect(player(ctx, 'P1').hand).toHaveLength(0);
    expect(player(ctx, 'P1').cardsDrawnThisTurn).toBe(cardsDrawnBefore);
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
    expect(ctx.state.eventLog.some((event) => event.type === 'draw')).toBe(false);
    expect(player(ctx, 'P1').hasLost).toBe(false);
    expect(ctx.state.battlefield).toContain(confidant);
  });

  it('does not trigger during an opponent’s upkeep', () => {
    const ctx = pod();
    player(ctx, 'P1').life = 40;
    castPermanent(ctx, darkConfidant);
    player(ctx, 'P1').library.splice(0);
    conjure(ctx, 'P1', handCard('Opponent Upkeep Top', 'Artifact', '{3}'), 'library');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    ctx.state.step = 'upkeep';

    queueStepTriggers(ctx, 'upkeep');

    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(player(ctx, 'P1').life).toBe(40);
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
    expect(player(ctx, 'P1').library[0]?.name).toBe('Opponent Upkeep Top');
  });

  it('reveals a land with mana value zero and loses no life', () => {
    const ctx = pod();
    player(ctx, 'P1').life = 40;
    castPermanent(ctx, darkConfidant);
    player(ctx, 'P1').library.splice(0);
    const land = oracle({
      name: 'Confidant Land',
      typeLine: 'Basic Land — Forest',
      manaCost: null,
      cmc: 0,
      power: null,
      toughness: null,
    });
    conjure(ctx, 'P1', land, 'library');

    ctx.state.step = 'upkeep';
    queueStepTriggers(ctx, 'upkeep');
    pump(runPrioritySequence(ctx));

    expect(player(ctx, 'P1').hand.map((card) => card.name)).toEqual(['Confidant Land']);
    expect(player(ctx, 'P1').life).toBe(40);
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'draw')).toBe(false);
  });
});

describe('hand-effect structural contracts', () => {
  const definitionWith = (effect: unknown, targetKind: 'player' | 'creature' = 'player') => {
    const definition = interpretCard(duress);
    definition.spellAbility = {
      kind: 'spell',
      targets: [{ kind: targetKind }],
      effects: [effect as Effect],
    };
    return validateCardDefinition(definition);
  };

  it('rejects a nonplayer target for revealHandAndDiscard', () => {
    const issues = definitionWith(
      {
        op: 'revealHandAndDiscard',
        target: 0,
        filter: { kind: 'not', of: { kind: 'type', type: 'Land' } },
      },
      'creature',
    );

    expect(issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('creature is incompatible with effect domains player'),
      ]),
    );
  });

  it('requires revealHandAndDiscard to carry its card filter', () => {
    const issues = definitionWith({ op: 'revealHandAndDiscard', target: 0 });
    expect(issues.some((issue) => issue.path.includes('filter'))).toBe(true);
  });

  it('rejects false random-discard flags instead of treating them as enabled fields', () => {
    const issues = definitionWith({
      op: 'discardTarget',
      target: 0,
      count: constant(1),
      atRandom: false,
    });
    expect(issues.map((issue) => issue.message)).toContain(
      'random discard flag must be true when present',
    );
  });
});
