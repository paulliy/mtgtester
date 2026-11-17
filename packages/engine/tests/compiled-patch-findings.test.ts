/**
 * Engine defects the card compiler's audited pilot chunks found (docs/reviews/card-compiler-trial-
 * chunk-001 and -002, "Engine findings for the backlog"): patches that validated and then did the
 * wrong thing, or threw, in play. The validator-side findings are in
 * card-authoring-validation.test.ts; these are engine fixes.
 */
import { describe, expect, it } from 'vitest';
import type { Ability, Effect } from '../src/cards/ability';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { interpretCard } from '../src/cards/interpret';
import { ofType } from '../src/cards/selector';
import { computeCharacteristics } from '../src/effects/continuous';
import { executeAbility } from '../src/effects/resolve';
import { computePriorityOptions } from '../src/actions/legal';
import { priorityCheckpoint } from '../src/sba/sba';
import { moveObject } from '../src/state/objects';
import { getDefByOracleId } from '../src/state/queries';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  forest,
  gameConfig,
  oracle,
  pick,
  pump,
  pumpStrict,
  spawn,
} from './fixtures';

function game(seed: string): GameContext {
  return createGame(
    gameConfig(
      [0, 1, 2].map(() => ({ cards: copies(6, forest) })),
      { seed },
    ),
  );
}

const bear = (name: string) => oracle({ name, typeLine: 'Creature — Bear', manaCost: '{1}{G}' });
const relic = (name: string) => oracle({ name, typeLine: 'Artifact', manaCost: '{1}' });
const source = (ctx: GameContext) => spawn(ctx, 'P1', relic('Finding Source'));
const spell = (effects: Effect[], targets: Ability['targets'] = []): Ability => ({
  kind: 'spell',
  targets,
  effects,
  description: 'test',
});

describe('graveyardToBattlefieldEach and graveyardToHandEach read their scope', () => {
  // Rise of the Dark Realms: "Put all creature cards from all graveyards onto the battlefield
  // under your control." The executor read only its controller's graveyard whatever the scope.
  function board(seed: string) {
    const ctx = game(seed);
    const mine = conjure(ctx, 'P1', bear('Finding Bear Mine'), 'graveyard');
    const theirs = conjure(ctx, 'P2', bear('Finding Bear Theirs'), 'graveyard');
    const third = conjure(ctx, 'P3', bear('Finding Bear Third'), 'graveyard');
    const artifact = conjure(ctx, 'P2', relic('Finding Relic Theirs'), 'graveyard');
    return { ctx, mine, theirs, third, artifact };
  }

  it("puts every graveyard's creature cards onto the battlefield under your control", () => {
    const { ctx, mine, theirs, third, artifact } = board('scope-all-battlefield');
    const ability = spell([
      { op: 'graveyardToBattlefieldEach', filter: ofType('Creature'), scope: 'all' },
    ]);
    pumpStrict(executeAbility(ctx, source(ctx), ability, []));
    const returned = ctx.state.battlefield.filter((perm) => perm.name.startsWith('Finding Bear'));
    expect(returned.map((perm) => [perm.cardId, perm.controllerId, perm.ownerId]).sort()).toEqual(
      [
        [mine.cardId, 'P1', 'P1'],
        [theirs.cardId, 'P1', 'P2'],
        [third.cardId, 'P1', 'P3'],
      ].sort(),
    );
    // The filter still applies, and nothing is left behind that matched it.
    expect(ctx.state.players[1]!.graveyard.map((card) => card.cardId)).toEqual([artifact.cardId]);
    expect(
      ctx.state.players.every((player) => !player.graveyard.some((c) => c.name.includes('Bear'))),
    ).toBe(true);
  });

  it('reads only your graveyard without a scope or with scope you', () => {
    for (const scope of [undefined, 'you'] as const) {
      const { ctx, mine } = board(`scope-${scope ?? 'none'}`);
      const ability = spell([
        {
          op: 'graveyardToBattlefieldEach',
          filter: ofType('Creature'),
          ...(scope === undefined ? {} : { scope }),
        },
      ]);
      pumpStrict(executeAbility(ctx, source(ctx), ability, []));
      expect(
        ctx.state.battlefield
          .filter((perm) => perm.name.startsWith('Finding Bear'))
          .map((p) => p.cardId),
      ).toEqual([mine.cardId]);
      expect(ctx.state.players[1]!.graveyard).toHaveLength(2);
      expect(ctx.state.players[2]!.graveyard).toHaveLength(1);
    }
  });

  it("returns every graveyard's matching cards to their owners' hands", () => {
    const { ctx, mine, theirs, third } = board('scope-all-hand');
    const ability = spell([
      { op: 'graveyardToHandEach', filter: ofType('Creature'), scope: 'all' },
    ]);
    pumpStrict(executeAbility(ctx, source(ctx), ability, []));
    const handIds = (index: number) => ctx.state.players[index]!.hand.map((card) => card.cardId);
    expect(handIds(0)).toContain(mine.cardId);
    expect(handIds(1)).toContain(theirs.cardId);
    expect(handIds(2)).toContain(third.cardId);
    expect(handIds(0)).not.toContain(theirs.cardId);
  });
});

