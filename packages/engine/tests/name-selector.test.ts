/**
 * The `name` selector leaf ("creatures named Lightning Rager", "a card named Galactus, Devourer of
 * Worlds"): a permanent's CURRENT name (CR 201.2, after copy effects and with none for a face-down
 * permanent, CR 708.2), the printed name of a library, graveyard or hand card, and the name a
 * permanent had when it left the battlefield (last known information, CR 608.2h).
 */
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { validateExpression } from '../src/cards/expression-validation';
import type { AuthoringIssue } from '../src/cards/authoring-validation';
import {
  named,
  selectMatches,
  selectorIsEventOnly,
  type SelectorCandidate,
} from '../src/cards/selector';
import { spell } from '../src/cards/templates';
import { captureObjectFacts } from '../src/cards/source-identity';
import { executeAbility } from '../src/effects/resolve';
import { matchesSelector, selectPermanents } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { applyCopy } from '../src/state/objects';
import { graveyardTargets } from '../src/state/queries';
import { runPrioritySequence } from '../src/turn/priority';
import type { GameContext } from '../src/state/types';
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

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1].map(() => ({ cards: copies(3, forest) })),
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

const CREATURE = (name: string): OracleCard =>
  oracle({ name, typeLine: 'Creature — Bear', power: '2', toughness: '2' });

const SOURCE = { cardId: 'source', controllerId: 'P1' };

const candidate = (name?: string): SelectorCandidate => ({
  cardId: 'c',
  controllerId: 'P1',
  types: ['Creature'],
  supertypes: [],
  subtypes: [],
  colors: [],
  power: 2,
  keywords: [],
  isToken: false,
  enteredThisTurn: false,
  ...(name === undefined ? {} : { name }),
});

