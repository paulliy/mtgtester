import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction } from '@mtg/shared';
import { strictCardTestScenario } from './card-test-scenarios';
import { formatPlayerLog } from '../../../engine/src/view/spectator';
import type { GameContext } from '../../../engine/src/state/types';

type Mode = 'you-and-opponent' | 'two-opponents-empty-library';

/** The two card-test-lab scenarios for Scheming Symmetry, driven through the real engine. */
const SCENARIOS = {
  'you-and-opponent': { picks: ['P1', 'P2'] },
  'two-opponents-empty-library': { picks: ['P2', 'P3'] },
} as const;

interface Observation {
  ctx: GameContext;
  /** One entry per surfaced search menu, in the order the engine asked for it. */
  searches: { player: string; options: LegalAction[]; shufflesSoFar: string[] }[];
  /** The counted target menus, in slot order; P1 must be gone from every menu after it is picked. */
  targetMenus: LegalAction[][];
  /** The seat actually chosen for each target slot, in slot order. */
  slotPicks: string[];
  /** The legal actions P1 was offered at the final priority window we stopped on. */
  finalMenu: LegalAction[];
  castOptions: LegalAction[];
  paidSwamps: number;
  /** The exact projection the browser receives for the viewing seat. */
  p1Wire: unknown;
}

function shufflers(ctx: GameContext): string[] {
  return ctx.state.eventLog
    .filter((event) => event.type === 'shuffle')
    .map((event) => String(event.payload['player']));
}