describe('explore from an ability with no event object', () => {
  // Get Lost's Map token: "{1}, {T}, Sacrifice this token: Target creature you control explores."
  // `explore` read the event object's last-known facts unconditionally, which throws "event
  // object information has no bound event object" for any activated ability.
  const map: Ability = {
    kind: 'activated',
    targets: [{ kind: 'creature', controller: 'you' }],
    effects: [{ op: 'explore', target: 0 }],
    description: '{1}, {T}, Sacrifice this token: Target creature you control explores.',
  };

  it('lets the target explore', () => {
    const ctx = game('explore-activated');
    const explorer = spawn(ctx, 'P1', bear('Finding Explorer'));
    // A nonland on top: the explorer gets a +1/+1 counter and its controller is asked about it.
    const top = conjure(ctx, 'P1', relic('Finding Top Relic'), 'library');
    const asked: string[] = [];
    pump(
      executeAbility(ctx, source(ctx), map, [explorer.id]),
      (decision) => {
        asked.push(decision.prompt);
        return pick(decision, /Keep/);
      },
      { strict: true },
    );
    expect(explorer.counters['+1/+1']).toBe(1);
    expect(asked).toEqual([expect.stringContaining('put the revealed card into your graveyard')]);
    expect(ctx.state.players[0]!.library[0]!.cardId).toBe(top.cardId);
  });

  it('does nothing when the target is illegal as it resolves', () => {
    const ctx = game('explore-illegal');
    const explorer = spawn(ctx, 'P1', bear('Finding Explorer'));
    const top = conjure(ctx, 'P1', relic('Finding Top Relic'), 'library');
    const handBefore = ctx.state.players[0]!.hand.length;
    // The creature changed controllers after it was targeted, so "creature you control" fails.
    explorer.controllerId = 'P2';
    pumpStrict(executeAbility(ctx, source(ctx), map, [explorer.id]));
    expect(explorer.counters['+1/+1']).toBeUndefined();
    expect(ctx.state.players[0]!.library[0]!.cardId).toBe(top.cardId);
    expect(ctx.state.players[0]!.hand).toHaveLength(handBefore);
    expect(ctx.state.eventLog.some((event) => event.type === 'explore')).toBe(false);
  });

  it("works through Get Lost's Map tokens", () => {
    const ctx = game('explore-get-lost');
    const victim = spawn(ctx, 'P2', bear('Finding Victim'));
    const survivor = spawn(ctx, 'P2', bear('Finding Survivor'));
    conjure(ctx, 'P2', relic('Finding Their Top Relic'), 'library');
    const getLost = spell(
      [
        {
          op: 'destroyAndCreateTokenForController',
          target: 0,
          spec: {
            name: 'Map',
            typeLine: 'Artifact — Map',
            types: ['Artifact'],
            subtypes: ['Map'],
            colors: [],
            power: null,
            toughness: null,
            activatedAbilities: [
              {
                costs: [
                  {
                    kind: 'mana',
                    cost: { generic: 1, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
                  },
                  { kind: 'tap' },
                  { kind: 'sacrificeSelf' },
                ],
                timing: 'sorcery',
                ability: map,
              },
            ],
          },
          count: { kind: 'const', n: 2 },
        },
      ],
      [{ kind: 'creature' }],
    );
    expect(
      validateCardDefinition({
        ...interpretCard(oracle({ name: 'Finding Get Lost', typeLine: 'Instant' })),
        spellAbility: getLost,
        modeled: true,
        unmodeledReasons: [],
      }),
    ).toEqual([]);
    pumpStrict(executeAbility(ctx, source(ctx), getLost, [victim.id]));
    const maps = ctx.state.battlefield.filter((perm) => perm.name === 'Map');
    expect(maps.map((perm) => perm.controllerId)).toEqual(['P2', 'P2']);
    const mapAbility = getDefByOracleId(ctx, maps[0]!.oracleId, 'Map').activatedAbilities[0]!;
    pump(
      executeAbility(ctx, maps[0]!, mapAbility.ability, [survivor.id]),
      (decision) => pick(decision, /Keep/),
      { strict: true },
    );
    expect(survivor.counters['+1/+1']).toBe(1);
  });
});

describe('a token power written as a value is read from the creating ability', () => {
  // Gelatinous Genesis ("Create X X/X green Ooze creature tokens") is modeled with `xValue` in
  // its token spec, and Warden of the Grove's patch used `countersOnSelf`. Both threw: the spec's
  // values were read with no scope when the token's definition was registered.
  const ooze = (power: unknown) =>
    ({
      name: 'Ooze',
      typeLine: 'Token Creature — Ooze',
      types: ['Creature'],
      subtypes: ['Ooze'],
      colors: ['G'],
      power,
      toughness: power,
    }) as never;
  const oozes = (ctx: GameContext) => ctx.state.battlefield.filter((perm) => perm.name === 'Ooze');

  it('reads X (Gelatinous Genesis)', () => {
    const ctx = game('token-x');
    const ability = spell([
      { op: 'createToken', spec: ooze({ kind: 'xValue' }), count: { kind: 'xValue' } },
    ]);
    pumpStrict(executeAbility(ctx, source(ctx), ability, [], undefined, { x: 3 }));
    expect(
      oozes(ctx).map((perm) => {
        const chars = computeCharacteristics(ctx, perm);
        return [chars.power, chars.toughness];
      }),
    ).toEqual([
      [3, 3],
      [3, 3],
      [3, 3],
    ]);
  });

  it("reads the source's counters (Warden of the Grove)", () => {
    const ctx = game('token-counters');
    const warden = source(ctx);
    warden.counters['+1/+1'] = 2;
    const ability = spell([
      {
        op: 'createToken',
        spec: ooze({ kind: 'countersOnSelf', counter: '+1/+1' }),
        count: { kind: 'const', n: 1 },
      },
    ]);
    pumpStrict(executeAbility(ctx, warden, ability, []));
    const [token] = oozes(ctx);
    const chars = computeCharacteristics(ctx, token!);
    expect([chars.power, chars.toughness]).toEqual([2, 2]);
    // Fixed as it was created: the token does not follow the source's counters afterwards.
    warden.counters['+1/+1'] = 5;
    expect(computeCharacteristics(ctx, token!).power).toBe(2);
  });
});

describe('targets that must differ are offered as legal assignments', () => {
  // Gleaming Splendor ("Two target players each draw a card") and Ulvenwald Tracker-style "target
  // creature and another target creature". An activated ability and a trigger offered each slot
  // every candidate, so a client could name one object twice: the activation threw "illegal
  // target", and a trigger took the duplicate. A spell already split its menus this way.
  const twoCreatures: Ability['targets'] = [
    { kind: 'creature' },
    { kind: 'creature', differentFromSlots: [0] },
  ];
  const tapBoth: Effect[] = [
    { op: 'tapTarget', target: 0 },
    { op: 'tapTarget', target: 1 },
  ];
  function main(seed: string): GameContext {
    const ctx = game(seed);
    Object.assign(ctx.state, {
      currentTurnPlayer: 'P1',
      activePlayerIndex: 0,
      turnNumber: 4,
      phase: 'precombatMain',
      step: null,
    });
    return ctx;
  }
  const tapper = (ctx: GameContext, targets: Ability['targets'], effects: Effect[]) => {
    const card = oracle({
      name: 'Finding Tapper',
      typeLine: 'Artifact',
      manaCost: '{1}',
      power: null,
      toughness: null,
      oracleText: '{T}: Draw a card.',
    });
    const definition = interpretCard(card);
    definition.activatedAbilities[0]!.ability = {
      kind: 'activated',
      targets,
      effects,
      description: '{T}: Tap two target things.',
    };
    expect(validateCardDefinition(definition)).toEqual([]);
    ctx.defs.set(card.oracleId, definition);
    return spawn(ctx, 'P1', card);
  };
  const activations = (ctx: GameContext) =>
    computePriorityOptions(ctx, ctx.state.players[0]!).filter((option) =>
      option.description.startsWith('Finding Tapper'),
    );

  it('splits an activated ability into one action per distinct pair', () => {
    const ctx = main('distinct-activated');
    tapper(ctx, twoCreatures, tapBoth);
    const a = spawn(ctx, 'P2', bear('Finding Bear A'));
    const b = spawn(ctx, 'P2', bear('Finding Bear B'));
    const pairs = activations(ctx).map((option) =>
      option.targets!.map((slot) => {
        expect(slot.options).toHaveLength(1);
        return slot.options[0];
      }),
    );
    expect(pairs.sort()).toEqual(
      [
        [a.id, b.id],
        [b.id, a.id],
      ].sort(),
    );
  });

  it('offers no activation when only one object could fill both slots (CR 602.2b)', () => {
    const ctx = main('distinct-activated-one');
    tapper(ctx, twoCreatures, tapBoth);
    spawn(ctx, 'P2', bear('Finding Bear A'));
    expect(activations(ctx)).toEqual([]);
  });

  it('lets two target players be chosen apart (Gleaming Splendor)', () => {
    const ctx = main('distinct-players');
    tapper(
      ctx,
      [{ kind: 'player' }, { kind: 'player', differentFromSlots: [0] }],
      [
        { op: 'drawTarget', target: 0, count: { kind: 'const', n: 1 } },
        { op: 'drawTarget', target: 1, count: { kind: 'const', n: 1 } },
      ],
    );
    const pairs = activations(ctx).map((option) => option.targets!.map((slot) => slot.options[0]));
    // Three players: six ordered pairs, none naming one player twice.
    expect(pairs).toHaveLength(6);
    expect(pairs.every(([first, second]) => first !== second)).toBe(true);
  });

  const pushTrigger = (ctx: GameContext, source: { cardId: string; oracleId: string }) =>
    ctx.state.pendingTriggers.push({
      controllerId: 'P1',
      sourceCardId: source.cardId,
      sourceOracleId: source.oracleId,
      sourceName: 'Finding Trigger',
      ability: {
        kind: 'triggered',
        trigger: { when: 'enters', subject: { kind: 'self' } },
        targets: twoCreatures,
        effects: tapBoth,
        description: 'Tap target creature and another target creature.',
      },
    });

  it('offers a trigger one menu per distinct pair and takes the chosen one', () => {
    const ctx = main('distinct-trigger');
    const a = spawn(ctx, 'P2', bear('Finding Bear A'));
    const b = spawn(ctx, 'P2', bear('Finding Bear B'));
    pushTrigger(ctx, source(ctx));
    const offered: string[][][] = [];
    pump(
      priorityCheckpoint(ctx),
      (decision) => {
        if (decision.decisionType !== 'chooseTargets') return undefined;
        offered.push(
          decision.options.map((option) => option.targets!.map((s) => s.options)).flat(),
        );
        const index = decision.options.findIndex(
          (option) => option.targets![0]!.options[0] === b.id,
        );
        return { index, targets: new Map() };
      },
      { strict: true },
    );
    expect(offered).toHaveLength(1);
    expect(ctx.state.stack.at(-1)!.targets).toEqual([b.id, a.id]);
  });

  it('removes a trigger with no distinct assignment (CR 603.3d)', () => {
    const ctx = main('distinct-trigger-one');
    spawn(ctx, 'P2', bear('Finding Bear A'));
    pushTrigger(ctx, source(ctx));
    pump(priorityCheckpoint(ctx), undefined, { strict: true });
    expect(ctx.state.stack).toHaveLength(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'triggerRemovedNoTargets')).toBe(true);
  });
});

