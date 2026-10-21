import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import type { Ability, Effect } from '../src/cards/definition';
import { ofType } from '../src/cards/selector';
import { executeAbility } from '../src/effects/resolve';
import { createGame } from '../src/state/game';
import { buildPlayerView } from '../src/view/view';
import { conjure, copies, forest, gameConfig, oracle, pump } from './fixtures';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

/** Exercise the shared operation without declaring an entire PR09 card supported. */
function setup(reveal = true, seed = 'pr09-look') {
  const ctx = createGame(
    gameConfig([{ cards: copies(8, forest) }, { cards: copies(8, forest) }], { seed }),
  );
  const player = ctx.state.players[0]!;
  player.library.length = 0;
  const cards = Array.from({ length: 8 }, (_, index) =>
    conjure(
      ctx,
      player.id,
      oracle({
        name: `Private Look Card ${index}`,
        typeLine: index % 2 === 0 ? 'Artifact' : 'Instant',
      }),
      'library',
    ),
  );
  player.library = [...cards];
  const effect: Extract<Effect, { op: 'lookAtTopN' }> = {
    op: 'lookAtTopN',
    count: 6,
    mayPut: {
      filter: ofType('Artifact'),
      destination: { zone: 'hand' },
      ...(reveal ? { reveal: true as const } : {}),
    },
    rest: 'bottomRandom',
  };
  const ability: Ability = {
    kind: 'spell',
    targets: [],
    effects: [effect],
  };
  const run = () =>
    executeAbility(
      ctx,
      {
        cardId: 'pr09-look-source',
        oracleId: 'pr09-look-source',
        name: 'Library Look Contract',
        controllerId: player.id,
      },
      ability,
      [],
    );
  return { ctx, player, cards, effect, run };
}

