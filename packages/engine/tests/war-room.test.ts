import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Color, OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { conflictingRegistrations, failedRegistrations } from '../src/cards/overrides';
import { executeAbility } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { manaSourcesFor } from '../src/state/queries';
import type { GameContext } from '../src/state/types';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { conjure, copies, gameConfig, oracle, pick, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/marchesa-batch1-oracle.json'), 'utf8'),
) as PinnedFixture;
const pinned = fixture.cards.find((entry) => entry.card.name === 'War Room');
if (pinned === undefined) throw new Error('missing pinned War Room fixture');

const WAR_ROOM_ORACLE_ID = '71c52bf5-2a5d-488e-8b15-7ef290e4b77d';
const WAR_ROOM_ORACLE_TEXT =
  "{T}: Add {C}.\n{3}, {T}, Pay life equal to the number of colors in your commanders' color identity: Draw a card.";

const warRoom = (): OracleCard => pinned.card;

const manaSink = (): OracleCard =>
  oracle({
    oracleId: 'test-war-room-mana-sink',
    name: 'War Room Mana Sink',
    typeLine: 'Artifact',
    manaCost: '{1}',
    cmc: 1,
    power: null,
    toughness: null,
  });

const commanderWith = (identity: Color[], name: string): OracleCard =>
  oracle({
    oracleId: `test-war-room-commander-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    typeLine: 'Legendary Creature — Test Captain',
    colorIdentity: identity,
    colors: identity,
  });

interface SetupOptions {
  /** Starting life for P1. */
  life?: number;
  /** Floating {C} in P1's pool before activation; the draw ability's mana cost is {3}. */
  mana?: number;
  /** Start War Room already tapped. */
  tapped?: boolean;
  seed?: string;
}

/**
 * One War Room on P1's battlefield with `identities` worth of commanders in the command zone. The
 * pool is pre-filled with plain {C} so the {3} is never the variable under test — only the life is.
 */
function setupCommanders(identities: Color[][], opts: SetupOptions = {}) {
  const commanders = identities.map((identity, index) =>
    commanderWith(identity, `Identity Commander ${index + 1}`),
  );
  const ctx = createGame(
    gameConfig(
      [
        {
          id: 'P1',
          commanders,
          cards: copies(6, () => oracle({ name: 'Draw Card' })),
        },
        { id: 'P2', cards: copies(6, () => oracle({ name: 'Opponent Card' })) },
      ],
      {
        seed:
          opts.seed ??
          `war-room-${identities.map((identity) => identity.join('') || 'colorless').join('-')}`,
      },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  const player = ctx.state.players.find((candidate) => candidate.id === 'P1')!;
  player.life = opts.life ?? 20;
  const permanent = spawn(ctx, 'P1', warRoom(), { tapped: opts.tapped ?? false });
  addMana(
    player,
    Array.from({ length: opts.mana ?? 3 }, () => ({ symbol: 'C' as const })),
  );
  const activation = () =>
    computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === permanent.id;
    });
  return { ctx, player, permanent, activation };
}

function setup(identity: Color[], opts: SetupOptions = {}) {
  return setupCommanders([identity], opts);
}

type Harness = ReturnType<typeof setupCommanders>;

function activate(harness: Harness, option: NonNullable<ReturnType<Harness['activation']>>) {
  return pump(
    applyPriorityAction(harness.ctx, harness.player, option.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
}

const ownDraws = (ctx: GameContext, seat = 'P1') =>
  ctx.state.eventLog.filter((event) => event.type === 'draw' && event.actorSeat === seat);

describe('War Room', () => {
  it('war-room-production-registry-definition', () => {
    expect(pinned.sha256).toBe('7014d3a7b8e20db7e2a12576165361775173e73cb28f1106afa40a659d6d0c74');
    expect(pinned.card.oracleId).toBe(WAR_ROOM_ORACLE_ID);
    expect(pinned.card.oracleText).toBe(WAR_ROOM_ORACLE_TEXT);
    const definition = interpretCard(warRoom());
    expect(failedRegistrations).toEqual([]);
    expect(
      conflictingRegistrations.filter((entry) => entry.oracleId === WAR_ROOM_ORACLE_ID),
    ).toEqual([]);
    expect(definition.modeled).toBe(true);
    // The fixture alias id must model identically, or aliased fixtures silently diverge.
    expect(interpretCard({ ...pinned.card, oracleId: 'oracle-war-room' }).modeled).toBe(true);
    expect(definition.activatedAbilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ability: expect.objectContaining({
            effects: expect.arrayContaining([expect.objectContaining({ op: 'draw' })]),
          }),
        }),
      ]),
    );
  });

  /**
   * Definition shape only — a prerequisite for the behavioral payment regression below, which is
   * the actual evidence that {C} pays a real cost. Kept under its own id so neither claim can be
   * mistaken for the other.
   */
  it('war-room-colorless-mana-ability-definition — keeps the mana ability alongside the draw ability', () => {
    const definition = interpretCard(warRoom());
    expect(definition.manaAbilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ units: [['C']] })]),
    );
    expect(definition.activatedAbilities).not.toHaveLength(0);
  });

  /**
   * A mana ability is activated by the payment solver, not from the priority menu, so its normal
   * path is paying a real cost with it. War Room is the only mana source and the pool starts empty,
   * so the {1} can only have been paid by War Room's {C}. This proves {C} pays generic {1}; it does
   * not prove payment of a {C} requirement.
   */
  it('war-room-colorless-mana-normal-activation — pays a real {1} spell cost with {C} and draws nothing', () => {
    const harness = setup(['W', 'U', 'B'], { mana: 0 });
    const { ctx, player, permanent } = harness;
    const sink = conjure(ctx, 'P1', manaSink(), 'hand');
    const lifeBefore = player.life;
    const libraryBefore = player.library.length;

    expect(player.manaEntries).toEqual([]);
    expect(player.manaPool.C).toBe(0);
    expect(permanent.tapped).toBe(false);
    expect(manaSourcesFor(ctx, 'P1').map((source) => source.cardId)).toEqual([permanent.cardId]);

    let cast = false;
    pump(runPrioritySequence(ctx), (decision) => {
      if (decision.player === 'P1' && !cast) {
        cast = true;
        return pick(decision, 'Cast War Room Mana Sink');
      }
      return pick(decision, 'Pass');
    });

    expect(permanent.tapped).toBe(true);
    expect(player.hand.some((card) => card.cardId === sink.cardId)).toBe(false);
    expect(ctx.state.battlefield.some((entry) => entry.cardId === sink.cardId)).toBe(true);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'War Room Mana Sink',
      ),
    ).toBe(true);
    expect(ctx.state.stack).toHaveLength(0);
    // The {C} was consumed, not merely produced.
    expect(player.manaEntries).toEqual([]);
    expect(player.manaPool.C).toBe(0);
    expect(player.life).toBe(lifeBefore);
    expect(player.library).toHaveLength(libraryBefore);
    expect(ownDraws(ctx)).toHaveLength(0);
  });

  it('war-room-colorless-mana-tapped-source-cannot-pay — no cast is offered without another source', () => {
    const { ctx, player } = setup(['W', 'U', 'B'], { mana: 0, tapped: true });
    conjure(ctx, 'P1', manaSink(), 'hand');
    expect(manaSourcesFor(ctx, 'P1')).toEqual([]);
    expect(
      computePriorityOptions(ctx, player).some((option) =>
        option.description.includes('Cast War Room Mana Sink'),
      ),
    ).toBe(false);
  });

  it('war-room-commander-identity-life-cost — uses the pinned identity text and activates normally', () => {
    const harness = setup(['W', 'U', 'B']);
    const { ctx, player, permanent, activation } = harness;
    const libraryBefore = player.library.length;
    const handBefore = player.hand.length;
    const option = activation();
    expect(option?.data?.['abilityCosts']).toEqual(
      expect.arrayContaining([
        { kind: 'tap' },
        { kind: 'payLifeValue', amount: { kind: 'commanderIdentityColorCount' } },
      ]),
    );
    activate(harness, option!);

    expect(permanent.tapped).toBe(true);
    expect(player.life).toBe(17);
    expect(player.manaEntries).toEqual([]);
    expect(ctx.state.stack).toHaveLength(1);
    // Costs are paid on activation; the draw happens only on resolution.
    expect(player.library).toHaveLength(libraryBefore);
    expect(player.hand).toHaveLength(handBefore);
    expect(ownDraws(ctx)).toHaveLength(0);

    pump(resolveTopOfStack(ctx));
    expect(player.library).toHaveLength(libraryBefore - 1);
    expect(player.hand).toHaveLength(handBefore + 1);
    expect(ctx.state.stack).toHaveLength(0);
    expect(ownDraws(ctx)).toHaveLength(1);
  });

  it.each([
    ['mono-color', ['G'] as Color[], 1],
    ['two-color', ['W', 'U'] as Color[], 2],
    ['three-color', ['W', 'U', 'B'] as Color[], 3],
    ['four-color', ['W', 'U', 'B', 'R'] as Color[], 4],
    ['five-color', ['W', 'U', 'B', 'R', 'G'] as Color[], 5],
  ])(
    'war-room-dynamic-life-identity-matrix — charges the %s identity exactly and draws once',
    (label, identity, expectedLife) => {
      const harness = setup(identity, { life: 20 });
      const { ctx, player, permanent, activation } = harness;
      const libraryBefore = player.library.length;
      const handBefore = player.hand.length;
      const option = activation();
      expect(option, label).toBeDefined();
      activate(harness, option!);

      expect(player.life, label).toBe(20 - expectedLife);
      expect(permanent.tapped, label).toBe(true);
      expect(player.manaEntries, label).toEqual([]);
      expect(player.library, label).toHaveLength(libraryBefore);
      expect(player.hand, label).toHaveLength(handBefore);
      expect(ownDraws(ctx), label).toHaveLength(0);

      pump(resolveTopOfStack(ctx));
      expect(player.library, label).toHaveLength(libraryBefore - 1);
      expect(player.hand, label).toHaveLength(handBefore + 1);
      expect(ownDraws(ctx), label).toHaveLength(1);
      expect(ctx.state.stack, label).toHaveLength(0);
    },
  );

  it.each([
    ['disjoint partners', [['W'], ['U']] as Color[][], 2],
    [
      'overlapping partners',
      [
        ['W', 'U'],
        ['U', 'B'],
      ] as Color[][],
      3,
    ],
    [
      'identical partners',
      [
        ['W', 'U'],
        ['W', 'U'],
      ] as Color[][],
      2,
    ],
    ['colorless plus a mono partner', [[], ['R']] as Color[][], 1],
  ])(
    'war-room-dynamic-life-partner-identity-union — %s pay the union, not the sum',
    (label, identities, expectedLife) => {
      const harness = setupCommanders(identities, { life: 20 });
      const { player, activation } = harness;
      expect(player.commandZone, label).toHaveLength(identities.length);
      expect(player.commanderColorIdentity.length, label).toBe(expectedLife);
      const option = activation();
      expect(option, label).toBeDefined();
      activate(harness, option!);
      expect(player.life, label).toBe(20 - expectedLife);
    },
  );

  it('war-room-dynamic-life-commander-zone-independent — charges the full identity from any zone', () => {
    // CR 903.4: color identity does not depend on the commander's current zone.
    const harness = setup(['W', 'U', 'B']);
    const { player, activation } = harness;
    const commander = player.commandZone.splice(0, 1)[0]!;
    player.graveyard.push({ ...commander, zone: 'graveyard' });
    const option = activation();
    expect(option).toBeDefined();
    activate(harness, option!);
    expect(player.life).toBe(17);
  });

  it('war-room-dynamic-life-insufficient-life — rejects activation in or out of the command zone', () => {
    const outOfZone = setup(['W', 'U', 'B'], { life: 2 });
    outOfZone.player.commandZone.splice(0, 1);
    expect(outOfZone.activation()).toBeUndefined();

    expect(setup(['W', 'U', 'B'], { life: 2 }).activation()).toBeUndefined();
  });

  it('war-room-dynamic-life-colorless-identity-zero — charges zero life and still draws', () => {
    const harness = setup([]);
    const { ctx, player, activation } = harness;
    const libraryBefore = player.library.length;
    const option = activation();
    expect(option).toBeDefined();
    activate(harness, option!);
    expect(player.life).toBe(20);
    pump(resolveTopOfStack(ctx));
    expect(player.library).toHaveLength(libraryBefore - 1);
    expect(ownDraws(ctx)).toHaveLength(1);
  });

  it('war-room-dynamic-life-requires-mana-and-untapped-source — mana and tap negatives', () => {
    expect(setup(['W', 'U', 'B'], { mana: 2 }).activation()).toBeUndefined();
    expect(setup(['W', 'U', 'B'], { tapped: true }).activation()).toBeUndefined();
  });

  it('war-room-dynamic-life-countered-ability-keeps-costs — costs stay paid and nothing is drawn', () => {
    const harness = setup(['W', 'U', 'B']);
    const { ctx, player, permanent, activation } = harness;
    const libraryBefore = player.library.length;
    const handBefore = player.hand.length;
    activate(harness, activation()!);
    const stackObject = ctx.state.stack[0]!;

    pump(
      executeAbility(
        ctx,
        {
          cardId: 'counter-card',
          oracleId: 'counter-ability',
          name: 'Counter Ability',
          controllerId: 'P2',
        },
        {
          kind: 'spell',
          targets: [{ kind: 'stackObject' }],
          effects: [{ op: 'counter', target: 0 }],
        },
        [stackObject.id],
      ),
    );

    expect(ctx.state.stack).toHaveLength(0);
    expect(player.life).toBe(17);
    expect(permanent.tapped).toBe(true);
    expect(player.manaEntries).toEqual([]);
    expect(player.library).toHaveLength(libraryBefore);
    expect(player.hand).toHaveLength(handBefore);
    expect(ownDraws(ctx)).toHaveLength(0);
  });
});
