import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { executeAbility } from '../src/effects/resolve';
import { manaSourcesFor } from '../src/state/queries';
import { moveObject } from '../src/state/objects';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { createGame } from '../src/state/game';
import type { GameContext } from '../src/state/types';
import { buildPlayerView } from '../src/view/view';
import { conjure, copies, forest, gameConfig, island, oracle, pick, pump, spawn } from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/marchesa-batch1-oracle.json'), 'utf8'),
) as PinnedFixture;
const myriad = fixture.cards.find((entry) => entry.card.name === 'Myriad Landscape');
if (myriad === undefined) throw new Error('missing pinned Myriad Landscape fixture');

const snowfieldExpanse = () =>
  oracle({
    oracleId: 'test-snowfield-expanse',
    name: 'Test Snowfield Expanse',
    typeLine: 'Basic Land — Plains Island',
    manaCost: '',
    cmc: 0,
  });
const prairieStream = () =>
  oracle({
    oracleId: 'test-prairie-stream',
    name: 'Prairie Stream',
    typeLine: 'Land — Plains Island',
    manaCost: '',
    cmc: 0,
  });

function pod(seed = 'myriad-landscape'): GameContext {
  const ctx = createGame(
    gameConfig(
      [
        { cards: copies(10, forest) },
        { cards: copies(8, forest) },
        { cards: copies(8, forest) },
        { cards: copies(8, forest) },
      ],
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

function player(ctx: GameContext) {
  return ctx.state.players.find((seat) => seat.id === 'P1')!;
}

function activation(ctx: GameContext, objectId: string) {
  return computePriorityOptions(ctx, player(ctx)).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === objectId;
  });
}

function activate(ctx: GameContext) {
  const landscape = spawn(ctx, 'P1', myriad!.card);
  const firstMana = spawn(ctx, 'P1', forest());
  const secondMana = spawn(ctx, 'P1', forest());
  const option = activation(ctx, landscape.id);
  expect(option).toBeDefined();
  pump(
    applyPriorityAction(ctx, player(ctx), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  return { landscape, firstMana, secondMana };
}

function resolveSearch(ctx: GameContext, choice: string) {
  return pump(resolveTopOfStack(ctx), (decision) =>
    decision.prompt.includes('search your library')
      ? pick(decision, choice)
      : { index: 0, targets: new Map() },
  );
}

describe('Myriad Landscape product definition', () => {
  it('pins exact Oracle and registers the faithful product definition', () => {
    expect(myriad.sha256).toBe('696f038611a9d1540a151ab63ccc13e36fd4aa355a54806e741eb6a44f77442b');
    expect(myriad.card.oracleText).toBe(
      'This land enters tapped.\n{T}: Add {C}.\n{2}, {T}, Sacrifice this land: Search your library for up to two basic land cards that share a land type, put them onto the battlefield tapped, then shuffle.',
    );
    expect(interpretCard(myriad.card).modeled).toBe(true);
    expect(interpretCard({ ...myriad.card, oracleId: 'oracle-myriad-landscape' }).modeled).toBe(
      true,
    );
  });

  it('myriad-landscape-enters-tapped — preserves the generic tapped entry and colorless mana ability', () => {
    const ctx = pod('entry-and-mana');
    const object = conjure(ctx, 'P1', myriad.card, 'hand');
    pump(moveObject(ctx, object, { zone: 'battlefield', controllerId: 'P1' }));
    const permanent = ctx.state.battlefield.find((entry) => entry.cardId === object.cardId)!;

    expect(permanent.tapped).toBe(true);
    permanent.tapped = false;
    expect(
      manaSourcesFor(ctx, 'P1').find((source) => source.cardId === permanent.cardId)?.units,
    ).toEqual([['C']]);
  });

  /**
   * A mana ability is activated by the payment solver rather than at priority
   * (`manaSourcesFor`), so its normal path is paying a real cost with it — not a definition-shape
   * assertion.
   */
  it('myriad-landscape-colorless-mana-normal-activation — pays a real spell cost with {C}', () => {
    const ctx = pod('colorless-mana-payment');
    const landscape = spawn(ctx, 'P1', myriad!.card);
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Myriad Mana Sink', typeLine: 'Artifact', manaCost: '{1}', cmc: 1 }),
      'hand',
    );
    expect(landscape.tapped).toBe(false);

    let cast = false;
    pump(runPrioritySequence(ctx), (decision) => {
      if (decision.player === 'P1' && !cast) {
        cast = true;
        return pick(decision, 'Cast Myriad Mana Sink');
      }
      return pick(decision, 'Pass');
    });

    expect(ctx.state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
    expect(
      ctx.state.battlefield.find((permanent) => permanent.cardId === landscape.cardId)?.tapped,
    ).toBe(true);
    expect(ctx.state.battlefield.some((permanent) => permanent.name === 'Myriad Mana Sink')).toBe(
      true,
    );
  });

  it('myriad-landscape-shared-land-type-search — offers exactly the legal zero-, one-, and two-card grouped choices', () => {
    const ctx = pod('grouped-options');
    activate(ctx);
    const foundIsland = conjure(ctx, 'P1', island(), 'library');
    const foundDual = conjure(ctx, 'P1', snowfieldExpanse(), 'library');
    const disjointForest = conjure(ctx, 'P1', forest(), 'library');
    const nonbasic = conjure(ctx, 'P1', prairieStream(), 'library');
    player(ctx).library = [foundIsland, foundDual, disjointForest, nonbasic];

    const step = resolveTopOfStack(ctx).next();
    if (step.done) throw new Error('expected grouped library-search decision');
    const descriptions = step.value.options.map((option) => option.description);

    expect(descriptions).toContain('Find nothing');
    expect(descriptions).toContain('Put Island onto the battlefield tapped');
    expect(descriptions).toContain('Put Test Snowfield Expanse onto the battlefield tapped');
    expect(descriptions).toContain(
      'Put Island and Test Snowfield Expanse onto the battlefield tapped',
    );
    expect(descriptions.some((description) => description.includes('Prairie Stream'))).toBe(false);
    expect(descriptions).not.toContain('Put Forest and Island onto the battlefield tapped');
  });

  it.each([
    { testId: 'myriad-landscape-search-zero', choice: 'Find nothing', expectedCount: 0 },
    {
      testId: 'myriad-landscape-search-one',
      choice: 'Put Island onto the battlefield tapped',
      expectedCount: 1,
    },
    {
      testId: 'myriad-landscape-search-two',
      choice: 'Put Island and Test Snowfield Expanse onto the battlefield tapped',
      expectedCount: 2,
    },
  ])('$testId', ({ choice, expectedCount }) => {
    const ctx = pod(`choice-${expectedCount}`);
    const { landscape, firstMana, secondMana } = activate(ctx);
    const foundIsland = conjure(ctx, 'P1', island(), 'library');
    const foundDual = conjure(ctx, 'P1', snowfieldExpanse(), 'library');
    player(ctx).library = [foundIsland, foundDual];

    expect(player(ctx).graveyard.some((card) => card.cardId === landscape.cardId)).toBe(true);
    expect(firstMana.tapped).toBe(true);
    expect(secondMana.tapped).toBe(true);
    expect(ctx.state.stack).toHaveLength(1);
    resolveSearch(ctx, choice);

    const found = ctx.state.battlefield.filter((entry) =>
      [foundIsland.cardId, foundDual.cardId].includes(entry.cardId),
    );
    expect(found).toHaveLength(expectedCount);
    expect(found.every((entry) => entry.tapped)).toBe(true);
  });

  it('does not offer the activation when mana is short or the source is tapped', () => {
    const short = pod('short-mana');
    const landscape = spawn(short, 'P1', myriad.card);
    spawn(short, 'P1', forest());
    expect(activation(short, landscape.id)).toBeUndefined();

    const tapped = pod('tapped-source');
    const tappedLandscape = spawn(tapped, 'P1', myriad.card, { tapped: true });
    spawn(tapped, 'P1', forest());
    spawn(tapped, 'P1', forest());
    expect(activation(tapped, tappedLandscape.id)).toBeUndefined();
  });

  it('keeps mana and sacrifice costs paid when the ability is countered', () => {
    const ctx = pod('countered');
    const { landscape, firstMana, secondMana } = activate(ctx);
    const found = conjure(ctx, 'P1', island(), 'library');
    player(ctx).library = [found];
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

    expect(player(ctx).graveyard.some((card) => card.cardId === landscape.cardId)).toBe(true);
    expect(firstMana.tapped).toBe(true);
    expect(secondMana.tapped).toBe(true);
    expect(player(ctx).library.some((card) => card.cardId === found.cardId)).toBe(true);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('publicly reports found cards without exposing other private library cards', () => {
    const ctx = pod('privacy');
    activate(ctx);
    const foundIsland = conjure(ctx, 'P1', island(), 'library');
    const foundDual = conjure(ctx, 'P1', snowfieldExpanse(), 'library');
    const secret = conjure(
      ctx,
      'P1',
      oracle({ name: 'Myriad Private Library Secret', typeLine: 'Creature — Secret' }),
      'library',
    );
    player(ctx).library = [foundIsland, foundDual, secret];
    resolveSearch(ctx, 'Put Island and Test Snowfield Expanse onto the battlefield tapped');

    const opponentView = JSON.stringify(buildPlayerView(ctx, 'P2'));
    expect(opponentView).toContain('searchFound');
    expect(opponentView).toContain('Island');
    expect(opponentView).toContain('Test Snowfield Expanse');
    expect(opponentView).not.toContain('Myriad Private Library Secret');
  });

  it('replays the grouped choice deterministically', () => {
    const run = () => {
      const ctx = pod('replay');
      activate(ctx);
      const foundIsland = conjure(ctx, 'P1', island(), 'library');
      const foundDual = conjure(ctx, 'P1', snowfieldExpanse(), 'library');
      player(ctx).library = [foundIsland, foundDual];
      resolveSearch(ctx, 'Put Island and Test Snowfield Expanse onto the battlefield tapped');
      return ctx.state;
    };
    const first = run();
    const second = run();
    const projection = (state: typeof first) => ({
      libraries: state.players.map((seat) => seat.library.map((card) => card.name)),
      battlefield: state.battlefield.map((permanent) => ({
        name: permanent.name,
        controllerId: permanent.controllerId,
        tapped: permanent.tapped,
      })),
      graveyards: state.players.map((seat) => seat.graveyard.map((card) => card.name)),
      events: state.eventLog.map((event) => ({
        type: event.type,
        actorSeat: event.actorSeat,
        name: event.payload['name'],
        to: event.payload['to'],
        player: event.payload['player'],
      })),
    });
    const hash = (state: typeof first) =>
      createHash('sha256')
        .update(JSON.stringify(projection(state)))
        .digest('hex');
    expect(hash(second)).toBe(hash(first));
    expect(projection(second)).toEqual(projection(first));
  });
});