describe('PR09 library look foundation', () => {
  it('pr09-oracle-pins — pins the 31 assigned Oracle identities and full definitions', () => {
    expect(fixture.cards).toHaveLength(31);
    expect(new Set(fixture.cards.map(({ card }) => card.oracleId)).size).toBe(31);
    for (const { card, sha256 } of fixture.cards) {
      expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(sha256);
    }
    expect(fixture.cards[0]?.card.name).toBe('Chaos Warp');
    expect(fixture.cards.at(-1)?.card.name).toBe('Grenzo, Havoc Raiser');
  });

  it('pr09-look-reveal — publicly reveals only the chosen card before its library-to-hand move', () => {
    const { ctx, player, cards, run } = setup();
    pump(run());
    expect(player.hand.map((card) => card.cardId)).toContain(cards[0]!.cardId);
    const reveals = ctx.state.eventLog.filter((event) => event.type === 'revealCard');
    expect(reveals.map((event) => event.payload['name'])).toEqual([cards[0]!.name]);
    expect(reveals[0]?.payload['revealed']).toBe(true);
    const revealIndex = ctx.state.eventLog.findIndex((event) => event.type === 'revealCard');
    const moveIndex = ctx.state.eventLog.findIndex(
      (event) =>
        event.type === 'zoneChange' &&
        event.payload['from'] === 'library' &&
        event.payload['to'] === 'hand',
    );
    expect(moveIndex).toBeGreaterThan(revealIndex);
    expect(ctx.state.eventLog.some((event) => event.type === 'draw')).toBe(false);
    const opponent = JSON.stringify(buildPlayerView(ctx, 'P2'));
    expect(opponent).toContain(cards[0]!.name);
    for (const card of cards.slice(1)) expect(opponent).not.toContain(card.name);
  });

  it('pr09-look-private — keeps an unrevealed hand choice out of every opponent view', () => {
    const { ctx, cards, run } = setup(false);
    pump(run());
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
    expect(JSON.stringify(buildPlayerView(ctx, 'P1'))).toContain(cards[0]!.name);
    const opponent = JSON.stringify(buildPlayerView(ctx, 'P2'));
    for (const card of cards) expect(opponent).not.toContain(card.name);
  });

  it('pr09-look-suspension — leaves the library intact while the private choice is pending', () => {
    const { ctx, player, cards, run } = setup();
    const gen = run();
    const step = gen.next();
    expect(step.done).toBe(false);
    expect(player.library.map((card) => card.cardId)).toEqual(cards.map((card) => card.cardId));
    for (const card of cards)
      expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain(card.name);
    gen.return(undefined);
  });

  it('pr09-look-filter — offers only matching cards in the looked-at set, never the tail', () => {
    const { cards, run } = setup();
    const { decisions } = pump(run());
    const options = JSON.stringify(decisions[0]?.options);
    for (const index of [0, 2, 4]) expect(options).toContain(cards[index]!.name);
    for (const index of [1, 3, 5, 6, 7]) expect(options).not.toContain(cards[index]!.name);
  });

  it('pr09-look-order-suspension — keeps all cards in the library while choosing their order', () => {
    const { player, cards, effect, run } = setup();
    delete effect.mayPut;
    effect.rest = 'topAnyOrder';
    const gen = run();
    const step = gen.next();
    expect(step.done).toBe(false);
    expect(player.library).toEqual(cards);
    expect(gen.next({ index: 0, targets: new Map() }).done).toBe(true);
    expect(player.library).toEqual(cards);
  });

  it('pr09-look-library-top — keeps a chosen top card above the ordered remainder without zone changes', () => {
    const { ctx, player, cards, effect, run } = setup(false);
    effect.mayPut!.destination = { zone: 'libraryTop' };
    effect.rest = 'topAnyOrder';
    pump(run(), (decision) => ({
      index: decision.options.some((option) => option.type === 'putFromTop') ? 1 : 0,
      targets: new Map(),
    }));
    expect(player.library).toEqual([cards[2], cards[0], cards[1], ...cards.slice(3)]);
    expect(ctx.state.eventLog.some((event) => event.type === 'zoneChange')).toBe(false);
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain(cards[2]!.name);
  });

  it('pr09-look-replacement — preserves membership during a chosen card destination replacement', () => {
    const { ctx, player, cards, run } = setup();
    cards[0]!.isCommander = true;
    const gen = run();
    expect(gen.next().done).toBe(false);
    const replacement = gen.next({ index: 0, targets: new Map() });
    expect(replacement.done).toBe(false);
    if (replacement.done) throw new Error('Expected commander replacement');
    expect(replacement.value.decisionType).toBe('commanderReplacement');
    expect(player.library).toEqual(cards);
    expect(gen.next({ index: 0, targets: new Map() }).done).toBe(true);
    expect(player.hand).toHaveLength(0);
    expect(player.commandZone.some((card) => card.cardId === cards[0]!.cardId)).toBe(true);
    expect(new Set(player.library.map((card) => card.cardId))).toEqual(
      new Set(cards.slice(1).map((card) => card.cardId)),
    );
    expect(ctx.state.eventLog.filter((event) => event.type === 'zoneChange')).toHaveLength(1);
  });

  it('pr09-look-decline — reveals nothing and randomly bottoms the entire looked-at set', () => {
    const { ctx, player, cards, run } = setup();
    pump(run(), (decision) => ({
      index: decision.options.findIndex((option) => option.type === 'decline'),
      targets: new Map(),
    }));
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
    expect(player.hand).toHaveLength(0);
    expect(player.library.slice(0, 2)).toEqual(cards.slice(6));
    expect(new Set(player.library.map((card) => card.cardId))).toEqual(
      new Set(cards.map((card) => card.cardId)),
    );
    const opponent = JSON.stringify(buildPlayerView(ctx, 'P2'));
    for (const card of cards) expect(opponent).not.toContain(card.name);
  });

  it('pr09-look-no-match — still bottoms the looked-at cards without a selection or reveal', () => {
    const { ctx, player, cards, run } = setup();
    player.library = cards.filter((_, index) => index % 2 === 1);
    const before = [...player.library];
    expect(pump(run()).decisions).toHaveLength(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
    expect(new Set(player.library.map((card) => card.cardId))).toEqual(
      new Set(before.map((card) => card.cardId)),
    );
  });

  it('pr09-look-empty — neither asks a choice nor draws or loses from an empty library', () => {
    const { ctx, player, run } = setup();
    player.library.length = 0;
    const life = player.life;
    expect(pump(run()).decisions).toHaveLength(0);
    expect(player.life).toBe(life);
    expect(player.hasLost).toBe(false);
    expect(ctx.state.eventLog).toHaveLength(0);
  });

  it('pr09-look-short — handles a library smaller than six without duplication or extra moves', () => {
    const { ctx, player, cards, run } = setup();
    player.library = cards.slice(0, 3);
    pump(run());
    expect(player.library).toHaveLength(2);
    expect(player.hand.map((card) => card.cardId)).toEqual([cards[0]!.cardId]);
    expect(new Set(player.library.map((card) => card.cardId))).toEqual(
      new Set(cards.slice(1, 3).map((card) => card.cardId)),
    );
    expect(ctx.state.eventLog.filter((event) => event.type === 'zoneChange')).toHaveLength(1);
  });

  it('pr09-look-random — replays seeded bottom ordering and preserves the untouched tail', () => {
    const order = (seed: string) => {
      const { player, cards, run } = setup(true, seed);
      pump(run());
      expect(player.library.slice(0, 2)).toEqual(cards.slice(6));
      expect(new Set([...player.hand, ...player.library].map((card) => card.cardId)).size).toBe(8);
      return player.library.map((card) => card.name);
    };
    expect(order('pr09-replay')).toEqual(order('pr09-replay'));
    expect(
      new Set(Array.from({ length: 8 }, (_, i) => order(`pr09-${i}`).join('|'))).size,
    ).toBeGreaterThan(1);
  });
});