describe('explore by a legal target that left during the resolution', () => {
  it('still explores, as the permanent last existed (CR 701.44c)', () => {
    const ctx = game('explore-lki');
    // A token: once destroyed it ceases to exist (CR 111.7), so nothing is left to refer to.
    const explorer = spawn(ctx, 'P1', bear('Finding Explorer'), { isToken: true });
    conjure(ctx, 'P1', relic('Finding Top Relic'), 'library');
    const ability: Ability = {
      kind: 'activated',
      targets: [{ kind: 'creature', controller: 'you' }],
      effects: [
        { op: 'destroy', target: 0 },
        { op: 'explore', target: 0 },
      ],
      description: 'Destroy target creature you control. It explores.',
    };
    pump(
      executeAbility(ctx, source(ctx), ability, [explorer.id]),
      (decision) => pick(decision, /Keep/),
      { strict: true },
    );
    expect(ctx.state.battlefield.includes(explorer)).toBe(false);
    const explored = ctx.state.eventLog.filter((event) => event.type === 'explore');
    expect(explored.map((event) => [event.payload['player'], event.payload['permanent']])).toEqual([
      ['P1', 'Finding Explorer'],
    ]);
  });
});

describe('an entry counter replacement over the chosen type', () => {
  it("reads the replacement source's as-enters choice", () => {
    // "Each creature you control of the chosen type enters with an additional +1/+1 counter."
    // The source is already on the battlefield, so its choice exists; its selector was not told.
    const ctx = game('entry-counters-chosen');
    const card = relic('Finding Banner');
    ctx.defs.set(card.oracleId, {
      ...interpretCard(card),
      additionalCountersOnEntry: [
        {
          affects: {
            kind: 'allOf',
            of: [{ kind: 'type', value: 'Creature' }, { kind: 'chosenSubtype' }],
          },
          counter: '+1/+1',
          count: { kind: 'const', n: 1 },
        },
      ],
    });
    const banner = spawn(ctx, 'P1', card);
    banner.chosenOption = 'Bear';
    const entering = conjure(ctx, 'P1', bear('Finding Bear'), 'hand');
    const other = conjure(
      ctx,
      'P1',
      oracle({ name: 'Finding Elf', typeLine: 'Creature — Elf', manaCost: '{G}' }),
      'hand',
    );
    pumpStrict(moveObject(ctx, entering, { zone: 'battlefield', controllerId: 'P1' }));
    pumpStrict(moveObject(ctx, other, { zone: 'battlefield', controllerId: 'P1' }));
    const counters = (name: string) =>
      ctx.state.battlefield.find((perm) => perm.name === name)!.counters['+1/+1'];
    expect(counters('Finding Bear')).toBe(1);
    expect(counters('Finding Elf')).toBeUndefined();
  });
});
