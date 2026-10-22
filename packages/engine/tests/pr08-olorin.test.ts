import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { fixtureOracleId } from '../src/cards/overrides';
import { addMana } from '../src/mana/pool';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { runPrioritySequence } from '../src/turn/priority';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import { triggered } from '../src/cards/templates';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pump,
  registerCustomDef,
  spawn,
} from './fixtures';

const pin = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr08-oracle.json', 'utf8')) as {
    cards: { card: OracleCard; sha256: string }[];
  }
).cards.find((entry) => entry.card.name === "Olórin's Searing Light")!;
function setup(spellCount = 2) {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed: 'olorin-pr08' },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  for (let index = 0; index < spellCount; index++)
    conjure(
      ctx,
      'P1',
      oracle({
        name: `Earlier spell ${index}`,
        typeLine: index % 2 === 0 ? 'Instant' : 'Sorcery',
        oracleText: 'You gain 1 life.',
      }),
      'graveyard',
    );
  return ctx;
}
type Ctx = ReturnType<typeof setup>;
function creature(ctx: Ctx, player: string, name: string, power: number, text = '') {
  return spawn(
    ctx,
    player,
    oracle({
      name,
      typeLine: 'Creature — Bear',
      power: String(power),
      toughness: '8',
      oracleText: text,
    }),
  );
}
function cast(
  ctx: Ctx,
  chooser: (prompt: string, names: string[], player: string) => number = () => 0,
) {
  const card = conjure(ctx, 'P1', pin.card, 'hand');
  addMana(playerById(ctx, 'P1'), [
    { symbol: 'R' },
    { symbol: 'W' },
    { symbol: 'C' },
    { symbol: 'C' },
  ]);
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
    (entry) =>
      (entry.payload as PriorityActionPayload).kind === 'castSpell' &&
      (entry.payload as { objectId?: string }).objectId === card.id,
  );
  expect(option).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  pump(runPrioritySequence(ctx), (decision) => {
    const pass = decision.options.findIndex((entry) => entry.type === 'pass');
    return {
      index:
        pass >= 0
          ? pass
          : chooser(
              decision.prompt,
              decision.options.map((entry) => entry.description),
              decision.player,
            ),
      targets: new Map(),
    };
  });
}
describe("Olórin's Searing Light (PR08.07)", () => {
  it('olorin-pinned-definition — models both clauses without targets', () => {
    for (const oracleId of [pin.card.oracleId, fixtureOracleId(pin.card.name)]) {
      const def = interpretCard({ ...pin.card, oracleId });
      expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
      expect(def.spellAbility?.targets).toEqual([]);
    }
  });
  it('olorin-normal-cast-greatest — each opponent chooses tied greatest power and takes that power in damage', () => {
    const ctx = setup();
    const first = creature(ctx, 'P2', 'First greatest', 4, 'Hexproof'),
      second = creature(ctx, 'P2', 'Second greatest', 4),
      small = creature(ctx, 'P2', 'Smaller creature', 2);
    const third = creature(ctx, 'P3', 'Other greatest', 3);
    const own = creature(ctx, 'P1', 'Own creature', 6);
    const asked: string[] = [];
    cast(ctx, (_prompt, names, player) => {
      asked.push(player);
      expect(ctx.state.battlefield).toEqual(expect.arrayContaining([first, second, third]));
      if (player === 'P2') {
        expect(names).toEqual(['Exile First greatest', 'Exile Second greatest']);
        return 1;
      }
      return 0;
    });
    expect(asked).toEqual(['P2']); // P3 has exactly one greatest creature, so its choice is forced.
    expect(ctx.state.battlefield).toEqual(expect.arrayContaining([first, small, own]));
    expect(ctx.state.exile.map((card) => card.cardId)).toEqual(
      expect.arrayContaining([second.cardId, third.cardId]),
    );
    expect(ctx.state.players.map((player) => player.life)).toEqual([40, 36, 37, 40]);
  });
  it('olorin-spell-mastery-negative — one graveyard spell exiles but deals no damage', () => {
    const ctx = setup(1),
      victim = creature(ctx, 'P2', 'Victim without mastery', 5);
    cast(ctx);
    expect(ctx.state.exile.some((card) => card.cardId === victim.cardId)).toBe(true);
    expect(playerById(ctx, 'P2').life).toBe(40);
    expect(ctx.state.eventLog.filter((event) => event.type === 'damage')).toEqual([]);
  });
  it('olorin-negative-power — greatest may be negative and produces no negative damage', () => {
    const ctx = setup(),
      greatest = creature(ctx, 'P2', 'Negative greatest', -1),
      smaller = creature(ctx, 'P2', 'More negative', -3);
    cast(ctx);
    expect(ctx.state.exile.some((card) => card.cardId === greatest.cardId)).toBe(true);
    expect(ctx.state.battlefield).toContain(smaller);
    expect(playerById(ctx, 'P2').life).toBe(40);
  });
  it('olorin-last-known-power — exiling an anthem does not reduce another chosen creature damage', () => {
    const ctx = setup();
    creature(ctx, 'P2', 'Leaving anthem', 4, 'Other creatures get +2/+2.');
    creature(ctx, 'P3', 'Boosted victim', 3);
    cast(ctx);
    expect(playerById(ctx, 'P2').life).toBe(36);
    expect(playerById(ctx, 'P3').life).toBe(35);
  });
  it('olorin-simultaneous-damage — every damage trigger observes all updated life totals', () => {
    const ctx = setup();
    creature(ctx, 'P2', 'Damage victim P2', 3);
    creature(ctx, 'P3', 'Damage victim P3', 3);
    const card = oracle({
      name: 'Independent simultaneous damage observer',
      typeLine: 'Enchantment',
      oracleText:
        'Whenever a player is dealt damage, if your life total is 37 or less, you gain 1 life.',
    });
    const base = interpretCard(card);
    registerCustomDef(ctx, {
      ...base,
      modeled: true,
      unmodeledReasons: [],
      triggers: [
        triggered(
          { when: 'playerDealtDamage', player: 'each' },
          {
            condition: {
              kind: 'compareValues',
              left: { kind: 'lifeTotal', scope: 'you' },
              cmp: '<=',
              right: { kind: 'const', n: 37 },
            },
            effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
          },
        ),
      ],
    });
    spawn(ctx, 'P3', card);
    let orderedTogether = false;
    cast(ctx, (prompt) => {
      if (prompt.includes('triggered simultaneously')) orderedTogether = true;
      return 0;
    });
    // Both firings are queued before either resolves; each still checks the intervening-if.
    // The first resolves at 37 and raises it to 38, so the second no longer resolves.
    expect(playerById(ctx, 'P3').life).toBe(38);
    expect(orderedTogether).toBe(true);
  });
});
