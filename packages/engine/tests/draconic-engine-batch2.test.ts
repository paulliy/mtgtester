import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { computeTargetOptions } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { not, withKeyword } from '../src/cards/selector';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { queueTriggersForEvent } from '../src/state/objects';
import { priorityCheckpoint } from '../src/sba/sba';
import type { GameContext } from '../src/state/types';
import {
  bear,
  conjure,
  copies,
  forest,
  gameConfig,
  keywordCreature,
  oracle,
  pick,
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
  readFileSync(join(import.meta.dirname, 'fixtures/draconic-engine-batch2-oracle.json'), 'utf8'),
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

function pod(seed: string, seats = 2): GameContext {
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

function sourceOf(card: OracleCard, cardId = `src-${card.name}`) {
  return { cardId, name: card.name, oracleId: card.oracleId, controllerId: 'P1' as const };
}

function resolvePending(
  ctx: GameContext,
  targets: string[] = [],
  chooser?: Parameters<typeof pump>[1],
): void {
  const pending = ctx.state.pendingTriggers[0];
  if (pending === undefined) return;
  ctx.state.pendingTriggers.shift();
  pump(
    executeAbility(
      ctx,
      {
        cardId: pending.sourceCardId,
        name: pending.sourceName,
        oracleId: pending.sourceOracleId,
        controllerId: pending.controllerId,
      },
      pending.ability,
      targets,
      pending.triggerObjectCardId,
      pending.scope,
    ),
    chooser,
  );
}

describe('Draconic engine-evidence batch 2 (pinned Oracle)', () => {
  it('pins complete offline Oracle cards with stable content hashes', () => {
    expect(fixture).toMatchObject({
      schemaVersion: 1,
      source: 'packages/server/fixtures/coverage-oracle.json',
      retrievedAt: '2026-09-11',
    });
    expect(fixture.cards.map(({ card }) => card.name)).toEqual([
      'Clan Defiance',
      'Demanding Dragon',
      'Dragon Mage',
      'Hoard-Smelter Dragon',
      "Hunter's Prowess",
      'Loaming Shaman',
      'Primal Might',
      'Provoke the Trolls',
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

describe('Clan Defiance', () => {
  const card = pinned('Clan Defiance');

  it('clan-player-mode-deals-x-to-the-targeted-player', () => {
    const ctx = pod('clan-player');
    const def = interpretCard(card);
    const mode = def.spellAbility!.modes!.options[2]!;
    const life = playerOf(ctx, 'P2').life;
    pump(
      executeAbility(
        ctx,
        sourceOf(card),
        { ...def.spellAbility!, effects: mode.effects },
        ['unused-0', 'unused-1', 'P2'],
        undefined,
        { x: 5 },
      ),
    );
    expect(playerOf(ctx, 'P2').life).toBe(life - 5);
  });

  it('clan-flying-mode-cannot-target-a-nonflying-creature', () => {
    const ctx = pod('clan-illegal');
    const hawk = spawn(ctx, 'P2', keywordCreature('Hawk', 'Flying', '{W}', '1/1'));
    const ground = spawn(ctx, 'P2', bear());
    const flying = computeTargetOptions(
      ctx,
      { kind: 'creature', filter: withKeyword('flying') },
      'P1',
    );
    const grounded = computeTargetOptions(
      ctx,
      { kind: 'creature', filter: not(withKeyword('flying')) },
      'P1',
    );
    expect(flying).toContain(hawk.id);
    expect(flying).not.toContain(ground.id);
    expect(grounded).toContain(ground.id);
    expect(grounded).not.toContain(hawk.id);
  });
});

describe('Demanding Dragon', () => {
  const card = pinned('Demanding Dragon');

  it('demanding-deals-five-when-the-opponent-has-no-creature', () => {
    const ctx = pod('demanding-empty');
    const dragon = spawn(ctx, 'P1', card);
    const life = playerOf(ctx, 'P2').life;
    queueTriggersForEvent(ctx, 'enters', [{ permanent: dragon }]);
    resolvePending(ctx, ['P2']);
    expect(playerOf(ctx, 'P2').life).toBe(life - 5);
  });

  it('demanding-sacrifice-avoids-damage-and-decline-takes-it', () => {
    const ctx = pod('demanding-sac');
    const dragon = spawn(ctx, 'P1', card);
    const foe = spawn(ctx, 'P2', bear());
    const life = playerOf(ctx, 'P2').life;
    queueTriggersForEvent(ctx, 'enters', [{ permanent: dragon }]);
    resolvePending(ctx, ['P2'], (decision) => pick(decision, 'Sacrifice'));
    expect(playerOf(ctx, 'P2').life).toBe(life);
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === foe.cardId)).toBe(false);

    const ctx2 = pod('demanding-decline');
    const dragon2 = spawn(ctx2, 'P1', card);
    spawn(ctx2, 'P2', bear());
    const life2 = playerOf(ctx2, 'P2').life;
    queueTriggersForEvent(ctx2, 'enters', [{ permanent: dragon2 }]);
    resolvePending(ctx2, ['P2'], (decision) => pick(decision, "Don't sacrifice"));
    expect(playerOf(ctx2, 'P2').life).toBe(life2 - 5);
  });
});

describe('Dragon Mage', () => {
  const card = pinned('Dragon Mage');

  it('mage-combat-damage-makes-each-player-discard-then-draw-seven', () => {
    const ctx = pod('mage-draw');
    const mage = spawn(ctx, 'P1', card);
    conjure(ctx, 'P1', forest(), 'hand');
    const before1 = playerOf(ctx, 'P1').library.length;
    const before2 = playerOf(ctx, 'P2').library.length;
    queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [{ permanent: mage, amount: 4 }]);
    resolvePending(ctx);
    expect(playerOf(ctx, 'P1').hand.length).toBe(7);
    expect(playerOf(ctx, 'P2').hand.length).toBe(7);
    expect(playerOf(ctx, 'P1').library.length).toBe(before1 - 7);
    expect(playerOf(ctx, 'P2').library.length).toBe(before2 - 7);
  });

  it('mage-does-not-fire-for-another-creature', () => {
    const ctx = pod('mage-other');
    spawn(ctx, 'P1', card);
    const other = spawn(ctx, 'P1', bear());
    queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [{ permanent: other, amount: 2 }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Hoard-Smelter Dragon', () => {
  const card = pinned('Hoard-Smelter Dragon');

  it('smelter-destroys-an-artifact-and-pumps-by-its-mana-value', () => {
    const ctx = pod('smelter-yes');
    const dragon = spawn(ctx, 'P1', card);
    const artifact = spawn(
      ctx,
      'P2',
      oracle({ name: 'Test Artifact', typeLine: 'Artifact', manaCost: '{3}{R}', cmc: 4 }),
    );
    pump(
      executeAbility(
        ctx,
        sourceOf(card, dragon.cardId),
        interpretCard(card).activatedAbilities[0]!.ability,
        [artifact.id],
      ),
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === artifact.cardId)).toBe(
      false,
    );
    expect(computeCharacteristics(ctx, dragon).power).toBe(9);
  });

  it('smelter-cannot-target-a-creature', () => {
    const ctx = pod('smelter-illegal');
    const artifact = spawn(
      ctx,
      'P2',
      oracle({ name: 'Test Artifact', typeLine: 'Artifact', manaCost: '{2}' }),
    );
    const creature = spawn(ctx, 'P2', bear());
    const legal = computeTargetOptions(ctx, { kind: 'artifact' }, 'P1');
    expect(legal).toContain(artifact.id);
    expect(legal).not.toContain(creature.id);
  });
});

describe("Hunter's Prowess", () => {
  const card = pinned("Hunter's Prowess");

  it('prowess-pumps-grants-trample-and-draws-on-combat-damage', () => {
    const ctx = pod('prowess-yes');
    const ally = spawn(ctx, 'P1', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [ally.id]));
    const chars = computeCharacteristics(ctx, ally);
    expect(chars.power).toBe(5);
    expect(chars.keywords).toContain('trample');
    const hand = playerOf(ctx, 'P1').hand.length;
    queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [{ permanent: ally, amount: 5 }]);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    resolvePending(ctx);
    expect(playerOf(ctx, 'P1').hand.length).toBe(hand + 5);
  });

  it('prowess-does-not-draw-for-an-unbuffed-creature', () => {
    const ctx = pod('prowess-other');
    const ally = spawn(ctx, 'P1', bear());
    const other = spawn(ctx, 'P1', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [ally.id]));
    queueTriggersForEvent(ctx, 'dealsCombatDamageToPlayer', [{ permanent: other, amount: 2 }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });
});

describe('Loaming Shaman', () => {
  const card = pinned('Loaming Shaman');

  it('loaming-shuffles-chosen-graveyard-cards-into-that-library', () => {
    const ctx = pod('loaming-yes');
    const shaman = spawn(ctx, 'P1', card);
    const gyCard = conjure(ctx, 'P2', bear(), 'graveyard');
    const before = playerOf(ctx, 'P2').library.length;
    pump(
      executeAbility(
        ctx,
        sourceOf(card, shaman.cardId),
        interpretCard(card).triggers[0]!,
        ['P2'],
        undefined,
        undefined,
        { 1: [gyCard.id] },
      ),
    );
    expect(playerOf(ctx, 'P2').graveyard).toHaveLength(0);
    expect(playerOf(ctx, 'P2').library.length).toBe(before + 1);
  });

  it('loaming-can-shuffle-zero-cards', () => {
    const ctx = pod('loaming-zero');
    const shaman = spawn(ctx, 'P1', card);
    conjure(ctx, 'P2', bear(), 'graveyard');
    const gy = playerOf(ctx, 'P2').graveyard.length;
    const library = playerOf(ctx, 'P2').library.length;
    pump(
      executeAbility(
        ctx,
        sourceOf(card, shaman.cardId),
        interpretCard(card).triggers[0]!,
        ['P2'],
        undefined,
        undefined,
        { 1: [] },
      ),
    );
    expect(playerOf(ctx, 'P2').graveyard).toHaveLength(gy);
    expect(playerOf(ctx, 'P2').library.length).toBe(library);
  });
});

describe('Primal Might', () => {
  const card = pinned('Primal Might');

  it('primal-pumps-your-creature-then-fights-an-opponent-creature', () => {
    const ctx = pod('primal-fight');
    const mine = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    pump(
      executeAbility(
        ctx,
        sourceOf(card),
        interpretCard(card).spellAbility!,
        [mine.id],
        undefined,
        { x: 3 },
        { 1: [theirs.id] },
      ),
    );
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === theirs.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield.some((permanent) => permanent.cardId === mine.cardId)).toBe(true);
  });

  it('primal-cannot-choose-an-opponent-creature-as-the-pumped-target', () => {
    const ctx = pod('primal-illegal');
    const mine = spawn(ctx, 'P1', bear());
    const theirs = spawn(ctx, 'P2', bear());
    const yours = computeTargetOptions(ctx, { kind: 'creature', controller: 'you' }, 'P1');
    const theirsLegal = computeTargetOptions(
      ctx,
      { kind: 'creature', controller: 'opponent' },
      'P1',
    );
    expect(yours).toContain(mine.id);
    expect(yours).not.toContain(theirs.id);
    expect(theirsLegal).toContain(theirs.id);
    expect(theirsLegal).not.toContain(mine.id);
  });
});

describe('Provoke the Trolls', () => {
  const card = pinned('Provoke the Trolls');

  it('provoke-pumps-a-creature-after-dealing-damage', () => {
    const ctx = pod('provoke-creature');
    const foe = spawn(ctx, 'P2', bear());
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, [foe.id]));
    expect(foe.damageMarked).toBe(3);
    expect(computeCharacteristics(ctx, foe).power).toBe(7);
  });

  it('provoke-does-not-pump-a-player-target', () => {
    const ctx = pod('provoke-player');
    const life = playerOf(ctx, 'P2').life;
    pump(executeAbility(ctx, sourceOf(card), interpretCard(card).spellAbility!, ['P2']));
    expect(playerOf(ctx, 'P2').life).toBe(life - 3);
    expect(ctx.state.effects.some((effect) => effect.kind === 'ptDelta')).toBe(false);
  });
});