function player(ctx: GameContext, id: string) {
  const found = ctx.state.players.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no player ${id}`);
  return found;
}

/**
 * The publicly narrated event stream: everything except the internal `decision` events, which
 * record what a seat privately chose and are filtered out of the player-facing log.
 */
function publicEvents(ctx: GameContext) {
  return ctx.state.eventLog.filter((event) => event.type !== 'decision');
}

/**
 * Replay one prepared scenario with `engine.advance()`/`engine.submit()`, answering every request
 * the way the lab's own scripted seats do. P2/P3 searches go through the scenario's real
 * `decisionProviderOverrides` rather than a reimplementation, and the loop stops at the first
 * priority window after the spell resolves — never running on into the automatic game over.
 */
function replay(mode: Mode, options: { castWitness: boolean }): Observation {
  const scenario = strictCardTestScenario(`scheming-symmetry-viewer-${mode}`, 'symmetry-replay');
  expect(scenario).not.toBeNull();
  const engine = scenario!.engine;
  const ctx = (engine as unknown as { ctx: GameContext }).ctx;
  const { picks } = SCENARIOS[mode];
  const observation: Observation = {
    ctx,
    searches: [],
    targetMenus: [],
    slotPicks: [],
    finalMenu: [],
    castOptions: [],
    paidSwamps: 0,
    p1Wire: null,
  };
  let slot = 0;
  let cast = false;
  let symmetryResolved = false;

  for (let decisions = 0; decisions < 60; decisions++) {
    const step = engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request: DecisionRequest = step.request;
    const actions = request.legalActions;
    const submit = (actionId: number): void => {
      engine.submit({ requestId: request.requestId, actionId });
    };

    // Record every private search menu the engine surfaces, whoever is asked.
    const searching = actions.some((action) => action.type === 'search');
    if (searching) {
      observation.searches.push({
        player: request.decidingPlayer,
        options: actions,
        // Every hidden selection is made before any library is shuffled (CR 701.19b).
        shufflesSoFar: shufflers(ctx),
      });
    }
    // The seats the scenario scripts answer their own private search; nothing else.
    const scripted = scenario!.decisionProviderOverrides?.[request.decidingPlayer];
    if (scripted !== undefined && searching) {
      engine.submit(scripted.decide(request));
      continue;
    }
    if (request.decidingPlayer !== 'P1') {
      const pass = actions.find((action) => action.type === 'pass');
      if (pass === undefined) throw new Error('non-P1 seat has no pass option');
      submit(pass.id);
      continue;
    }

    const castSymmetry = actions.find((action) =>
      action.description?.startsWith('Cast Scheming Symmetry'),
    );
    if (castSymmetry !== undefined && !cast) {
      observation.castOptions = actions;
      cast = true;
      submit(castSymmetry.id);
      continue;
    }

    if (actions.length > 0 && actions.every((action) => action.type === 'pickTarget')) {
      observation.targetMenus.push(actions);
      const want = picks[slot]!;
      const pick = actions.find((action) => action.description === `Target ${want}`);
      expect(pick, `target ${slot} offers ${want}`).toBeDefined();
      observation.slotPicks.push(want);
      slot++;
      submit(pick!.id);
      continue;
    }

    const own = actions.find((action) => action.type === 'search');
    if (own !== undefined) {
      const pick = actions.find((action) => action.description === 'Choose Lab Symmetry P1 Alpha');
      expect(pick, 'P1 is offered its own library card').toBeDefined();
      submit(pick!.id);
      continue;
    }

    const witness = actions.find((action) =>
      action.description?.startsWith('Cast Lab Symmetry Draw Witness'),
    );
    const onStack = ctx.state.stack.some((spell) => spell.description === 'Scheming Symmetry');
    if (witness !== undefined && !onStack && ctx.state.eventLog.some((e) => e.type === 'shuffle')) {
      symmetryResolved = true;
      if (options.castWitness) {
        submit(witness.id);
        continue;
      }
      observation.finalMenu = actions;
      break;
    }
    if (symmetryResolved && ctx.state.stack.length === 0 && options.castWitness) {
      const hand = player(ctx, 'P1').hand;
      if (hand.some((card) => card.name === 'Lab Symmetry P1 Alpha')) {
        observation.finalMenu = actions;
        break;
      }
    }

    const pass = actions.find((action) => action.type === 'pass');
    if (pass === undefined) throw new Error('P1 has no pass option');
    submit(pass.id);
  }

  observation.paidSwamps = ctx.state.eventLog.filter(
    (event) => event.type === 'tapForMana' && event.payload['name'] === 'Swamp',
  ).length;
  observation.p1Wire = engine.playerState('P1');
  return observation;
}

describe('Scheming Symmetry Card Test Lab', () => {
  it('symmetry-lab-you-and-opponent — both seats search their own library and the chosen card is proven by drawing it', () => {
    const run = replay('you-and-opponent', { castWitness: true });
    const { ctx } = run;

    // The printed {B} cost is offered and really paid from P1's single Swamp.
    expect(run.castOptions.map((action) => action.description)).toContain(
      'Cast Scheming Symmetry ({B})',
    );
    expect(run.paidSwamps).toBe(1);

    // Two ordinary counted target pickers: the second excludes the first pick (no duplicates).
    expect(run.targetMenus).toHaveLength(2);
    expect(run.targetMenus[0]!.map((action) => action.description)).toEqual([
      'Target P1',
      'Target P2',
      'Target P3',
      'Target P4',
    ]);
    expect(run.targetMenus[1]!.map((action) => action.description)).toEqual([
      'Target P2',
      'Target P3',
      'Target P4',
    ]);
    expect(run.slotPicks).toEqual(['P1', 'P2']);

    // Each target privately searches their OWN library: P1 is never offered P2's cards.
    expect(run.searches.map((entry) => entry.player)).toEqual(['P1', 'P2']);
    for (const entry of run.searches) {
      expect(entry.options.every((action) => action.type === 'search')).toBe(true);
      expect(entry.options.some((action) => action.type === 'decline')).toBe(false);
      expect(entry.options.map((action) => action.description)).toEqual([
        `Choose Lab Symmetry ${entry.player} Alpha`,
        `Choose Lab Symmetry ${entry.player} Beta`,
      ]);
    }

    // APNAP from the active player, and every choice is made before any shuffle runs.
    expect(shufflers(ctx)).toEqual(['P1', 'P2']);
    for (const entry of run.searches) expect(entry.shufflesSoFar).toEqual([]);

    // Each chosen card sits on its owner's top, keeping its library object identity.
    const chosen = new Map(
      run.searches.map((entry) => [
        entry.player,
        player(ctx, entry.player).library.find((card) => card.name.includes(entry.player))!,
      ]),
    );
    expect(player(ctx, 'P1').library[0]!.id).toBe(chosen.get('P1')!.id);
    expect(player(ctx, 'P2').library[0]!.id).toBe(chosen.get('P2')!.id);

    // The positive proof: casting the draw witness afterwards yields P1's own chosen card.
    expect(player(ctx, 'P1').hand.map((card) => card.name)).toContain('Lab Symmetry P1 Alpha');
    expect(player(ctx, 'P1').library.map((card) => card.name)).not.toContain(
      'Lab Symmetry P1 Alpha',
    );
    expect(player(ctx, 'P1').graveyard.map((card) => card.name)).toContain('Scheming Symmetry');

    // Nothing about P2's private choice reaches P1's wire or the public log. The internal
    // `decision` events do record what each seat chose, so they are excluded here: what P1 is
    // shown is the player-facing log projection plus the public (non-decision) event stream.
    expect(JSON.stringify(run.p1Wire)).not.toMatch(/Lab Symmetry P2/);
    expect(JSON.stringify(formatPlayerLog(ctx.state.eventLog, 'P1'))).not.toMatch(
      /Lab Symmetry P2/,
    );
    expect(JSON.stringify(publicEvents(ctx))).not.toMatch(/Lab Symmetry P[23]/);
  });

  it('symmetry-lab-two-opponents-empty-library — the empty target still shuffles and the untargeted caster library is untouched', () => {
    const scenario = strictCardTestScenario(
      'scheming-symmetry-viewer-two-opponents-empty-library',
      'symmetry-replay',
    )!;
    const pristine = (scenario.engine as unknown as { ctx: GameContext }).ctx.state.players.map(
      (entry) => [...entry.library],
    );

    const run = replay('two-opponents-empty-library', { castWitness: false });
    const { ctx } = run;

    // P1 is not a target, so P1 is never shown a search menu at all.
    expect(run.slotPicks).toEqual(['P2', 'P3']);
    expect(run.searches.map((entry) => entry.player)).toEqual(['P3']);
    // The second slot still refuses to reuse P2, so the two targets are always distinct players.
    expect(run.targetMenus[1]!.map((action) => action.description)).not.toContain('Target P2');
    expect(run.targetMenus[1]!.map((action) => action.description)).toContain('Target P3');

    // The empty legal target needs no choice, yet both legal targets still shuffle, in APNAP order.
    expect(player(ctx, 'P2').library).toEqual([]);
    expect(shufflers(ctx)).toEqual(['P2', 'P3']);
    expect(run.searches[0]!.shufflesSoFar).toEqual([]);

    // P3's private choice really lands on top of P3's own shuffled library.
    expect(player(ctx, 'P3').library[0]!.name).toBe('Lab Symmetry P3 Alpha');
    expect(player(ctx, 'P3').library).toHaveLength(2);

    // P1's library is untouched: same objects, same order, and never shuffled.
    const after = ctx.state.players.map((entry) => [...entry.library]);
    expect(after[0]).toHaveLength(pristine[0]!.length);
    after[0]!.forEach((card, index) => expect(card.id).toBe(pristine[0]![index]!.id));
    expect(after[0]!.map((card) => card.name)).toEqual(pristine[0]!.map((card) => card.name));

    // The kept witness is still castable in the final priority window we stopped on.
    expect(run.finalMenu.map((action) => action.description)).toEqual([
      'Pass priority',
      'Pass and yield until end of turn',
      'Cast Lab Symmetry Draw Witness ({0})',
      'Cast Lab Priority Witness ({0})',
    ]);

    // P3's private identity never reaches P1's wire or the public log.
    expect(JSON.stringify(run.p1Wire)).not.toMatch(/Lab Symmetry P[23]/);
    expect(JSON.stringify(formatPlayerLog(ctx.state.eventLog, 'P1'))).not.toMatch(
      /Lab Symmetry P[23]/,
    );
    expect(JSON.stringify(publicEvents(ctx))).not.toMatch(/Lab Symmetry P[23]/);
  });

  it('symmetry-lab-deterministic — both scenarios replay to identical event streams', () => {
    const first = replay('you-and-opponent', { castWitness: true });
    const second = replay('you-and-opponent', { castWitness: true });
    expect(first.ctx.state.eventLog).toEqual(second.ctx.state.eventLog);
    const emptyFirst = replay('two-opponents-empty-library', { castWitness: false });
    const emptySecond = replay('two-opponents-empty-library', { castWitness: false });
    expect(emptyFirst.ctx.state.eventLog).toEqual(emptySecond.ctx.state.eventLog);
  });
});