describe('name selector', () => {
  it('matches exactly the current name, never a candidate with no known name, and is not event-only', () => {
    expect(selectMatches(candidate('Lightning Rager'), named('Lightning Rager'), SOURCE)).toBe(
      true,
    );
    expect(selectMatches(candidate('Lightning Rager Two'), named('Lightning Rager'), SOURCE)).toBe(
      false,
    );
    expect(selectMatches(candidate('lightning rager'), named('Lightning Rager'), SOURCE)).toBe(
      false,
    );
    expect(selectMatches(candidate(), named('Lightning Rager'), SOURCE)).toBe(false);
    expect(selectorIsEventOnly(named('Lightning Rager'))).toBe(false);
    // Composes with the rest of the grammar.
    const issues: AuthoringIssue[] = [];
    validateExpression('selector', named('Lightning Rager'), 'selector', issues);
    expect(issues).toEqual([]);
    validateExpression('selector', { kind: 'name', value: 4 }, 'selector', issues);
    expect(issues).not.toEqual([]);
  });

  it('matches battlefield permanents by their current name, whoever controls them', () => {
    const ctx = pod('name-battlefield');
    const mine = spawn(ctx, 'P1', CREATURE('Lab Rager'));
    const theirs = spawn(ctx, 'P2', CREATURE('Lab Rager'));
    const other = spawn(ctx, 'P1', CREATURE('Lab Rager Cousin'));
    const matched = selectPermanents(ctx, named('Lab Rager'), SOURCE);
    expect(matched.map((perm) => perm.id).sort()).toEqual([mine.id, theirs.id].sort());
    expect(matchesSelector(ctx, other, named('Lab Rager'), SOURCE)).toBe(false);
    // And through a real effect: destroy each creature named Lab Rager.
    const caster = spawn(ctx, 'P1', CREATURE('Lab Caster'));
    pump(
      executeAbility(
        ctx,
        {
          cardId: caster.cardId,
          oracleId: caster.oracleId,
          name: caster.name,
          controllerId: 'P1',
        },
        spell({ effects: [{ op: 'destroyEach', selector: named('Lab Rager') }] }),
        [],
      ),
    );
    expect(ctx.state.battlefield.map((perm) => perm.name).sort()).toEqual([
      'Lab Caster',
      'Lab Rager Cousin',
    ]);
  });

  it('follows copy effects: a copy has the copied name, or the name its copy effect keeps', () => {
    const ctx = pod('name-copy');
    const original = spawn(ctx, 'P2', CREATURE('Lab Rager'));
    const clay = spawn(ctx, 'P1', CREATURE('Lab Clay'));
    expect(matchesSelector(ctx, clay, named('Lab Rager'), SOURCE)).toBe(false);
    applyCopy(ctx, clay, original);
    expect(matchesSelector(ctx, clay, named('Lab Rager'), SOURCE)).toBe(true);
    expect(matchesSelector(ctx, clay, named('Lab Clay'), SOURCE)).toBe(false);
    // "…except its name is Lab Flame": the copy keeps that name instead of the copied one.
    const flame = spawn(ctx, 'P1', CREATURE('Lab Flame Clay'));
    applyCopy(ctx, flame, original, { nameOverride: 'Lab Flame' });
    expect(matchesSelector(ctx, flame, named('Lab Flame'), SOURCE)).toBe(true);
    expect(matchesSelector(ctx, flame, named('Lab Rager'), SOURCE)).toBe(false);
  });

  it('gives a face-down permanent no name (CR 708.2)', () => {
    const ctx = pod('name-face-down');
    const hidden = spawn(ctx, 'P1', CREATURE('Lab Rager'));
    expect(matchesSelector(ctx, hidden, named('Lab Rager'), SOURCE)).toBe(true);
    hidden.faceDown = true;
    expect(matchesSelector(ctx, hidden, named('Lab Rager'), SOURCE)).toBe(false);
  });

  it('finds library cards by name: only the named card is offered, and it goes to hand', () => {
    const ctx = pod('name-library');
    const wanted = conjure(ctx, 'P1', CREATURE('Lab Target'), 'library');
    conjure(ctx, 'P1', CREATURE('Lab Decoy'), 'library');
    conjure(ctx, 'P1', CREATURE('Lab Target Twin'), 'library');
    const caster = spawn(ctx, 'P1', CREATURE('Lab Caster'));
    const run = pump(
      executeAbility(
        ctx,
        {
          cardId: caster.cardId,
          oracleId: caster.oracleId,
          name: caster.name,
          controllerId: 'P1',
        },
        spell({
          effects: [
            {
              op: 'searchLibrary',
              filter: named('Lab Target'),
              destinations: [{ zone: 'hand' }],
              reveal: true,
            },
          ],
        }),
        [],
      ),
      (decision) => {
        const find = decision.options.findIndex((option) => /Lab Target/.test(option.description));
        return { index: Math.max(find, 0), targets: new Map() };
      },
    );
    const offered = run.decisions.flatMap((decision) =>
      decision.options.map((option) => option.description),
    );
    expect(offered.some((description) => description.includes('Lab Decoy'))).toBe(false);
    expect(offered.some((description) => description.includes('Lab Target Twin'))).toBe(false);
    const hand = ctx.state.players.find((player) => player.id === 'P1')!.hand;
    expect(hand.map((card) => card.cardId)).toContain(wanted.cardId);
  });

  it('matches graveyard cards by name', () => {
    const ctx = pod('name-graveyard');
    const wanted = conjure(ctx, 'P1', CREATURE('Lab Target'), 'graveyard');
    conjure(ctx, 'P1', CREATURE('Lab Decoy'), 'graveyard');
    expect(graveyardTargets(ctx, 'P1', named('Lab Target')).map((card) => card.cardId)).toEqual([
      wanted.cardId,
    ]);
    expect(graveyardTargets(ctx, 'P1', named('Lab Missing'))).toEqual([]);
  });

  it('keeps the name in last known information, so a trigger can ask about a creature that has left', () => {
    const ctx = pod('name-lki');
    const target = spawn(ctx, 'P1', CREATURE('Lab Rager'));
    expect(captureObjectFacts(ctx, target).candidate.name).toBe('Lab Rager');
    // "Whenever a creature you control dies, if it was named Lab Rager, you gain 1 life."
    const watcherCard = oracle({
      name: 'Lab Watcher',
      typeLine: 'Creature — Wall',
      oracleText: 'Whenever a creature you control dies, you gain 1 life.',
    });
    const def = interpretCard(watcherCard);
    expect(def.modeled).toBe(true);
    const trigger = def.triggers[0]!;
    registerCustomDef(ctx, {
      ...def,
      triggers: [
        {
          ...trigger,
          trigger: {
            ...trigger.trigger!,
            condition: { kind: 'triggerObjectMatches', selector: named('Lab Rager') },
          },
        },
      ],
    });
    spawn(ctx, 'P1', watcherCard);
    const bystander = spawn(ctx, 'P1', CREATURE('Lab Bystander'));
    const caster = spawn(ctx, 'P2', CREATURE('Lab Caster'));
    const source = {
      cardId: caster.cardId,
      oracleId: caster.oracleId,
      name: caster.name,
      controllerId: 'P2',
    };
    const destroy = (id: string) =>
      pump(
        executeAbility(
          ctx,
          source,
          spell({ targets: [{ kind: 'permanent' }], effects: [{ op: 'destroy', target: 0 }] }),
          [id],
        ),
      );
    const life = () => ctx.state.players.find((player) => player.id === 'P1')!.life;
    destroy(bystander.id);
    pump(runPrioritySequence(ctx), (decision) => {
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(life()).toBe(40);
    destroy(target.id);
    pump(runPrioritySequence(ctx), (decision) => {
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(life()).toBe(41);
  });
});
