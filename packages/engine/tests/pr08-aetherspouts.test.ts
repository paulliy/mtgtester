import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { changeController, createToken, playerById } from '../src/state/objects';
import { SOLDIER_1_1 } from '../src/cards/tokens';
import { addMana } from '../src/mana/pool';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const pin = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards.find((entry) => entry.card.name === 'Aetherspouts')!;
function setup() {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed: 'pr08-aetherspouts' },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P2',
    activePlayerIndex: 1,
    turnNumber: 4,
    phase: 'combat',
    step: 'declareBlockers',
  });
  return ctx;
}
type Ctx = ReturnType<typeof setup>;
function attacker(ctx: Ctx, owner: string, name: string) {
  const permanent = spawn(
    ctx,
    owner,
    oracle({
      name,
      typeLine: 'Creature — Bear',
      power: '2',
      toughness: '2',
      oracleText: 'Hexproof',
    }),
  );
  permanent.attacking = 'P1';
  return permanent;
}
function announce(ctx: Ctx) {
  const card = conjure(ctx, 'P1', pin.card, 'hand');
  addMana(
    playerById(ctx, 'P1'),
    ['U', 'U', 'C', 'C', 'C'].map((symbol) => ({ symbol: symbol as 'U' | 'C' })),
  );
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
    (candidate) =>
      (candidate.payload as PriorityActionPayload).kind === 'castSpell' &&
      (candidate.payload as { objectId?: string }).objectId === card.id,
  );
  expect(option).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  expect(ctx.state.stack).toHaveLength(1);
}
function settle(
  ctx: Ctx,
  choose: (prompt: string, descriptions: string[], player: string) => number = () => 0,
) {
  pump(runPrioritySequence(ctx), (decision) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    return {
      index:
        pass >= 0
          ? pass
          : choose(
              decision.prompt,
              decision.options.map((option) => option.description),
              decision.player,
            ),
      targets: new Map(),
    };
  });
}
describe('Aetherspouts (PR08.12)', () => {
  it('aetherspouts-pinned-definition — real and alias definitions expose no targets', () => {
    for (const oracleId of [pin.card.oracleId, 'oracle-aetherspouts']) {
      const def = interpretCard({ ...pin.card, oracleId });
      expect(def.modeled).toBe(true);
      expect(def.spellAbility?.targets).toEqual([]);
    }
  });
  it('aetherspouts-normal-cast — pays five mana off turn and sends only attackers to their owners', () => {
    const ctx = setup();
    const top = attacker(ctx, 'P2', 'Top attacker'),
      bottom = attacker(ctx, 'P3', 'Bottom attacker');
    changeController(ctx, bottom, 'P2');
    bottom.attacking = 'P1';
    const untouched = spawn(
      ctx,
      'P2',
      oracle({ name: 'Not attacking', typeLine: 'Creature — Bear', power: '2', toughness: '2' }),
    );
    announce(ctx);
    const asked: string[] = [];
    settle(ctx, (prompt, _descriptions, player) => {
      if (prompt.includes('top or bottom')) {
        asked.push(player);
        expect(ctx.state.battlefield).toContain(top);
        expect(ctx.state.battlefield).toContain(bottom);
      }
      return prompt.includes('Bottom attacker') ? 1 : 0;
    });
    expect(asked).toEqual(['P2', 'P3']);
    expect(playerById(ctx, 'P2').library[0]?.cardId).toBe(top.cardId);
    expect(playerById(ctx, 'P3').library.at(-1)?.cardId).toBe(bottom.cardId);
    expect(ctx.state.battlefield).toContain(untouched);
    expect(ctx.state.battlefield).not.toContain(top);
    expect(ctx.state.battlefield).not.toContain(bottom);
    expect(playerById(ctx, 'P2').library[0]?.id).not.toBe(top.id);
  });
  it('aetherspouts-owner-order — the owner chooses relative order for top and bottom groups', () => {
    const ctx = setup();
    const cards = ['A', 'B', 'C', 'D'].map((name) => attacker(ctx, 'P2', `Attacker ${name}`));
    announce(ctx);
    settle(ctx, (prompt, descriptions) => {
      if (prompt.includes('top or bottom')) return /Attacker [CD]/.test(prompt) ? 1 : 0;
      if (prompt.includes('order the top'))
        return descriptions.findIndex((text) => text.includes('Attacker B'));
      if (prompt.includes('order the bottom'))
        return descriptions.findIndex((text) => text.includes('Attacker D'));
      return 0;
    });
    const library = playerById(ctx, 'P2').library;
    expect(library.slice(0, 2).map((card) => card.name)).toEqual(['Attacker B', 'Attacker A']);
    expect(library.slice(-2).map((card) => card.name)).toEqual(['Attacker D', 'Attacker C']);
    expect(new Set(library.map((card) => card.id)).size).toBe(library.length);
    const logged = ctx.state.eventLog.filter(
      (event) =>
        event.type === 'zoneChange' &&
        cards.some((card) => card.cardId === event.payload['cardId']),
    );
    expect(logged.map((event) => event.payload['name'])).toEqual(cards.map((card) => card.name));
  });
  it('aetherspouts-commanders-and-tokens — respects command-zone replacement and tokens cease', () => {
    const ctx = setup();
    const commander = attacker(ctx, 'P2', 'Commander attacker');
    commander.isCommander = true;
    const token = createToken(ctx, SOLDIER_1_1, 'P3');
    token.attacking = 'P1';
    announce(ctx);
    settle(ctx);
    expect(playerById(ctx, 'P2').commandZone.some((card) => card.cardId === commander.cardId)).toBe(
      true,
    );
    expect(playerById(ctx, 'P2').library.some((card) => card.cardId === commander.cardId)).toBe(
      false,
    );
    expect(ctx.state.battlefield).not.toContain(token);
    expect(playerById(ctx, 'P3').library.some((card) => card.cardId === token.cardId)).toBe(false);
  });
  it('aetherspouts-no-attackers — no owner choice is offered', () => {
    const ctx = setup();
    announce(ctx);
    settle(ctx, () => {
      throw new Error('unexpected owner choice');
    });
    expect(ctx.state.stack).toHaveLength(0);
  });
  it('aetherspouts-insufficient-cost — two blue mana are required', () => {
    const ctx = setup(),
      card = conjure(ctx, 'P1', pin.card, 'hand');
    addMana(
      playerById(ctx, 'P1'),
      Array.from({ length: 5 }, () => ({ symbol: 'C' as const })),
    );
    expect(
      computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
        (option) => (option.payload as { objectId?: string }).objectId === card.id,
      ),
    ).toBe(false);
  });
});
