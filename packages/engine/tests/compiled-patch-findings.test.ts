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
    pump(executeAbility(ctx, source(ctx), map, [explorer.id]), (decision) => {
      asked.push(decision.prompt);
      return pick(decision, /Keep/);
    });
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
    pump(executeAbility(ctx, maps[0]!, mapAbility.ability, [survivor.id]), (decision) =>
      pick(decision, /Keep/),
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
