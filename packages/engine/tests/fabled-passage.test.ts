import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { Ability } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import { conflictingRegistrations, failedRegistrations } from '../src/cards/overrides';
import { executeAbility } from '../src/effects/resolve';
import { resolveTopOfStack } from '../src/stack/stack';
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
const fabled = fixture.cards.find((entry) => entry.card.name === 'Fabled Passage');
if (fabled === undefined) throw new Error('missing pinned Fabled Passage fixture');

function pod(seed = 'fabled-passage'): GameContext {
  const ctx = createGame(
    gameConfig(
      [
        { cards: copies(8, forest) },
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
  return ctx.state.players.find((candidate) => candidate.id === 'P1')!;
}

function ability(): Ability {
  return interpretCard(fabled!.card).activatedAbilities[0]!.ability;
}

function resolveSearch(ctx: GameContext, choice: string) {
  return pump(
    executeAbility(
      ctx,
      {
        cardId: 'fabled-source',
        oracleId: fabled!.card.oracleId,
        name: fabled!.card.name,
        controllerId: 'P1',
      },
      ability(),
      [],
    ),
    (decision) =>
      decision.prompt.includes('search your library')
        ? pick(decision, choice)
        : { index: 0, targets: new Map() },
  );
}

describe('Fabled Passage', () => {
  it('fabled-passage-production-registry-definition', () => {
    const definition = interpretCard(fabled.card);
    expect(failedRegistrations).toEqual([]);
    expect(
      conflictingRegistrations.filter((entry) => entry.oracleId === fabled.card.oracleId),
    ).toEqual([]);
    expect(definition.modeled).toBe(true);
    expect(definition.activatedAbilities).toHaveLength(1);
    expect(definition.activatedAbilities[0]?.ability.effects).toEqual(
      expect.arrayContaining([expect.objectContaining({ op: 'searchLibrary' })]),
    );
  });

  it('fabled-passage-pinned-oracle-supported — pins exact Oracle and both supported ids', () => {
    expect(fabled.sha256).toBe('fd064f3f1c8289f7cd3a05433a31b03a8676ba4ce9035cd6706bd37087c9a7ef');
    expect(fabled.card.oracleText).toBe(
      '{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle. Then if you control four or more lands, untap that land.',
    );
    expect(interpretCard(fabled.card).modeled).toBe(true);
    expect(interpretCard({ ...fabled.card, oracleId: 'oracle-fabled-passage' }).modeled).toBe(true);
  });

  it('fabled-passage-bound-found-land — checks the post-entry fourth land and untaps that card', () => {
    const ctx = pod('four-lands');
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', island());
    const found = conjure(ctx, 'P1', forest(), 'library');
    player(ctx).library = [found];

    resolveSearch(ctx, 'Put Forest onto the battlefield tapped');

    const permanent = ctx.state.battlefield.find((entry) => entry.cardId === found.cardId);
    expect(permanent?.tapped).toBe(false);
    expect(ctx.state.battlefield.filter((entry) => entry.controllerId === 'P1')).toHaveLength(4);
  });

  it('fabled-passage-three-lands-stays-tapped — checks land count after entry', () => {
    const ctx = pod('three-lands');
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', island());
    const found = conjure(ctx, 'P1', forest(), 'library');
    player(ctx).library = [found];

    resolveSearch(ctx, 'Put Forest onto the battlefield tapped');

    expect(ctx.state.battlefield.find((entry) => entry.cardId === found.cardId)?.tapped).toBe(true);
  });

  it('fabled-passage-fail-to-find — offers the hidden-zone failure and untaps no other land', () => {
    const ctx = pod('fail-to-find');
    const existing = spawn(ctx, 'P1', forest());
    existing.tapped = true;
    const hidden = conjure(ctx, 'P1', forest(), 'library');
    player(ctx).library = [hidden];

    const result = resolveSearch(ctx, 'Find nothing');

    expect(
      result.decisions.some((decision) =>
        decision.options.some((option) => option.description === 'Find nothing'),
      ),
    ).toBe(true);
    expect(existing.tapped).toBe(true);
    expect(player(ctx).library.some((card) => card.cardId === hidden.cardId)).toBe(true);
  });

  it('fabled-passage-stable-binding — does not untap another same-name land', () => {
    const ctx = pod('same-name');
    const existing = spawn(ctx, 'P1', forest());
    existing.tapped = true;
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', island());
    const found = conjure(ctx, 'P1', forest(), 'library');
    player(ctx).library = [found];

    resolveSearch(ctx, 'Put Forest onto the battlefield tapped');

    expect(existing.tapped).toBe(true);
    expect(ctx.state.battlefield.find((entry) => entry.cardId === found.cardId)?.tapped).toBe(
      false,
    );
  });

  it('fabled-passage-normal-activation — pays tap and sacrifice before stack resolution', () => {
    const ctx = pod('normal-activation');
    const passage = spawn(ctx, 'P1', fabled.card);
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', forest());
    spawn(ctx, 'P1', island());
    const found = conjure(ctx, 'P1', forest(), 'library');
    player(ctx).library = [found];
    const activation = computePriorityOptions(ctx, player(ctx)).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === passage.id;
    });
    expect(activation).toBeDefined();
    pump(
      applyPriorityAction(ctx, player(ctx), activation!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(ctx.state.stack).toHaveLength(1);
    pump(resolveTopOfStack(ctx), (decision) =>
      decision.prompt.includes('search your library')
        ? pick(decision, 'Put Forest onto the battlefield tapped')
        : { index: 0, targets: new Map() },
    );

    expect(player(ctx).graveyard.some((card) => card.cardId === passage.cardId)).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'activateAbility')).toBe(true);
    expect(ctx.state.battlefield.find((entry) => entry.cardId === found.cardId)?.tapped).toBe(
      false,
    );
  });

  it('fabled-passage-countered-ability — keeps activation costs paid and searches nothing', () => {
    const ctx = pod('countered');
    const passage = spawn(ctx, 'P1', fabled.card);
    const found = conjure(ctx, 'P1', forest(), 'library');
    player(ctx).library = [found];
    const activation = computePriorityOptions(ctx, player(ctx)).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === passage.id;
    });
    expect(activation).toBeDefined();
    pump(
      applyPriorityAction(ctx, player(ctx), activation!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
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

    expect(player(ctx).graveyard.some((card) => card.cardId === passage.cardId)).toBe(true);
    expect(player(ctx).library.some((card) => card.cardId === found.cardId)).toBe(true);
    expect(ctx.state.stack).toHaveLength(0);
  });

  it('fabled-passage-search-privacy — reveals the found battlefield card but no other library card', () => {
    const ctx = pod('privacy');
    const found = conjure(ctx, 'P1', forest(), 'library');
    const secret = conjure(
      ctx,
      'P1',
      oracle({ name: 'Private Library Secret', typeLine: 'Creature — Secret' }),
      'library',
    );
    player(ctx).library = [found, secret];

    resolveSearch(ctx, 'Put Forest onto the battlefield tapped');

    const opponentView = JSON.stringify(buildPlayerView(ctx, 'P2'));
    expect(opponentView).toContain('searchFound');
    expect(opponentView).toContain('Forest');
    expect(opponentView).not.toContain('Private Library Secret');
  });

  it('fabled-passage-seeded-search-replay — reproduces the state and event stream', () => {
    const run = () => {
      const ctx = pod('replay');
      spawn(ctx, 'P1', forest());
      spawn(ctx, 'P1', forest());
      spawn(ctx, 'P1', island());
      const found = conjure(ctx, 'P1', forest(), 'library');
      player(ctx).library = [found, ...player(ctx).library.filter((card) => card !== found)];
      resolveSearch(ctx, 'Put Forest onto the battlefield tapped');
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
