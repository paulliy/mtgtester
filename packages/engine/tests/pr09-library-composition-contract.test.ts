import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Color, OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { addMana } from '../src/mana/pool';
import { moveObject, playerById } from '../src/state/objects';
import { createGame } from '../src/state/game';
import { runCombatPhase } from '../src/combat/combat';
import { queueStepTriggers } from '../src/turn/turn';
import { runPrioritySequence } from '../src/turn/priority';
import { resolveTopOfStack } from '../src/stack/stack';
import { computeCharacteristics } from '../src/effects/continuous';
import { buildPlayerView } from '../src/view/view';
import { wardCostOf } from '../src/state/queries';
import { cleanupStep } from '../src/turn/turn';
import { manaCost, spell, counterSpellTarget } from '../src/cards/templates';
import type { CardDefinition } from '../src/cards/definition';
import type { EnginePermanent, GameContext } from '../src/state/types';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import {
  BOUNDED_PR09_LIBRARY,
  matchesBoundedPr09Library,
  type Pr09LibraryCompositionId,
} from '../../../scripts/contracts/bounded-pr09-library';
import { PR09_LIBRARY_CONTRACT_EXTENSIONS } from '../../../scripts/contracts/pr09-library-contract-extensions';
import { deriveCardCapabilities } from '../src/cards/capabilities';
import {
  conjure,
  copies,
  declareBlocks,
  declareAttacks,
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
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  Object.assign(ctx.state, {
    currentTurnPlayer: 'P1',
    activePlayerIndex: 0,
    turnNumber: 4,
    phase: 'precombatMain',
    step: null,
  });
  for (const player of ctx.state.players) player.hand = [];
  return ctx;
}

const pass = (decision: PendingDecision): DecisionOutcome => ({
  index: Math.max(
    0,
    decision.options.findIndex(
      (option) =>
        option.type === 'pass' ||
        (option.payload as Partial<PriorityActionPayload> | undefined)?.kind === 'pass',
    ),
  ),
  targets: new Map(),
});

function settle(ctx: GameContext, answer: (decision: PendingDecision) => DecisionOutcome = pass) {
  return pump(runPrioritySequence(ctx), (decision) =>
    decision.decisionType === 'priority' ? pass(decision) : answer(decision),
  );
}

const byId = (id: string) => BOUNDED_PR09_LIBRARY.find((entry) => entry.id === id)!.definition;
const capabilitySlug = (capability: string) =>
  capability
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function source(ctx: GameContext, id: string) {
  const definition = byId(id);
  registerCustomDef(ctx, structuredClone(definition));
  return spawn(
    ctx,
    'P1',
    oracle({
      oracleId: definition.oracleId,
      name: definition.name,
      typeLine: definition.typeLine,
      manaCost:
        {
          'end-step-discover-five': '{6}',
          'opponent-cast-reveal': '{4}{G}{G}',
          'cosmic-cube': '{5}',
          'aetherworks-marvel': '{4}',
          'herald-of-amity': '{3}{W}',
          'mystic-forge': '{4}',
          'dark-confidant': '{1}{B}',
          'keen-duelist': '{1}{B}',
          szarekh: '{1}{B}{B}{B}',
          'dream-pillager': '{5}{R}{R}',
        }[id] ?? null,
      colors: [...definition.colors],
      colorIdentity: [...definition.colorIdentity],
      supertypes: [...definition.supertypes],
      subtypes: [...definition.subtypes],
      power: definition.power === null ? null : `${definition.power}`,
      toughness: definition.toughness === null ? null : `${definition.toughness}`,
      oracleText: '',
    }),
  );
}

function testCard(
  name: string,
  manaCost: string,
  typeLine: string,
  more: Record<string, unknown> = {},
) {
  return oracle({
    name,
    manaCost,
    typeLine,
    cmc: Number(manaCost.replace(/[^0-9]/g, '')) || 0,
    oracleText: /\b(?:Instant|Sorcery)\b/.test(typeLine) ? 'Draw a card.' : '',
    ...more,
  });
}

function castBy(
  ctx: GameContext,
  playerId: string,
  cardName: string,
  answer: (decision: PendingDecision) => DecisionOutcome = pass,
) {
  const card = testCard(cardName, '{1}', 'Artifact');
  const object = conjure(ctx, playerId, card, 'hand');
  addMana(playerById(ctx, playerId), [{ symbol: 'C' }]);
  const option = computePriorityOptions(ctx, playerById(ctx, playerId)).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(option, 'ordinary cast action').toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  settle(ctx, answer);
}

function castCardFromHand(
  ctx: GameContext,
  playerId: string,
  card: OracleCard,
  mana: ('C' | Color)[],
  answer: (decision: PendingDecision) => DecisionOutcome = pass,
  castTargets: Map<number, string> = new Map(),
) {
  const object = conjure(ctx, playerId, card, 'hand');
  addMana(
    playerById(ctx, playerId),
    mana.map((symbol) => ({ symbol })),
  );
  const option = computePriorityOptions(ctx, playerById(ctx, playerId)).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(option, `${card.name} normal cast action`).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: castTargets,
    }),
  );
  settle(ctx, answer);
  return object;
}

function exerciseCubeWard(ctx: GameContext, cube: EnginePermanent, payWard: boolean) {
  let wardChoices = 0;
  const removal = castCardFromHand(
    ctx,
    'P2',
    testCard('Independent Cube ward removal', '{1}', 'Instant', {
      oracleText: 'Destroy target artifact.',
    }),
    ['C', 'C', 'C'],
    (decision) => {
      wardChoices++;
      const index = decision.options.findIndex(
        (option) => option.type === (payWard ? 'payCost' : 'decline'),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      return { index, targets: new Map() };
    },
    new Map([[0, cube.id]]),
  );
  expect(wardChoices).toBe(1);
  expect(ctx.state.battlefield.some((permanent) => permanent.id === cube.id)).toBe(!payWard);
  expect(playerById(ctx, 'P2').manaEntries).toHaveLength(payWard ? 0 : 2);
  expect(playerById(ctx, 'P2').graveyard.some((card) => card.cardId === removal.cardId)).toBe(true);
  expect(ctx.state.eventLog.some((event) => event.type === 'wardPaid')).toBe(payWard);
  expect(ctx.state.eventLog.some((event) => event.type === 'counterSpell')).toBe(!payWard);
}

function resolveCombat(
  ctx: GameContext,
  attackers: readonly { id: string }[],
  answer: (decision: PendingDecision) => DecisionOutcome = pass,
  blockers: readonly { id: string }[] = [],
) {
  const ids = new Set(attackers.map((attacker) => attacker.id));
  const blockerIds = new Set(blockers.map((blocker) => blocker.id));
  return pump(runCombatPhase(ctx), (decision) => {
    if (decision.decisionType === 'declareAttackers')
      return declareAttacks(decision, (id) => (ids.has(id) ? 'P2' : null));
    if (decision.decisionType === 'declareBlockers')
      return declareBlocks(decision, (id, _subject) =>
        blockerIds.has(id) ? (attackers[0]?.id ?? null) : null,
      );
    return decision.decisionType === 'priority' ? pass(decision) : answer(decision);
  });
}

function castComposition(
  ctx: GameContext,
  id: Pr09LibraryCompositionId,
  mana: ('C' | Color)[],
  answer: (decision: PendingDecision) => DecisionOutcome = pass,
  expectPermanent = true,
  castTargets: Map<number, string> = new Map(),
): EnginePermanent | undefined {
  const definition = byId(id);
  const card = oracle({
    oracleId: definition.oracleId,
    name: definition.name,
    typeLine: definition.typeLine,
    manaCost:
      {
        'cosmic-cube': '{5}',
        'aetherworks-marvel': '{4}',
        'herald-of-amity': '{3}{W}',
        'mystic-forge': '{4}',
        'end-step-discover-five': '{6}',
        'opponent-cast-reveal': '{4}{G}{G}',
        'dark-confidant': '{1}{B}',
        'keen-duelist': '{1}{B}',
        szarekh: '{1}{B}{B}{B}',
        'dream-pillager': '{5}{R}{R}',
        'franklin-richards': '{5}{R}',
        'monstrous-vortex': '{3}{G}',
        'path-of-discovery': '{3}{G}',
        'trumpeting-carnosaur': '{4}{R}{R}',
        'sunbirds-invocation': '{5}{R}',
        'minds-dilation': '{5}{U}{U}',
        'chaos-warp': '{2}{R}',
        'adaptive-omnitool': '{2}',
        'armored-skyhunter': '{3}{W}',
        'songbirds-blessing': '{3}{W}',
        'expressive-iteration': '{U}{R}',
        'genesis-ultimatum': '{G}{G}{U}{U}{U}{R}{R}',
        'etali-primal-conqueror': '{5}{R}{R}',
        'into-the-time-vortex': '{4}{R}',
        'rabble-rousing': '{4}{W}',
        'celebrate-mountain-king': '{3}{W}',
        'new-generations-technique': '{3}{G}',
        'tibalts-trickery': '{1}{R}',
        'grenzo-havoc-raiser': '{R}{R}',
        'power-pack': '{1}{R}{G}{W}{U}',
        'improvisation-capstone': '{5}{R}{R}',
      }[id] ?? null,
    colors: [...definition.colors],
    colorIdentity: [...definition.colorIdentity],
    supertypes: [...definition.supertypes],
    subtypes: [...definition.subtypes],
    power: definition.power === null ? null : `${definition.power}`,
    toughness: definition.toughness === null ? null : `${definition.toughness}`,
    oracleText: '',
  });
  registerCustomDef(ctx, structuredClone(definition));
  const object = conjure(ctx, 'P1', card, 'hand');
  addMana(
    playerById(ctx, 'P1'),
    mana.map((symbol) => ({ symbol })),
  );
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(option, `${id} ordinary cast`).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
      index: 0,
      targets: castTargets,
    }),
  );
  settle(ctx, answer);
  const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === object.cardId);
  if (permanent === undefined && expectPermanent)
    throw new Error(`${id} did not resolve to the battlefield`);
  return permanent;
}

function library(ctx: GameContext, cards: ReturnType<typeof testCard>[]) {
  const objects = cards.map((card) => conjure(ctx, 'P1', card, 'library'));
  playerById(ctx, 'P1').library = objects;
  return objects;
}

function libraryFor(ctx: GameContext, playerId: string, cards: ReturnType<typeof testCard>[]) {
  const objects = cards.map((card) => conjure(ctx, playerId, card, 'library'));
  playerById(ctx, playerId).library = objects;
  return objects;
}

function upkeep(
  ctx: GameContext,
  playerId: string,
  answer: (decision: PendingDecision) => DecisionOutcome = pass,
) {
  ctx.state.currentTurnPlayer = playerId;
  ctx.state.activePlayerIndex = ctx.state.turnOrder.indexOf(playerId);
  ctx.state.phase = 'beginning';
  ctx.state.step = 'upkeep';
  queueStepTriggers(ctx, 'upkeep');
  return settle(ctx, answer);
}

function independentCounterDefinition(): CardDefinition {
  return {
    oracleId: 'independent-pr09-counter-action',
    name: 'Independent counter action',
    typeLine: 'Instant',
    supertypes: [],
    types: ['Instant'],
    subtypes: [],
    colors: ['U'],
    colorIdentity: ['U'],
    manaCost: manaCost('{U}'),
    hasUnsupportedCost: false,
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    manaAbilities: [],
    activatedAbilities: [],
    entersTapped: false,
    spellAbility: spell({
      targets: [counterSpellTarget('spell')],
      effects: [{ op: 'counter', target: 0 }],
    }),
    triggers: [],
    staticEffects: [],
    ruleStatics: [],
    modeled: true,
    unmodeledReasons: [],
  };
}

function activate(ctx: GameContext, objectId: string) {
  const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === objectId;
  });
  return option;
}

describe('independent bounded PR09 library compositions', () => {
  for (const { id, definition } of BOUNDED_PR09_LIBRARY) {
    for (const capability of deriveCardCapabilities(definition)) {
      it(`${capability} / ${id}: positive`, () => {
        expect(matchesBoundedPr09Library(definition, id)).toBe(true);
        const capabilities = deriveCardCapabilities(definition);
        expect(capabilities.length).toBeGreaterThan(1);
        for (const capability of capabilities) {
          const extension = PR09_LIBRARY_CONTRACT_EXTENSIONS.find(
            (entry) => entry.capability === capability,
          );
          expect(extension?.supports(definition), `${id} supports ${capability}`).toBe(true);
          expect(extension?.cases.map((entry) => entry.id)).toContain(
            `pr09-library-${capabilitySlug(capability)}-${id}-positive`,
          );
          expect(extension?.cases.map((entry) => entry.id)).toContain(
            `pr09-library-${capabilitySlug(capability)}-${id}-negative`,
          );
        }
        const ctx = pod(`pr09-independent-${id}-positive`);
        if (id === 'end-step-discover-five' || id === 'opponent-cast-reveal') source(ctx, id);

        if (id === 'end-step-discover-five') {
          const hit = testCard('Independent discover hit', '{3}', 'Artifact');
          conjure(ctx, 'P1', hit, 'library');
          queueStepTriggers(ctx, 'endStep');
          expect(ctx.state.pendingTriggers).toHaveLength(1);
          settle(ctx, (decision) => {
            const option = decision.options.findIndex((entry) => entry.type === 'decline');
            return { index: Math.max(option, 0), targets: new Map() };
          });
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === hit.name)).toBe(true);

          const protectedSpell = testCard('Independent protected spell', '{1}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          const protectedObject = conjure(ctx, 'P1', protectedSpell, 'hand');
          addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }]);
          const protectedCast = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
            const payload = entry.payload as PriorityActionPayload;
            return payload.kind === 'castSpell' && payload.objectId === protectedObject.id;
          });
          expect(protectedCast).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P1'),
              protectedCast!.payload as PriorityActionPayload,
              { index: 0, targets: new Map() },
            ),
          );
          const protectedStackObject = ctx.state.stack.at(-1)!;
          const counterDefinition = independentCounterDefinition();
          registerCustomDef(ctx, counterDefinition);
          const counterCard = oracle({
            oracleId: counterDefinition.oracleId,
            name: counterDefinition.name,
            typeLine: 'Instant',
            manaCost: '{U}',
            colors: ['U'],
            colorIdentity: ['U'],
            oracleText: '',
          });
          const counterObject = conjure(ctx, 'P2', counterCard, 'hand');
          addMana(playerById(ctx, 'P2'), [{ symbol: 'U' }]);
          const counterCast = computePriorityOptions(ctx, playerById(ctx, 'P2')).find((entry) => {
            const payload = entry.payload as PriorityActionPayload;
            return payload.kind === 'castSpell' && payload.objectId === counterObject.id;
          });
          expect(counterCast).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P2'),
              counterCast!.payload as PriorityActionPayload,
              { index: 0, targets: new Map([[0, protectedStackObject.id]]) },
            ),
          );
          pump(resolveTopOfStack(ctx));
          expect(ctx.state.eventLog.some((event) => event.type === 'counterPrevented')).toBe(true);
          expect(ctx.state.stack.some((entry) => entry.id === protectedStackObject.id)).toBe(true);
        } else if (id === 'opponent-cast-reveal') {
          const creature = testCard('Independent revealed creature', '{2}', 'Creature — Beast');
          conjure(ctx, 'P1', creature, 'library');
          ctx.state.currentTurnPlayer = 'P2';
          ctx.state.activePlayerIndex = 1;
          castBy(ctx, 'P2', 'Independent opponent spell');
          expect(ctx.state.battlefield.some((permanent) => permanent.name === creature.name)).toBe(
            true,
          );
        } else if (id === 'dark-confidant') {
          castComposition(ctx, id, ['C', 'B']);
          const top = testCard('Independent Confidant reveal', '{3}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          library(ctx, [top]);
          const lifeBefore = playerById(ctx, 'P1').life;
          upkeep(ctx, 'P1');
          expect(playerById(ctx, 'P1').life).toBe(lifeBefore - 3);
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === top.name)).toBe(true);
          expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
          expect(ctx.state.eventLog.some((event) => event.type === 'draw')).toBe(false);
        } else if (id === 'keen-duelist') {
          castComposition(ctx, id, ['C', 'B']);
          const ownTop = testCard('Independent Duelist own top', '{3}', 'Artifact');
          const opponentTop = testCard('Independent Duelist opponent top', '{5}', 'Artifact');
          library(ctx, [ownTop]);
          libraryFor(ctx, 'P2', [opponentTop]);
          upkeep(ctx, 'P1', (decision) => {
            const index = decision.options.findIndex((option) =>
              option.targets?.some((target) => target.options.includes('P2')),
            );
            const targets = new Map<number, string>();
            for (const target of decision.options[index]?.targets ?? [])
              if (target.options.includes('P2')) targets.set(target.slot, 'P2');
            return { index: Math.max(index, 0), targets };
          });
          expect(playerById(ctx, 'P1').life).toBe(35);
          expect(playerById(ctx, 'P2').life).toBe(37);
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === ownTop.name)).toBe(true);
          expect(playerById(ctx, 'P2').hand.some((card) => card.name === opponentTop.name)).toBe(
            true,
          );
          expect(ctx.state.eventLog.filter((event) => event.type === 'revealCard')).toHaveLength(2);
        } else if (id === 'szarekh') {
          const szarekh = castComposition(ctx, id, ['C', 'B', 'B', 'B'])!;
          szarekh.summoningSick = false;
          const oldEligible = testCard('Independent old Vehicle', '{3}', 'Artifact — Vehicle');
          conjure(ctx, 'P1', oldEligible, 'graveyard');
          const nonmatch = testCard('Independent milled nonmatch', '{2}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          const eligible = testCard('Independent milled Vehicle', '{3}', 'Artifact — Vehicle');
          const milledOther = testCard('Independent milled artifact', '{1}', 'Artifact');
          library(ctx, [nonmatch, eligible, milledOther]);
          resolveCombat(ctx, [szarekh], (decision) => {
            const index = decision.options.findIndex((option) =>
              option.description.includes(eligible.name),
            );
            return { index: Math.max(index, 0), targets: new Map() };
          });
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === eligible.name)).toBe(true);
          expect(
            playerById(ctx, 'P1').graveyard.some((card) => card.name === oldEligible.name),
          ).toBe(true);
          expect(
            playerById(ctx, 'P1').graveyard.some((card) => card.name === milledOther.name),
          ).toBe(true);
        } else if (id === 'dream-pillager') {
          const dream = castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C', 'R', 'R'])!;
          dream.summoningSick = false;
          const firstSpell = testCard('Independent Pillager spell one', '{1}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          const laterSpell = testCard('Independent Pillager spell two', '{2}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          const land = testCard('Independent Pillager land', '', 'Land');
          library(ctx, [
            firstSpell,
            laterSpell,
            land,
            testCard('Pillager fourth card', '{1}', 'Artifact'),
          ]);
          resolveCombat(ctx, [dream]);
          expect(playerById(ctx, 'P1').library).toHaveLength(0);
          expect(ctx.state.exile.filter((card) => card.ownerId === 'P1')).toHaveLength(4);
          const spellObject = ctx.state.exile.find((card) => card.name === firstSpell.name)!;
          const landObject = ctx.state.exile.find((card) => card.name === land.name)!;
          addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }]);
          const freeAction = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
            const payload = entry.payload as PriorityActionPayload;
            return payload.kind === 'castSpell' && payload.objectId === spellObject.id;
          });
          expect(freeAction).toBeDefined();
          expect(
            computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
              (entry) => (entry.payload as { objectId?: string }).objectId === landObject.id,
            ),
          ).toBe(false);
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P1'),
              freeAction!.payload as PriorityActionPayload,
              {
                index: 0,
                targets: new Map(),
              },
            ),
          );
          settle(ctx);
          expect(playerById(ctx, 'P1').life).toBe(41);
          const remainingPermission = ctx.state.exile.find(
            (card) => card.name === laterSpell.name,
          )!;
          addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }]);
          pump(cleanupStep(ctx));
          expect(
            computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
              (entry) =>
                (entry.payload as { objectId?: string }).objectId === remainingPermission.id,
            ),
          ).toBe(false);
        } else if (id === 'franklin-richards') {
          castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C', 'R']);
          castCardFromHand(ctx, 'P1', testCard('Franklin setup artifact', '{1}', 'Artifact'), [
            'C',
          ]);
          const hit = testCard('Franklin Discover hit', '{4}', 'Artifact');
          library(ctx, [hit]);
          queueStepTriggers(ctx, 'beginningOfCombat');
          expect(ctx.state.pendingTriggers).toHaveLength(1);
          settle(ctx, (decision) => {
            const keep = decision.options.findIndex((option) => option.type === 'decline');
            return keep >= 0 ? { index: keep, targets: new Map() } : pass(decision);
          });
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === hit.name)).toBe(true);
        } else if (id === 'monstrous-vortex') {
          castComposition(ctx, id, ['C', 'C', 'C', 'G']);
          const hit = testCard('Vortex captured Discover hit', '{3}', 'Artifact');
          library(ctx, [hit]);
          const creature = testCard('Vortex power five spell', '{3}', 'Creature — Beast', {
            power: '5',
            toughness: '5',
          });
          castCardFromHand(ctx, 'P1', creature, ['C', 'C', 'C'], (decision) => {
            const keep = decision.options.findIndex((option) => option.type === 'decline');
            return keep >= 0 ? { index: keep, targets: new Map() } : pass(decision);
          });
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === hit.name)).toBe(true);
        } else if (id === 'path-of-discovery') {
          castComposition(ctx, id, ['C', 'C', 'C', 'G']);
          const land = testCard('Path explore land', '', 'Land');
          library(ctx, [land]);
          const creature = conjure(
            ctx,
            'P1',
            testCard('Path own entrant', '{2}', 'Creature — Scout'),
            'hand',
          );
          pump(moveObject(ctx, creature, { zone: 'battlefield' }));
          settle(ctx);
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === land.name)).toBe(true);
          expect(ctx.state.eventLog.some((event) => event.type === 'draw')).toBe(false);
          const nonland = testCard('Path explore nonland', '{1}', 'Artifact');
          library(ctx, [nonland]);
          const second = conjure(
            ctx,
            'P1',
            testCard('Path second entrant', '{2}', 'Creature — Scout'),
            'hand',
          );
          pump(moveObject(ctx, second, { zone: 'battlefield' }));
          settle(ctx, (decision) => {
            const graveyard = decision.options.findIndex((option) =>
              /graveyard/i.test(option.description),
            );
            return graveyard >= 0 ? { index: graveyard, targets: new Map() } : pass(decision);
          });
          expect(
            ctx.state.battlefield.find((permanent) => permanent.name === 'Path second entrant')
              ?.counters['+1/+1'],
          ).toBe(1);
          expect(playerById(ctx, 'P1').graveyard.some((card) => card.name === nonland.name)).toBe(
            true,
          );
        } else if (id === 'trumpeting-carnosaur') {
          const etbHit = testCard('Carnosaur ETB Discover hit', '{3}', 'Artifact');
          library(ctx, [etbHit]);
          castComposition(ctx, id, ['C', 'C', 'C', 'C', 'R', 'R'], (decision) => {
            const keep = decision.options.findIndex((option) => option.type === 'decline');
            return keep >= 0 ? { index: keep, targets: new Map() } : pass(decision);
          });
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === etbHit.name)).toBe(true);
          const definition = byId(id);
          registerCustomDef(ctx, structuredClone(definition));
          const handCard = conjure(
            ctx,
            'P1',
            oracle({
              oracleId: definition.oracleId,
              name: definition.name,
              typeLine: definition.typeLine,
              manaCost: '{4}{R}{R}',
              colors: [...definition.colors],
              colorIdentity: [...definition.colorIdentity],
              subtypes: [...definition.subtypes],
              power: '7',
              toughness: '6',
              oracleText: '',
            }),
            'hand',
          );
          const target = spawn(
            ctx,
            'P2',
            testCard('Carnosaur damage target', '{2}', 'Creature — Test', {
              power: '5',
              toughness: '5',
            }),
          );
          addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'R' }]);
          const ability = activate(ctx, handCard.id);
          expect(ability).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P1'),
              ability!.payload as PriorityActionPayload,
              { index: 0, targets: new Map([[0, target.id]]) },
            ),
          );
          settle(ctx);
          expect(
            playerById(ctx, 'P1').graveyard.some((card) => card.cardId === handCard.cardId),
          ).toBe(true);
          expect(target.damageMarked).toBe(3);
        } else if (id === 'sunbirds-invocation') {
          castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C', 'R']);
          const chosen = testCard('Sunbird eligible free spell', '{1}', 'Artifact');
          const tooLarge = testCard('Sunbird captured value limit', '{3}', 'Artifact');
          const remaining = testCard('Sunbird revealed remainder', '{1}', 'Land');
          library(ctx, [chosen, tooLarge, remaining]);
          const triggerSpell = testCard('Sunbird original spell', '{2}', 'Artifact');
          let revealedCount = 0;
          castCardFromHand(ctx, 'P1', triggerSpell, ['C', 'C'], (decision) => {
            if (decision.options.some((option) => option.type === 'castFree')) {
              revealedCount = ctx.state.eventLog.filter(
                (event) => event.type === 'revealCard',
              ).length;
              expect(
                decision.options.some((option) => option.description.includes(tooLarge.name)),
              ).toBe(false);
              return {
                index: decision.options.findIndex(
                  (option) =>
                    option.type === 'castFree' && option.description.includes(chosen.name),
                ),
                targets: new Map(),
              };
            }
            return pass(decision);
          });
          expect(revealedCount).toBe(2);
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === chosen.name,
            ),
          ).toBe(true);
          expect(playerById(ctx, 'P1').library.some((card) => card.name === remaining.name)).toBe(
            true,
          );
        } else if (id === 'minds-dilation') {
          castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C', 'U', 'U']);
          const stolen = testCard('Dilation event-player top', '{2}', 'Artifact');
          libraryFor(ctx, 'P2', [stolen]);
          ctx.state.currentTurnPlayer = 'P2';
          ctx.state.activePlayerIndex = 1;
          castBy(ctx, 'P2', 'Dilation triggering opponent spell', (decision) => {
            const cast = decision.options.findIndex(
              (option) => option.type === 'castFree' && option.description.includes(stolen.name),
            );
            return cast >= 0 ? { index: cast, targets: new Map() } : pass(decision);
          });
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === stolen.name,
            ),
          ).toBe(true);
          expect(playerById(ctx, 'P2').library).toHaveLength(0);
        } else if (id === 'chaos-warp') {
          const target = spawn(ctx, 'P2', testCard('Warp permanent target', '{2}', 'Artifact'));
          const spell = castComposition(
            ctx,
            id,
            ['C', 'C', 'R'],
            pass,
            false,
            new Map([[0, target.id]]),
          );
          expect(spell).toBeUndefined();
          const reveal = ctx.state.eventLog.find(
            (event) => event.type === 'revealCard' && event.payload['player'] === 'P2',
          );
          expect(reveal?.payload['revealed']).toBe(true);
          expect(
            ctx.state.eventLog.some(
              (event) =>
                event.type === 'zoneChange' &&
                event.payload['cardId'] === target.cardId &&
                event.payload['from'] === 'battlefield' &&
                event.payload['to'] === 'library',
            ),
          ).toBe(true);
          expect(
            ctx.state.battlefield.some(
              (permanent) => permanent.cardId === reveal?.payload['cardId'],
            ),
          ).toBe(true);
        } else if (id === 'adaptive-omnitool') {
          const tool = castComposition(ctx, id, ['C', 'C'])!;
          const host = spawn(
            ctx,
            'P1',
            testCard('Omnitool equipped attacker', '{1}', 'Creature — Test'),
          );
          spawn(ctx, 'P1', testCard('Omnitool another artifact', '{1}', 'Artifact'));
          spawn(ctx, 'P2', testCard('Omnitool opposing artifact', '{1}', 'Artifact'));
          addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
          const equip = activate(ctx, tool.id);
          expect(equip).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P1'),
              equip!.payload as PriorityActionPayload,
              {
                index: 0,
                targets: new Map([[0, host.id]]),
              },
            ),
          );
          settle(ctx);
          expect(tool.attachedTo).toBe(host.id);
          expect(computeCharacteristics(ctx, host)).toMatchObject({ power: 4, toughness: 4 });
          const hit = testCard('Omnitool revealed artifact', '{1}', 'Artifact');
          library(ctx, [
            hit,
            ...Array.from({ length: 5 }, (_, index) =>
              testCard(`Omnitool tail ${index}`, '', 'Land'),
            ),
          ]);
          resolveCombat(ctx, [host], (decision) => {
            const choice = decision.options.findIndex((option) =>
              option.description.includes(hit.name),
            );
            return choice >= 0 ? { index: choice, targets: new Map() } : pass(decision);
          });
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === hit.name)).toBe(true);
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'revealCard' && event.payload['name'] === hit.name,
            ),
          ).toBe(true);
        } else if (id === 'armored-skyhunter') {
          const hunter = castComposition(ctx, id, ['C', 'C', 'C', 'W'])!;
          const host = spawn(
            ctx,
            'P1',
            testCard('Skyhunter attach host', '{1}', 'Creature — Test'),
          );
          const equipment = testCard(
            'Skyhunter deployable equipment',
            '{1}',
            'Artifact — Equipment',
          );
          const aura = testCard('Skyhunter eligible aura', '{W}', 'Enchantment — Aura', {
            oracleText: 'Enchant creature',
          });
          library(ctx, [
            equipment,
            aura,
            testCard('Skyhunter bare artifact', '{1}', 'Artifact'),
            ...Array.from({ length: 3 }, (_, index) =>
              testCard(`Skyhunter tail ${index}`, '', 'Land'),
            ),
          ]);
          hunter.summoningSick = false;
          resolveCombat(ctx, [hunter], (decision) => {
            const hostChoice = decision.options.findIndex((option) =>
              option.description.includes(host.name),
            );
            if (hostChoice >= 0) return { index: hostChoice, targets: new Map() };
            const equipmentChoice = decision.options.findIndex((option) =>
              option.description.includes(equipment.name),
            );
            return equipmentChoice >= 0
              ? { index: equipmentChoice, targets: new Map() }
              : pass(decision);
          });
          const deployed = ctx.state.battlefield.find(
            (permanent) => permanent.name === equipment.name,
          );
          expect(deployed?.attachedTo).toBe(host.id);
          expect(ctx.state.battlefield.some((permanent) => permanent.name === aura.name)).toBe(
            false,
          );
          expect(ctx.state.eventLog.some((event) => event.type === 'equip')).toBe(false);
        } else if (id === 'songbirds-blessing') {
          const host = spawn(
            ctx,
            'P1',
            testCard('Songbirds enchanted host', '{2}', 'Creature — Bird'),
          );
          castComposition(ctx, id, ['C', 'C', 'C', 'W'], pass, true, new Map([[0, host.id]]));
          const aura = testCard('Songbirds revealed aura', '{1}{W}', 'Enchantment — Aura', {
            oracleText: 'Enchant creature',
          });
          library(ctx, [testCard('Songbirds reveal miss', '{1}', 'Sorcery'), aura]);
          resolveCombat(ctx, [host], (decision) => {
            const battlefield = decision.options.findIndex(
              (option) => option.type === 'putAuraOntoBattlefield',
            );
            if (battlefield >= 0) return { index: battlefield, targets: new Map() };
            const attach = decision.options.findIndex((option) =>
              option.description.includes(host.name),
            );
            return attach >= 0 ? { index: attach, targets: new Map() } : pass(decision);
          });
          expect(
            ctx.state.battlefield.some(
              (permanent) => permanent.name === aura.name && permanent.attachedTo === host.id,
            ),
          ).toBe(true);
          expect(ctx.state.eventLog.filter((event) => event.type === 'revealCard')).toHaveLength(2);
        } else if (id === 'expressive-iteration') {
          const handCard = testCard('Iteration chosen hand', '{1}', 'Artifact');
          const bottomCard = testCard('Iteration chosen bottom', '{2}', 'Sorcery');
          const land = testCard('Iteration exiled land', '', 'Land');
          const objects = library(ctx, [handCard, bottomCard, land]);
          castComposition(
            ctx,
            id,
            ['U', 'R'],
            (decision) => {
              if (decision.prompt.includes('choose a card to put into your hand'))
                return {
                  index: decision.options.findIndex((option) =>
                    option.description.includes(handCard.name),
                  ),
                  targets: new Map(),
                };
              if (decision.prompt.includes('choose a card to put on the bottom'))
                return {
                  index: decision.options.findIndex((option) =>
                    option.description.includes(bottomCard.name),
                  ),
                  targets: new Map(),
                };
              return pass(decision);
            },
            false,
          );
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === handCard.name)).toBe(true);
          expect(playerById(ctx, 'P1').library.map((card) => card.name)).toEqual([bottomCard.name]);
          const exiled = ctx.state.exile.find((card) => card.name === land.name)!;
          expect(
            computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
              (option) =>
                option.type === 'playLand' &&
                (option.payload as { objectId?: string }).objectId === exiled.id,
            ),
          ).toBe(true);
          expect(objects).toHaveLength(3);
        } else if (id === 'genesis-ultimatum') {
          const creature = testCard('Genesis batch creature A', '{2}', 'Creature — Beast', {
            oracleText: 'When this creature enters, you gain 1 life.',
          });
          const creatureB = testCard('Genesis batch creature B', '{2}', 'Creature — Beast', {
            oracleText: 'When this creature enters, you gain 1 life.',
          });
          const artifact = testCard('Genesis batch artifact', '{2}', 'Artifact');
          const spell = testCard('Genesis remainder spell', '{1}', 'Sorcery');
          const aura = testCard('Genesis remainder aura', '{1}{W}', 'Enchantment — Aura', {
            oracleText: 'Enchant creature',
          });
          const objects = library(ctx, [creature, creatureB, artifact, spell, aura]);
          const sourceCard = castComposition(
            ctx,
            id,
            ['G', 'G', 'U', 'U', 'U', 'R', 'R'],
            (decision) => {
              const next = decision.options.findIndex(
                (option) =>
                  option.description.includes(creature.name) ||
                  option.description.includes(creatureB.name),
              );
              if (next >= 0) return { index: next, targets: new Map() };
              const finish = decision.options.findIndex((option) =>
                /finish choosing/i.test(option.description),
              );
              return finish >= 0 ? { index: finish, targets: new Map() } : pass(decision);
            },
            false,
          );
          expect(sourceCard).toBeUndefined();
          expect(ctx.state.battlefield.map((permanent) => permanent.name)).toEqual(
            expect.arrayContaining([creature.name, creatureB.name]),
          );
          expect(playerById(ctx, 'P1').life).toBe(42);
          expect(playerById(ctx, 'P1').hand.map((card) => card.name)).toEqual(
            expect.arrayContaining([artifact.name, spell.name, aura.name]),
          );
          expect(ctx.state.exile.some((card) => card.name === byId(id).name)).toBe(true);
          expect(objects).toHaveLength(5);
        } else if (id === 'cosmic-cube') {
          const cube = castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C'])!;
          expect(wardCostOf(ctx, cube)).toMatchObject({ kind: 'mana', cost: { generic: 2 } });
          const attackerCard = testCard('Independent Cube attacker', '{1}', 'Creature — Test', {
            power: '3',
            toughness: '3',
          });
          const attacker = spawn(ctx, 'P1', attackerCard);
          attacker.summoningSick = false;
          const hit = testCard('Independent Cube hit', '{3}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          library(ctx, [
            hit,
            ...Array.from({ length: 5 }, (_, index) => testCard(`Cube card ${index}`, '', 'Land')),
          ]);
          resolveCombat(ctx, [attacker], (decision) => {
            const index = decision.options.findIndex(
              (option) => option.type === 'castFree' && option.description.includes(hit.name),
            );
            return { index: Math.max(index, 0), targets: new Map() };
          });
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === hit.name,
            ),
          ).toBe(true);
          expect(playerById(ctx, 'P1').library).toHaveLength(5);
          exerciseCubeWard(ctx, cube, true);
        } else if (id === 'aetherworks-marvel') {
          const marvel = castComposition(ctx, id, ['C', 'C', 'C', 'C'])!;
          const energyBeforeDeath = playerById(ctx, 'P1').energy;
          const ownPermanent = spawn(
            ctx,
            'P1',
            testCard('Independent energy source', '{1}', 'Artifact'),
          );
          pump(moveObject(ctx, ownPermanent, { zone: 'graveyard' }));
          settle(ctx);
          expect(playerById(ctx, 'P1').energy).toBe(energyBeforeDeath + 1);
          playerById(ctx, 'P1').energy += 5;
          const hit = testCard('Independent Marvel hit', '{3}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          library(ctx, [
            hit,
            ...Array.from({ length: 5 }, (_, index) =>
              testCard(`Marvel card ${index}`, '{1}', 'Sorcery'),
            ),
          ]);
          const option = activate(ctx, marvel.id);
          expect(option).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P1'),
              option!.payload as PriorityActionPayload,
              {
                index: 0,
                targets: new Map(),
              },
            ),
          );
          pump(resolveTopOfStack(ctx), (decision) => {
            const index = decision.options.findIndex(
              (entry) => entry.type === 'castFree' && entry.description.includes(hit.name),
            );
            return { index: Math.max(index, 0), targets: new Map() };
          });
          pump(resolveTopOfStack(ctx));
          expect(playerById(ctx, 'P1').energy).toBe(0);
          expect(marvel.tapped).toBe(true);
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === hit.name,
            ),
          ).toBe(true);
          expect(playerById(ctx, 'P1').library).toHaveLength(5);
        } else if (id === 'herald-of-amity') {
          const host = spawn(
            ctx,
            'P1',
            testCard('Independent Aura host', '{2}', 'Creature — Test'),
          );
          const aura = testCard('Independent Herald Aura', '{1}', 'Enchantment — Aura', {
            oracleText: 'Enchant creature',
          });
          library(ctx, [
            aura,
            ...Array.from({ length: 7 }, (_, index) =>
              testCard(`Herald card ${index}`, '{1}', 'Sorcery'),
            ),
          ]);
          const herald = castComposition(ctx, id, ['C', 'C', 'C', 'W'], (decision) => {
            const free = decision.options.findIndex(
              (option) => option.type === 'castFree' && option.description.includes(aura.name),
            );
            if (free >= 0) {
              const targets = new Map<number, string>();
              for (const target of decision.options[free]?.targets ?? [])
                if (target.options.includes(host.id)) targets.set(target.slot, host.id);
              return { index: free, targets };
            }
            if (decision.decisionType === 'chooseTargets')
              return { index: 0, targets: new Map([[0, host.id]]) };
            return pass(decision);
          })!;
          expect(
            ctx.state.battlefield.some(
              (permanent) => permanent.name === aura.name && permanent.attachedTo === host.id,
            ),
          ).toBe(true);
          expect(playerById(ctx, 'P1').library).toHaveLength(7);
          expect(ctx.state.exile.some((card) => card.name === aura.name)).toBe(false);
          herald.summoningSick = false;
          const before = computeCharacteristics(ctx, herald);
          resolveCombat(ctx, [herald]);
          expect(computeCharacteristics(ctx, herald)).toMatchObject({
            power: before.power + 1,
            toughness: before.toughness + 1,
          });
        } else if (id === 'etali-primal-conqueror') {
          const hits = new Map<string, ReturnType<typeof testCard>>();
          for (const playerId of ['P1', 'P2', 'P3', 'P4']) {
            const hit = testCard(`Etali ${playerId} hit`, '{1}', 'Artifact');
            hits.set(playerId, hit);
            libraryFor(ctx, playerId, [testCard(`Etali ${playerId} land`, '', 'Land'), hit]);
          }
          let allPlayersExiledBeforeCastingChoice = false;
          const etali = castComposition(
            ctx,
            id,
            ['C', 'C', 'C', 'C', 'C', 'R', 'R'],
            (decision) => {
              const stop = decision.options.findIndex((option) =>
                /stop casting/i.test(option.description),
              );
              if (stop >= 0)
                allPlayersExiledBeforeCastingChoice = [...hits.values()].every((hit) =>
                  ctx.state.exile.some((card) => card.name === hit.name),
                );
              return stop >= 0 ? { index: stop, targets: new Map() } : pass(decision);
            },
          )!;
          expect(allPlayersExiledBeforeCastingChoice).toBe(true);
          for (const [playerId, hit] of hits)
            expect(
              ctx.state.exile.some((card) => card.name === hit.name),
              `${playerId} hit exiled before cast choice`,
            ).toBe(true);
          addMana(
            playerById(ctx, 'P1'),
            (['C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'C', 'G'] as const).map((symbol) => ({
              symbol,
            })),
          );
          const transform = activate(ctx, etali.id);
          expect(transform).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P1'),
              transform!.payload as PriorityActionPayload,
              { index: 0, targets: new Map() },
            ),
          );
          pump(resolveTopOfStack(ctx));
          const back = computeCharacteristics(ctx, etali);
          expect(etali.transformed).toBe(true);
          expect(back).toMatchObject({ power: 11, toughness: 11 });
          expect(back.keywords).toEqual(expect.arrayContaining(['trample', 'indestructible']));
          etali.summoningSick = false;
          resolveCombat(ctx, [etali]);
          expect(playerById(ctx, 'P2').life).toBe(29);
          expect(playerById(ctx, 'P2').poisonCounters).toBe(11);
        } else if (id === 'into-the-time-vortex') {
          const hit = testCard('Independent Vortex cascade hit', '{2}', 'Artifact');
          library(ctx, [
            hit,
            testCard('Vortex tail A', '', 'Land'),
            testCard('Vortex tail B', '', 'Land'),
          ]);
          let cascadeCount = 0;
          castComposition(
            ctx,
            id,
            ['C', 'C', 'C', 'C', 'R'],
            (decision) => {
              if (/Rebound: cast this card/i.test(decision.prompt)) return pass(decision);
              const decline = decision.options.findIndex((option) => option.type === 'decline');
              if (decision.options.some((option) => option.description.includes(hit.name))) {
                cascadeCount++;
                return { index: Math.max(decline, 0), targets: new Map() };
              }
              return pass(decision);
            },
            false,
          );
          expect(cascadeCount).toBe(1);
          expect(ctx.state.exile.some((card) => card.name === byId(id).name)).toBe(true);
          upkeep(ctx, 'P1', (decision) => {
            const cast = decision.options.findIndex((option) => option.type === 'castFree');
            return cast >= 0 ? { index: cast, targets: new Map() } : pass(decision);
          });
          expect(cascadeCount).toBe(1);
          expect(playerById(ctx, 'P1').graveyard.some((card) => card.name === byId(id).name)).toBe(
            true,
          );
        } else if (id === 'rabble-rousing') {
          const hidden = testCard('Independent linked land', '', 'Land');
          library(ctx, [
            hidden,
            ...Array.from({ length: 4 }, (_, index) =>
              testCard(`Rabble filler ${index}`, '', 'Land'),
            ),
          ]);
          const rabble = castComposition(ctx, id, ['C', 'C', 'C', 'C', 'W'], (decision) => {
            const choice = decision.options.findIndex(
              (option) =>
                option.type === 'hideawayExile' && option.description.includes(hidden.name),
            );
            return choice >= 0 ? { index: choice, targets: new Map() } : pass(decision);
          })!;
          const attackers = [
            spawn(ctx, 'P1', testCard('Rabble attacker A', '{1}', 'Creature — Test')),
            spawn(ctx, 'P1', testCard('Rabble attacker B', '{1}', 'Creature — Test')),
          ];
          const support = Array.from({ length: 7 }, (_, index) =>
            spawn(ctx, 'P1', testCard(`Rabble support ${index}`, '{1}', 'Creature — Test')),
          );
          for (const creature of [...attackers, ...support]) creature.summoningSick = false;
          resolveCombat(ctx, attackers, (decision) => {
            const play = decision.options.findIndex(
              (option) => option.type === 'playLand' && option.description.includes(hidden.name),
            );
            return play >= 0 ? { index: play, targets: new Map() } : pass(decision);
          });
          expect(
            ctx.state.battlefield.filter(
              (permanent) =>
                permanent.isToken &&
                computeCharacteristics(ctx, permanent).subtypes.includes('Citizen'),
            ),
          ).toHaveLength(2);
          expect(ctx.state.battlefield.some((permanent) => permanent.name === hidden.name)).toBe(
            true,
          );
          expect(rabble.zone).toBe('battlefield');
        } else if (id === 'celebrate-mountain-king') {
          const targets = ['P2', 'P3', 'P4'].map((playerId, index) =>
            spawn(ctx, playerId, testCard(`Celebrate target ${index}`, '{1}', 'Artifact')),
          );
          const discard = testCard('Celebrate nonland discard', '{1}', 'Artifact');
          library(ctx, [discard]);
          const offered = new Set<string>();
          const sourcePermanent = castComposition(ctx, id, ['C', 'C', 'C', 'W'], (decision) => {
            const targetChoice = decision.options.findIndex((option) =>
              targets.some(
                (target) => option.description.includes(target.name) && !offered.has(target.name),
              ),
            );
            if (targetChoice >= 0) {
              const name = targets.find((target) =>
                decision.options[targetChoice]!.description.includes(target.name),
              )!.name;
              offered.add(name);
              return { index: targetChoice, targets: new Map() };
            }
            const discardChoice = decision.options.findIndex((option) =>
              option.description.includes(discard.name),
            );
            return discardChoice >= 0
              ? { index: discardChoice, targets: new Map() }
              : pass(decision);
          })!;
          expect(offered.size).toBe(3);
          expect(playerById(ctx, 'P1').graveyard.some((card) => card.name === discard.name)).toBe(
            true,
          );
          expect(
            ctx.state.battlefield.some(
              (permanent) =>
                permanent.isToken &&
                computeCharacteristics(ctx, permanent).subtypes.includes('Soldier'),
            ),
          ).toBe(true);
          pump(moveObject(ctx, sourcePermanent, { zone: 'graveyard' }));
          settle(ctx);
          expect(
            targets.every((target) =>
              ctx.state.battlefield.some((permanent) => permanent.cardId === target.cardId),
            ),
          ).toBe(true);
        } else if (id === 'new-generations-technique') {
          const attacker = spawn(
            ctx,
            'P1',
            testCard('Sneak unblocked attacker', '{2}', 'Creature — Bear'),
          );
          attacker.attacking = 'P2';
          attacker.blockedByOrdered = [];
          attacker.summoningSick = false;
          ctx.state.phase = 'combat';
          ctx.state.step = 'declareBlockers';
          registerCustomDef(ctx, structuredClone(byId(id)));
          const technique = conjure(
            ctx,
            'P1',
            oracle({
              oracleId: byId(id).oracleId,
              name: byId(id).name,
              typeLine: byId(id).typeLine,
              manaCost: '{3}{G}',
              colors: ['G'],
              colorIdentity: ['G'],
            }),
            'hand',
          );
          library(ctx, [
            testCard('Sneak basic A', '', 'Basic Land — Forest'),
            testCard('Sneak basic B', '', 'Basic Land — Island'),
            testCard('Sneak nonbasic', '', 'Land — Forest'),
          ]);
          addMana(
            playerById(ctx, 'P1'),
            (['C', 'C', 'G'] as const).map((symbol) => ({ symbol })),
          );
          const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
            const payload = entry.payload as PriorityActionPayload & { alternativeCast?: string };
            return (
              payload.kind === 'castSpell' &&
              payload.objectId === technique.id &&
              payload.alternativeCast === 'nonMana'
            );
          });
          expect(option).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P1'),
              option!.payload as PriorityActionPayload,
              { index: 0, targets: new Map() },
            ),
          );
          expect(playerById(ctx, 'P1').hand.some((card) => card.cardId === attacker.cardId)).toBe(
            true,
          );
          pump(resolveTopOfStack(ctx));
          expect(
            ctx.state.battlefield
              .filter((permanent) => permanent.name.startsWith('Sneak basic'))
              .map((permanent) => permanent.tapped),
          ).toEqual([true, true]);
        } else if (id === 'tibalts-trickery') {
          const targetCard = testCard('Trickery independent target', '{1}', 'Instant');
          const target = conjure(ctx, 'P2', targetCard, 'hand');
          addMana(playerById(ctx, 'P2'), [{ symbol: 'C' }]);
          const castTarget = computePriorityOptions(ctx, playerById(ctx, 'P2')).find(
            (entry) =>
              (entry.payload as PriorityActionPayload & { objectId?: string }).kind ===
                'castSpell' &&
              (entry.payload as PriorityActionPayload & { objectId?: string }).objectId ===
                target.id,
          );
          expect(castTarget).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P2'),
              castTarget!.payload as PriorityActionPayload,
              { index: 0, targets: new Map() },
            ),
          );
          const hit = testCard('Trickery different-name hit', '{1}', 'Artifact');
          libraryFor(ctx, 'P2', [forest(), forest(), forest(), hit]);
          castComposition(
            ctx,
            id,
            ['R', 'C'],
            (decision) => {
              const free = decision.options.findIndex(
                (option) => option.type === 'castFree' && option.description.includes(hit.name),
              );
              return free >= 0 ? { index: free, targets: new Map() } : pass(decision);
            },
            false,
            new Map([
              [0, ctx.state.stack.find((entry) => entry.card?.cardId === target.cardId)!.id],
            ]),
          );
          expect(ctx.state.stack.some((entry) => entry.id === target.id)).toBe(false);
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === hit.name,
            ),
          ).toBe(true);
        } else if (id === 'grenzo-havoc-raiser') {
          const grenzo = castComposition(ctx, id, ['R', 'R'])!;
          grenzo.summoningSick = false;
          const top = testCard('Grenzo independent paid spell', '{G}', 'Artifact');
          libraryFor(ctx, 'P2', [top]);
          resolveCombat(ctx, [grenzo], (decision) => {
            const mode = decision.options.findIndex((option) =>
              /Exile their top card/i.test(option.description),
            );
            return mode >= 0 ? { index: mode, targets: new Map() } : pass(decision);
          });
          const exiled = ctx.state.exile.find((card) => card.name === top.name);
          expect(exiled).toBeDefined();
          addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }]);
          const permitted = computePriorityOptions(ctx, playerById(ctx, 'P1')).find(
            (entry) =>
              (entry.payload as PriorityActionPayload & { objectId?: string }).kind ===
                'castSpell' &&
              (entry.payload as PriorityActionPayload & { objectId?: string }).objectId ===
                exiled!.id,
          );
          expect(permitted).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P1'),
              permitted!.payload as PriorityActionPayload,
              { index: 0, targets: new Map() },
            ),
          );
          settle(ctx);
          expect(ctx.state.battlefield.some((permanent) => permanent.name === top.name)).toBe(true);

          const goadCtx = pod(`pr09-independent-${id}-goad`);
          const goadGrenzo = castComposition(goadCtx, id, ['R', 'R'])!;
          goadGrenzo.summoningSick = false;
          const p2Creature = spawn(
            goadCtx,
            'P2',
            testCard('Grenzo independent goad target', '{2}', 'Creature — Test'),
          );
          spawn(
            goadCtx,
            'P3',
            testCard('Grenzo independent other creature', '{2}', 'Creature — Test'),
          );
          resolveCombat(goadCtx, [goadGrenzo], (decision) => {
            const mode = decision.options.findIndex((option) => /Goad/i.test(option.description));
            if (mode < 0) return pass(decision);
            const targetChoice = decision.options[mode]!;
            const targetSlot = targetChoice.targets?.find((target) =>
              target.options.includes(p2Creature.id),
            );
            return {
              index: mode,
              targets: new Map(targetSlot === undefined ? [] : [[targetSlot.slot, p2Creature.id]]),
            };
          });
          expect(p2Creature.goadedBy?.some((entry) => entry.goaderId === 'P1')).toBe(true);
          goadCtx.state.currentTurnPlayer = 'P2';
          goadCtx.state.activePlayerIndex = 1;
          goadCtx.state.turnNumber += 1;
          goadCtx.state.phase = 'combat';
          let legalDefenders: string[] = [];
          pump(runCombatPhase(goadCtx), (decision) => {
            if (decision.decisionType === 'declareAttackers' && decision.player === 'P2') {
              const subject = decision.presentationAttackDeclaration?.subjects.find(
                (entry) => entry.name === p2Creature.name,
              );
              expect(subject?.mustAttack).toBe(true);
              legalDefenders = subject?.defenders.map((defender) => defender.playerId) ?? [];
              return declareAttacks(decision, (_id, entry) =>
                entry.name === p2Creature.name ? 'P3' : null,
              );
            }
            return pass(decision);
          });
          expect(legalDefenders).toContain('P3');
          expect(legalDefenders).not.toContain('P1');
        } else if (id === 'power-pack') {
          const pack = castComposition(ctx, id, ['C', 'R', 'G', 'W', 'U'])!;
          const instant = testCard('Power Pack delayed instant', '{1}', 'Instant');
          const grave = conjure(ctx, 'P1', instant, 'graveyard');
          resolveCombat(ctx, [pack], (decision) => {
            const target = decision.options.findIndex((option) =>
              option.description.includes(instant.name),
            );
            return target >= 0
              ? { index: target, targets: new Map([[0, grave.id]]) }
              : pass(decision);
          });
          expect(ctx.state.exile.some((card) => card.cardId === grave.cardId)).toBe(true);
          upkeep(ctx, 'P1', (decision) => {
            const cast = decision.options.findIndex((option) => option.type === 'castFree');
            return cast >= 0 ? { index: cast, targets: new Map() } : pass(decision);
          });
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === instant.name,
            ),
          ).toBe(true);
          expect(playerById(ctx, 'P1').graveyard.some((card) => card.cardId === grave.cardId)).toBe(
            false,
          );
          expect(ctx.state.exile.some((card) => card.cardId === grave.cardId)).toBe(true);
          expect(computeCharacteristics(ctx, pack).keywords).toEqual(
            expect.arrayContaining(['haste', 'flying', 'vigilance', 'trample']),
          );
        } else if (id === 'improvisation-capstone') {
          const hit = testCard('Capstone independent qualifying hit', '{4}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          library(ctx, [hit]);
          castComposition(
            ctx,
            id,
            ['C', 'C', 'C', 'C', 'C', 'R', 'R'],
            (decision) => {
              const free = decision.options.findIndex(
                (option) => option.type === 'castFree' && option.description.includes(hit.name),
              );
              return free >= 0 ? { index: free, targets: new Map() } : pass(decision);
            },
            false,
          );
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === hit.name,
            ),
          ).toBe(true);
          expect(ctx.state.exile.some((card) => card.name === byId(id).name)).toBe(true);
          const nextHit = testCard('Capstone independent copied hit', '{4}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          library(ctx, [nextHit]);
          const delayedCount = ctx.state.delayedTriggers.length;
          ctx.state.currentTurnPlayer = 'P1';
          ctx.state.activePlayerIndex = 0;
          ctx.state.phase = 'precombatMain';
          queueStepTriggers(ctx, 'precombatMain');
          expect(ctx.state.pendingTriggers).toHaveLength(1);
          settle(ctx, (decision) => {
            const free = decision.options.findIndex((option) => option.type === 'castFree');
            return free >= 0 ? { index: free, targets: new Map() } : pass(decision);
          });
          expect(ctx.state.eventLog.some((event) => event.type === 'cardCopied')).toBe(true);
          expect(ctx.state.exile.some((card) => card.isCardCopy === true)).toBe(false);
          expect(ctx.state.delayedTriggers).toHaveLength(delayedCount);
          expect(
            playerById(ctx, 'P1').resolvedSpellNames?.filter((name) => name === byId(id).name),
          ).toHaveLength(2);
          expect(playerById(ctx, 'P1').life).toBe(42);
        } else {
          const forge = castComposition(ctx, id, ['C', 'C', 'C', 'C'])!;
          expect(forge.name).toBe(byId(id).name);
          const artifact = testCard('Independent Forge artifact', '{1}', 'Artifact');
          const colored = testCard('Independent colored nonartifact', '{R}', 'Sorcery', {
            colors: ['R'],
            colorIdentity: ['R'],
          });
          const top = library(ctx, [artifact, colored]);
          expect(JSON.stringify(buildPlayerView(ctx, 'P1'))).toContain(artifact.name);
          expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain(artifact.name);
          addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }]);
          const castOption = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
            const payload = entry.payload as PriorityActionPayload;
            return payload.kind === 'castSpell' && payload.objectId === top[0]!.id;
          });
          expect(castOption).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P1'),
              castOption!.payload as PriorityActionPayload,
              { index: 0, targets: new Map() },
            ),
          );
          settle(ctx);
          expect(ctx.state.battlefield.some((permanent) => permanent.name === artifact.name)).toBe(
            true,
          );
          const activation = activate(ctx, forge.id);
          expect(activation).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P1'),
              activation!.payload as PriorityActionPayload,
              { index: 0, targets: new Map() },
            ),
          );
          pump(resolveTopOfStack(ctx));
          expect(playerById(ctx, 'P1').life).toBe(39);
          expect(ctx.state.exile.some((card) => card.name === colored.name)).toBe(true);
        }
      });

      it(`${capability} / ${id}: negative`, () => {
        expect(matchesBoundedPr09Library(definition, id)).toBe(true);
        const ctx = pod(`pr09-independent-${id}-negative`);
        if (id === 'end-step-discover-five' || id === 'opponent-cast-reveal') source(ctx, id);

        if (id === 'end-step-discover-five') {
          conjure(ctx, 'P1', testCard('Must stay in library', '{3}', 'Artifact'), 'library');
          ctx.state.currentTurnPlayer = 'P2';
          ctx.state.activePlayerIndex = 1;
          queueStepTriggers(ctx, 'endStep');
          expect(ctx.state.pendingTriggers).toHaveLength(0);
          expect(playerById(ctx, 'P1').hand).toHaveLength(0);
        } else if (id === 'opponent-cast-reveal') {
          const creature = testCard('Must stay in library', '{2}', 'Creature — Beast');
          conjure(ctx, 'P1', creature, 'library');
          castBy(ctx, 'P1', 'Independent controller spell');
          expect(ctx.state.pendingTriggers).toHaveLength(0);
          expect(playerById(ctx, 'P1').library.some((card) => card.name === creature.name)).toBe(
            true,
          );
        } else if (id === 'dark-confidant') {
          castComposition(ctx, id, ['C', 'B']);
          const land = testCard('Independent zero value reveal', '', 'Land');
          library(ctx, [land]);
          const lifeBefore = playerById(ctx, 'P1').life;
          upkeep(ctx, 'P2');
          expect(playerById(ctx, 'P1').library).toHaveLength(1);
          expect(playerById(ctx, 'P1').life).toBe(lifeBefore);
          upkeep(ctx, 'P1');
          expect(playerById(ctx, 'P1').life).toBe(lifeBefore);
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === land.name)).toBe(true);
          playerById(ctx, 'P1').library = [];
          upkeep(ctx, 'P1');
          expect(playerById(ctx, 'P1').life).toBe(lifeBefore);
          expect(playerById(ctx, 'P1').hasLost).toBe(false);
          expect(ctx.state.eventLog.some((event) => event.type === 'draw')).toBe(false);
        } else if (id === 'keen-duelist') {
          castComposition(ctx, id, ['C', 'B']);
          const ownTop = testCard('Independent Duelist own top', '{3}', 'Artifact');
          const opponentTop = testCard('Independent Duelist opponent top', '{5}', 'Artifact');
          library(ctx, [ownTop]);
          libraryFor(ctx, 'P2', [opponentTop]);
          upkeep(ctx, 'P2');
          expect(ctx.state.pendingTriggers).toHaveLength(0);
          expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
          expect(playerById(ctx, 'P1').library.some((card) => card.name === ownTop.name)).toBe(
            true,
          );
          expect(playerById(ctx, 'P2').library.some((card) => card.name === opponentTop.name)).toBe(
            true,
          );
          expect(playerById(ctx, 'P1').life).toBe(40);
          expect(playerById(ctx, 'P2').life).toBe(40);
        } else if (id === 'szarekh') {
          const szarekh = castComposition(ctx, id, ['C', 'B', 'B', 'B'])!;
          szarekh.summoningSick = false;
          const cards = [
            testCard('Independent generic artifact', '{1}', 'Artifact'),
            testCard('Independent mill spell one', '{1}', 'Sorcery', {
              oracleText: 'You gain 1 life.',
            }),
            testCard('Independent mill spell two', '{2}', 'Sorcery', {
              oracleText: 'You gain 1 life.',
            }),
          ];
          library(ctx, cards);
          resolveCombat(ctx, [szarekh]);
          expect(
            playerById(ctx, 'P1').hand.some((card) =>
              cards.some((entry) => entry.name === card.name),
            ),
          ).toBe(false);
          expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual(
            expect.arrayContaining(cards.map((card) => card.name)),
          );
        } else if (id === 'dream-pillager') {
          const dream = castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C', 'R', 'R'])!;
          dream.summoningSick = false;
          const cards = [
            testCard('Independent blocked top one', '{1}', 'Sorcery', {
              oracleText: 'You gain 1 life.',
            }),
            testCard('Independent blocked top two', '{2}', 'Sorcery', {
              oracleText: 'You gain 1 life.',
            }),
            testCard('Independent blocked top three', '', 'Land'),
            testCard('Independent blocked top four', '{1}', 'Artifact'),
          ];
          library(ctx, cards);
          const blocker = spawn(
            ctx,
            'P2',
            testCard('Independent flying blocker', '{4}', 'Creature — Bird', {
              power: '4',
              toughness: '4',
              keywords: ['Flying'],
              oracleText: 'Flying',
            }),
          );
          resolveCombat(ctx, [dream], pass, [blocker]);
          expect(playerById(ctx, 'P1').library.map((card) => card.name)).toEqual(
            cards.map((card) => card.name),
          );
          expect(
            ctx.state.exile.some((card) => cards.some((entry) => entry.name === card.name)),
          ).toBe(false);
        } else if (id === 'franklin-richards') {
          castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C', 'R']);
          const hit = testCard('Franklin must not discover', '{2}', 'Artifact');
          library(ctx, [hit]);
          queueStepTriggers(ctx, 'beginningOfCombat');
          expect(ctx.state.pendingTriggers).toHaveLength(0);
          settle(ctx);
          expect(playerById(ctx, 'P1').library.some((card) => card.name === hit.name)).toBe(true);
        } else if (id === 'monstrous-vortex') {
          castComposition(ctx, id, ['C', 'C', 'C', 'G']);
          const hit = testCard('Vortex must remain in library', '{2}', 'Artifact');
          library(ctx, [hit]);
          const weak = testCard('Vortex power four spell', '{3}', 'Creature — Beast', {
            power: '4',
            toughness: '4',
          });
          castCardFromHand(ctx, 'P1', weak, ['C', 'C', 'C']);
          expect(playerById(ctx, 'P1').library.some((card) => card.name === hit.name)).toBe(true);
          const enemy = testCard('Vortex opponent power five spell', '{5}', 'Creature — Giant', {
            power: '5',
            toughness: '5',
          });
          ctx.state.currentTurnPlayer = 'P2';
          ctx.state.activePlayerIndex = 1;
          castCardFromHand(ctx, 'P2', enemy, ['C', 'C', 'C', 'C', 'C']);
          expect(playerById(ctx, 'P1').library.some((card) => card.name === hit.name)).toBe(true);
        } else if (id === 'path-of-discovery') {
          castComposition(ctx, id, ['C', 'C', 'C', 'G']);
          const land = testCard('Path opponent entrant top', '', 'Land');
          library(ctx, [land]);
          const enemy = conjure(
            ctx,
            'P2',
            testCard('Path opponent entrant', '{2}', 'Creature — Scout'),
            'hand',
          );
          pump(moveObject(ctx, enemy, { zone: 'battlefield' }));
          settle(ctx);
          expect(playerById(ctx, 'P1').library.some((card) => card.name === land.name)).toBe(true);
          expect(playerById(ctx, 'P2').hand.some((card) => card.name === land.name)).toBe(false);
        } else if (id === 'trumpeting-carnosaur') {
          castComposition(ctx, id, ['C', 'C', 'C', 'C', 'R', 'R']);
          const definition = byId(id);
          registerCustomDef(ctx, structuredClone(definition));
          const makeInHand = (playerId: string) =>
            conjure(
              ctx,
              playerId,
              oracle({
                oracleId: definition.oracleId,
                name: definition.name,
                typeLine: definition.typeLine,
                manaCost: '{4}{R}{R}',
                colors: [...definition.colors],
                colorIdentity: [...definition.colorIdentity],
                subtypes: [...definition.subtypes],
                power: '7',
                toughness: '6',
                oracleText: '',
              }),
              'hand',
            );
          const own = makeInHand('P1');
          const foe = makeInHand('P2');
          spawn(ctx, 'P2', testCard('Carnosaur legal target', '{2}', 'Creature — Test'));
          addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }]);
          expect(activate(ctx, own.id)).toBeUndefined();
          addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }]);
          expect(activate(ctx, own.id)).toBeDefined();
          expect(activate(ctx, foe.id)).toBeUndefined();
          const noTargetCtx = pod('pr09-independent-carnosaur-no-player-target');
          registerCustomDef(noTargetCtx, structuredClone(definition));
          const noTargetCopy = conjure(
            noTargetCtx,
            'P1',
            oracle({
              oracleId: definition.oracleId,
              name: definition.name,
              typeLine: definition.typeLine,
              manaCost: '{4}{R}{R}',
              colors: [...definition.colors],
              colorIdentity: [...definition.colorIdentity],
              subtypes: [...definition.subtypes],
              power: '7',
              toughness: '6',
              oracleText: '',
            }),
            'hand',
          );
          addMana(playerById(noTargetCtx, 'P1'), [
            { symbol: 'C' },
            { symbol: 'C' },
            { symbol: 'R' },
          ]);
          expect(activate(noTargetCtx, noTargetCopy.id)).toBeUndefined();
        } else if (id === 'sunbirds-invocation') {
          castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C', 'R']);
          const hit = testCard('Sunbird opponent spell must not trigger', '{1}', 'Artifact');
          library(ctx, [hit]);
          ctx.state.currentTurnPlayer = 'P2';
          ctx.state.activePlayerIndex = 1;
          castBy(ctx, 'P2', 'Sunbird opponent spell');
          expect(playerById(ctx, 'P1').library.some((card) => card.name === hit.name)).toBe(true);
        } else if (id === 'minds-dilation') {
          castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C', 'U', 'U']);
          const firstLand = testCard('Dilation first opponent land', '', 'Land');
          libraryFor(ctx, 'P2', [firstLand]);
          ctx.state.currentTurnPlayer = 'P2';
          ctx.state.activePlayerIndex = 1;
          castBy(ctx, 'P2', 'Dilation first opponent spell');
          expect(ctx.state.exile.some((card) => card.name === firstLand.name)).toBe(true);
          const second = testCard('Dilation second opponent top', '{1}', 'Artifact');
          libraryFor(ctx, 'P2', [second]);
          castBy(ctx, 'P2', 'Dilation second opponent spell');
          expect(playerById(ctx, 'P2').library.some((card) => card.name === second.name)).toBe(
            true,
          );
          const ownTop = testCard('Dilation your top', '{1}', 'Artifact');
          library(ctx, [ownTop]);
          ctx.state.currentTurnPlayer = 'P1';
          ctx.state.activePlayerIndex = 0;
          castBy(ctx, 'P1', 'Dilation controller spell');
          expect(playerById(ctx, 'P1').library.some((card) => card.name === ownTop.name)).toBe(
            true,
          );
        } else if (id === 'cosmic-cube') {
          const cube = castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C'])!;
          exerciseCubeWard(ctx, cube, false);
          const attacker = spawn(
            ctx,
            'P1',
            testCard('Independent weak attacker', '{1}', 'Creature — Test', {
              power: '2',
              toughness: '2',
            }),
          );
          attacker.summoningSick = false;
          const overLimit = testCard('Independent over-limit spell', '{3}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          library(ctx, [
            overLimit,
            ...Array.from({ length: 5 }, (_, index) =>
              testCard(`Cube negative ${index}`, '', 'Land'),
            ),
          ]);
          const decisions = resolveCombat(ctx, [attacker], (decision) => {
            if (decision.options.some((option) => option.type === 'castFree'))
              throw new Error('mana-value three exceeds the greatest attacking power two');
            return pass(decision);
          });
          expect(
            decisions.decisions.some((decision) =>
              decision.options.some((option) => option.type === 'castFree'),
            ),
          ).toBe(false);
          expect(playerById(ctx, 'P1').library.some((card) => card.name === overLimit.name)).toBe(
            true,
          );
          expect(playerById(ctx, 'P1').library).toHaveLength(6);
        } else if (id === 'aetherworks-marvel') {
          const marvel = castComposition(ctx, id, ['C', 'C', 'C', 'C'])!;
          playerById(ctx, 'P1').energy = 5;
          expect(activate(ctx, marvel.id)).toBeUndefined();
        } else if (id === 'herald-of-amity') {
          const aura = testCard('Independent no-host Aura', '{1}', 'Enchantment — Aura', {
            oracleText: 'Enchant creature',
          });
          const cards = library(ctx, [
            aura,
            ...Array.from({ length: 7 }, (_, index) =>
              testCard(`Herald negative ${index}`, '{1}', 'Sorcery'),
            ),
          ]);
          castComposition(
            ctx,
            id,
            ['C', 'C', 'C', 'W'],
            (decision) => {
              const herald = ctx.state.battlefield.find(
                (permanent) => permanent.name === byId(id).name,
              );
              if (herald !== undefined) pump(moveObject(ctx, herald, { zone: 'graveyard' }));
              const decline = decision.options.findIndex((option) => option.type === 'decline');
              return { index: Math.max(decline, 0), targets: new Map() };
            },
            false,
          );
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === aura.name,
            ),
          ).toBe(false);
          expect(playerById(ctx, 'P1').library).toHaveLength(8);
          expect(new Set(playerById(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
            new Set(cards.map((card) => card.cardId)),
          );
        } else if (id === 'chaos-warp') {
          const card = byId(id);
          registerCustomDef(ctx, structuredClone(card));
          const object = conjure(
            ctx,
            'P1',
            oracle({
              oracleId: card.oracleId,
              name: card.name,
              typeLine: card.typeLine,
              manaCost: '{2}{R}',
              colors: ['R'],
              colorIdentity: ['R'],
              oracleText: '',
            }),
            'hand',
          );
          addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'R' }]);
          expect(
            computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
              (option) => (option.payload as { objectId?: string }).objectId === object.id,
            ),
          ).toBe(false);
        } else if (id === 'adaptive-omnitool') {
          const tool = castComposition(ctx, id, ['C', 'C'])!;
          const unattached = spawn(
            ctx,
            'P1',
            testCard('Omnitool unattached attacker', '{1}', 'Creature — Test'),
          );
          const hit = testCard('Omnitool must remain unseen', '{1}', 'Artifact');
          library(ctx, [
            hit,
            ...Array.from({ length: 5 }, (_, index) =>
              testCard(`Omnitool negative tail ${index}`, '', 'Land'),
            ),
          ]);
          resolveCombat(ctx, [unattached]);
          expect(tool.attachedTo).toBeNull();
          expect(playerById(ctx, 'P1').library.some((card) => card.name === hit.name)).toBe(true);
        } else if (id === 'armored-skyhunter') {
          const hunter = castComposition(ctx, id, ['C', 'C', 'C', 'W'])!;
          hunter.summoningSick = false;
          const artifactOnly = testCard('Skyhunter non-equipment artifact', '{1}', 'Artifact');
          library(ctx, [
            artifactOnly,
            ...Array.from({ length: 5 }, (_, index) =>
              testCard(`Skyhunter negative tail ${index}`, '', 'Land'),
            ),
          ]);
          resolveCombat(ctx, [hunter], (decision) => {
            if (decision.options.some((option) => option.description.includes(artifactOnly.name)))
              throw new Error('plain artifact must not be a legal Skyhunter deployment');
            return pass(decision);
          });
          expect(
            ctx.state.battlefield.some((permanent) => permanent.name === artifactOnly.name),
          ).toBe(false);
          expect(playerById(ctx, 'P1').library).toHaveLength(6);
        } else if (id === 'songbirds-blessing') {
          const host = spawn(
            ctx,
            'P1',
            testCard('Songbirds fallback host', '{2}', 'Creature — Bird'),
          );
          castComposition(ctx, id, ['C', 'C', 'C', 'W'], pass, true, new Map([[0, host.id]]));
          const aura = testCard('Songbirds fallback Aura', '{1}{W}', 'Enchantment — Aura', {
            oracleText: 'Enchant creature',
          });
          library(ctx, [testCard('Songbirds fallback miss', '{1}', 'Sorcery'), aura]);
          resolveCombat(ctx, [host], (decision) => {
            const hand = decision.options.findIndex((option) => option.type === 'putAuraIntoHand');
            return hand >= 0 ? { index: hand, targets: new Map() } : pass(decision);
          });
          expect(playerById(ctx, 'P1').hand.some((card) => card.name === aura.name)).toBe(true);
          expect(ctx.state.battlefield.some((permanent) => permanent.name === aura.name)).toBe(
            false,
          );
        } else if (id === 'expressive-iteration') {
          const handCard = testCard('Iteration negative hand', '{1}', 'Artifact');
          const bottomCard = testCard('Iteration negative bottom', '{1}', 'Sorcery');
          const land = testCard('Iteration expired land', '', 'Land');
          library(ctx, [handCard, bottomCard, land]);
          castComposition(
            ctx,
            id,
            ['U', 'R'],
            (decision) => {
              if (decision.prompt.includes('choose a card to put into your hand'))
                return {
                  index: decision.options.findIndex((option) =>
                    option.description.includes(handCard.name),
                  ),
                  targets: new Map(),
                };
              if (decision.prompt.includes('choose a card to put on the bottom'))
                return {
                  index: decision.options.findIndex((option) =>
                    option.description.includes(bottomCard.name),
                  ),
                  targets: new Map(),
                };
              return pass(decision);
            },
            false,
          );
          const exiled = ctx.state.exile.find((card) => card.name === land.name)!;
          pump(cleanupStep(ctx));
          expect(
            computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
              (option) =>
                option.type === 'playLand' &&
                (option.payload as { objectId?: string }).objectId === exiled.id,
            ),
          ).toBe(false);
        } else if (id === 'genesis-ultimatum') {
          const cards = [
            testCard('Genesis decline creature', '{2}', 'Creature — Beast'),
            testCard('Genesis decline artifact', '{2}', 'Artifact'),
            testCard('Genesis decline spell', '{1}', 'Sorcery'),
            testCard('Genesis decline Aura', '{1}{W}', 'Enchantment — Aura', {
              oracleText: 'Enchant creature',
            }),
            testCard('Genesis decline land', '', 'Land'),
          ];
          library(ctx, cards);
          castComposition(
            ctx,
            id,
            ['G', 'G', 'U', 'U', 'U', 'R', 'R'],
            (decision) => {
              const finish = decision.options.findIndex((option) =>
                /finish choosing/i.test(option.description),
              );
              return finish >= 0 ? { index: finish, targets: new Map() } : pass(decision);
            },
            false,
          );
          expect(playerById(ctx, 'P1').hand.map((card) => card.name)).toEqual(
            expect.arrayContaining(cards.map((card) => card.name)),
          );
          expect(
            ctx.state.battlefield.some((permanent) =>
              cards.some((card) => card.name === permanent.name),
            ),
          ).toBe(false);
        } else if (id === 'etali-primal-conqueror') {
          const etali = castComposition(ctx, id, ['C', 'C', 'C', 'C', 'C', 'R', 'R'])!;
          etali.summoningSick = false;
          addMana(
            playerById(ctx, 'P1'),
            Array.from({ length: 8 }, () => ({ symbol: 'C' as const })),
          );
          expect(activate(ctx, etali.id)).toBeUndefined();
          resolveCombat(ctx, [etali]);
          expect(playerById(ctx, 'P2').life).toBe(33);
          expect(playerById(ctx, 'P2').poisonCounters).toBe(0);
        } else if (id === 'into-the-time-vortex') {
          playerById(ctx, 'P1').library = [];
          castComposition(ctx, id, ['C', 'C', 'C', 'C', 'R'], pass, false);
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === byId(id).name,
            ),
          ).toBe(true);
          expect(ctx.state.exile.some((card) => card.name === byId(id).name)).toBe(true);
          expect(playerById(ctx, 'P1').library).toHaveLength(0);
        } else if (id === 'rabble-rousing') {
          const hidden = testCard('Rabble threshold card', '', 'Land');
          library(ctx, [
            hidden,
            ...Array.from({ length: 4 }, (_, index) =>
              testCard(`Rabble negative filler ${index}`, '', 'Land'),
            ),
          ]);
          castComposition(ctx, id, ['C', 'C', 'C', 'C', 'W'], (decision) => {
            const choice = decision.options.findIndex(
              (option) =>
                option.type === 'hideawayExile' && option.description.includes(hidden.name),
            );
            return choice >= 0 ? { index: choice, targets: new Map() } : pass(decision);
          });
          const attacker = spawn(
            ctx,
            'P1',
            testCard('Rabble sole attacker', '{1}', 'Creature — Test'),
          );
          const support = Array.from({ length: 7 }, (_, index) =>
            spawn(ctx, 'P1', testCard(`Rabble below threshold ${index}`, '{1}', 'Creature — Test')),
          );
          for (const creature of [attacker, ...support]) creature.summoningSick = false;
          resolveCombat(ctx, [attacker]);
          expect(
            ctx.state.battlefield.filter(
              (permanent) =>
                permanent.isToken &&
                computeCharacteristics(ctx, permanent).subtypes.includes('Citizen'),
            ),
          ).toHaveLength(1);
          expect(ctx.state.battlefield.some((permanent) => permanent.name === hidden.name)).toBe(
            false,
          );
          expect(ctx.state.exile.some((card) => card.name === hidden.name)).toBe(true);
        } else if (id === 'celebrate-mountain-king') {
          spawn(ctx, 'P2', forest());
          const land = testCard('Celebrate land draw', '', 'Land');
          library(ctx, [land]);
          castComposition(ctx, id, ['C', 'C', 'C', 'W'], (decision) => {
            const choice = decision.options.findIndex((option) =>
              option.description.includes('Forest'),
            );
            return choice >= 0 ? { index: choice, targets: new Map() } : pass(decision);
          });
          expect(ctx.state.exile.some((card) => card.name === 'Forest')).toBe(false);
          expect(
            ctx.state.battlefield.some(
              (permanent) =>
                permanent.isToken &&
                computeCharacteristics(ctx, permanent).subtypes.includes('Soldier'),
            ),
          ).toBe(false);
          expect(ctx.state.eventLog.filter((event) => event.type === 'draw')).toHaveLength(1);
        } else if (id === 'new-generations-technique') {
          const attacker = spawn(
            ctx,
            'P1',
            testCard('Sneak blocked attacker', '{2}', 'Creature — Bear'),
          );
          const blocker = spawn(ctx, 'P2', testCard('Sneak blocker', '{2}', 'Creature — Bear'));
          attacker.attacking = 'P2';
          attacker.blockedByOrdered = [blocker.id];
          ctx.state.phase = 'combat';
          ctx.state.step = 'declareBlockers';
          const definition = byId(id);
          registerCustomDef(ctx, structuredClone(definition));
          const technique = conjure(
            ctx,
            'P1',
            oracle({
              oracleId: definition.oracleId,
              name: definition.name,
              typeLine: definition.typeLine,
              manaCost: '{3}{G}',
              colors: ['G'],
              colorIdentity: ['G'],
            }),
            'hand',
          );
          addMana(
            playerById(ctx, 'P1'),
            (['C', 'C', 'G', 'C'] as const).map((symbol) => ({ symbol })),
          );
          expect(
            computePriorityOptions(ctx, playerById(ctx, 'P1')).some((entry) => {
              const payload = entry.payload as PriorityActionPayload & { alternativeCast?: string };
              return (
                payload.kind === 'castSpell' &&
                payload.objectId === technique.id &&
                payload.alternativeCast === 'nonMana'
              );
            }),
          ).toBe(false);
          attacker.blockedByOrdered = [];
          playerById(ctx, 'P1').manaEntries = [];
          addMana(
            playerById(ctx, 'P1'),
            (['C', 'G'] as const).map((symbol) => ({ symbol })),
          );
          expect(
            computePriorityOptions(ctx, playerById(ctx, 'P1')).some((entry) => {
              const payload = entry.payload as PriorityActionPayload & { alternativeCast?: string };
              return (
                payload.kind === 'castSpell' &&
                payload.objectId === technique.id &&
                payload.alternativeCast === 'nonMana'
              );
            }),
          ).toBe(false);
        } else if (id === 'tibalts-trickery') {
          const target = conjure(
            ctx,
            'P2',
            testCard('Trickery declined target', '{1}', 'Instant'),
            'hand',
          );
          addMana(playerById(ctx, 'P2'), [{ symbol: 'C' }]);
          const castTarget = computePriorityOptions(ctx, playerById(ctx, 'P2')).find(
            (entry) =>
              (entry.payload as PriorityActionPayload & { objectId?: string }).kind ===
                'castSpell' &&
              (entry.payload as PriorityActionPayload & { objectId?: string }).objectId ===
                target.id,
          );
          expect(castTarget).toBeDefined();
          pump(
            applyPriorityAction(
              ctx,
              playerById(ctx, 'P2'),
              castTarget!.payload as PriorityActionPayload,
              { index: 0, targets: new Map() },
            ),
          );
          const hit = testCard('Trickery declined hit', '{1}', 'Artifact');
          libraryFor(ctx, 'P2', [forest(), forest(), forest(), hit]);
          castComposition(
            ctx,
            id,
            ['R', 'C'],
            (decision) => {
              const decline = decision.options.findIndex((option) => option.type === 'decline');
              if (decision.options.some((option) => /cast .*free/i.test(option.description)))
                expect(decline).toBeGreaterThanOrEqual(0);
              return decline >= 0 ? { index: decline, targets: new Map() } : pass(decision);
            },
            false,
            new Map([
              [0, ctx.state.stack.find((entry) => entry.card?.cardId === target.cardId)!.id],
            ]),
          );
          expect(ctx.state.stack.some((entry) => entry.id === target.id)).toBe(false);
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === hit.name,
            ),
          ).toBe(false);
        } else if (id === 'grenzo-havoc-raiser') {
          const grenzo = castComposition(ctx, id, ['R', 'R'])!;
          const top = testCard('Grenzo undamaged top', '{1}', 'Artifact');
          libraryFor(ctx, 'P2', [top]);
          resolveCombat(ctx, []);
          expect(playerById(ctx, 'P2').library.some((card) => card.name === top.name)).toBe(true);
          expect(ctx.state.exile.some((card) => card.name === top.name)).toBe(false);
          expect(grenzo.summoningSick).toBe(true);
        } else if (id === 'power-pack') {
          const pack = castComposition(ctx, id, ['C', 'R', 'G', 'W', 'U'])!;
          const creature = testCard(
            'Power Pack invalid graveyard target',
            '{2}',
            'Creature — Test',
          );
          const grave = conjure(ctx, 'P1', creature, 'graveyard');
          resolveCombat(ctx, [pack]);
          expect(ctx.state.exile.some((card) => card.cardId === grave.cardId)).toBe(false);
          expect(playerById(ctx, 'P1').graveyard.some((card) => card.cardId === grave.cardId)).toBe(
            true,
          );
          const timingCtx = pod(`pr09-independent-${id}-timing`);
          const timingPack = castComposition(timingCtx, id, ['C', 'R', 'G', 'W', 'U'])!;
          const timingInstant = testCard(
            'Power Pack exact object boundary instant',
            '{1}',
            'Instant',
          );
          const timingGrave = conjure(timingCtx, 'P1', timingInstant, 'graveyard');
          resolveCombat(timingCtx, [timingPack], (decision) => {
            const index = decision.options.findIndex((option) =>
              option.description.includes(timingInstant.name),
            );
            if (index < 0) return pass(decision);
            const slot = decision.options[index]?.targets?.find((target) =>
              target.options.includes(timingGrave.id),
            );
            return {
              index,
              targets: new Map(slot === undefined ? [] : [[slot.slot, timingGrave.id]]),
            };
          });
          const timingExile = timingCtx.state.exile.find(
            (card) => card.cardId === timingGrave.cardId,
          )!;
          upkeep(timingCtx, 'P2');
          expect(
            timingCtx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === timingInstant.name,
            ),
          ).toBe(false);
          pump(moveObject(timingCtx, timingExile, { zone: 'graveyard' }));
          upkeep(timingCtx, 'P1');
          expect(
            timingCtx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === timingInstant.name,
            ),
          ).toBe(false);
          expect(
            playerById(timingCtx, 'P1').graveyard.some(
              (card) => card.cardId === timingGrave.cardId,
            ),
          ).toBe(true);
        } else if (id === 'improvisation-capstone') {
          const land = testCard('Capstone below threshold land', '', 'Land');
          const small = testCard('Capstone below threshold spell', '{1}', 'Sorcery', {
            oracleText: 'You gain 1 life.',
          });
          library(ctx, [land, small]);
          castComposition(
            ctx,
            id,
            ['C', 'C', 'C', 'C', 'C', 'R', 'R'],
            (decision) => ({
              index: decision.options.findIndex((option) => option.type === 'stopCasting'),
              targets: new Map(),
            }),
            false,
          );
          expect(
            ctx.state.eventLog.some(
              (event) => event.type === 'castSpell' && event.payload['name'] === small.name,
            ),
          ).toBe(false);
          expect(ctx.state.exile.some((card) => card.name === small.name)).toBe(true);
          const capstone = ctx.state.exile.find((card) => card.name === byId(id).name)!;
          const delayedCount = ctx.state.delayedTriggers.length;
          ctx.state.currentTurnPlayer = 'P2';
          ctx.state.activePlayerIndex = 1;
          ctx.state.phase = 'precombatMain';
          queueStepTriggers(ctx, 'precombatMain');
          settle(ctx);
          expect(ctx.state.eventLog.filter((event) => event.type === 'cardCopied')).toHaveLength(0);
          ctx.state.currentTurnPlayer = 'P1';
          ctx.state.activePlayerIndex = 0;
          ctx.state.phase = 'postcombatMain';
          queueStepTriggers(ctx, 'secondMainPhase');
          settle(ctx);
          expect(ctx.state.eventLog.filter((event) => event.type === 'cardCopied')).toHaveLength(0);
          ctx.state.phase = 'precombatMain';
          queueStepTriggers(ctx, 'precombatMain');
          expect(ctx.state.pendingTriggers).toHaveLength(1);
          settle(ctx, (decision) => {
            const decline = decision.options.findIndex((option) => option.type === 'decline');
            return decline >= 0 ? { index: decline, targets: new Map() } : pass(decision);
          });
          expect(ctx.state.delayedTriggers).toHaveLength(delayedCount);
          expect(ctx.state.eventLog.filter((event) => event.type === 'cardCopied')).toHaveLength(1);
          expect(ctx.state.exile.some((card) => card.cardId === capstone.cardId)).toBe(true);
          expect(ctx.state.exile.some((card) => card.isCardCopy === true)).toBe(false);
        } else {
          const forge = castComposition(ctx, id, ['C', 'C', 'C', 'C'])!;
          const colored = testCard('Independent Forge forbidden top', '{R}', 'Sorcery', {
            colors: ['R'],
            colorIdentity: ['R'],
          });
          const top = library(ctx, [colored]);
          expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain(colored.name);
          const action = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((entry) => {
            const payload = entry.payload as PriorityActionPayload;
            return payload.kind === 'castSpell' && payload.objectId === top[0]!.id;
          });
          expect(action).toBeUndefined();
          expect(playerById(ctx, 'P1').life).toBe(40);
          expect(forge.tapped).toBe(false);
        }
      });
    }
  }

  it.each([
    ['Chimil, the Inner Sun', 'end-step-discover-five'],
    ['Lurking Predators', 'opponent-cast-reveal'],
    ['Cosmic Cube', 'cosmic-cube'],
    ['Aetherworks Marvel', 'aetherworks-marvel'],
    ['Herald of Amity', 'herald-of-amity'],
    ['Mystic Forge', 'mystic-forge'],
    ['Dark Confidant', 'dark-confidant'],
    ['Keen Duelist', 'keen-duelist'],
    ['Szarekh, the Silent King', 'szarekh'],
    ['Dream Pillager', 'dream-pillager'],
    ['Franklin Richards, Ascendant', 'franklin-richards'],
    ['Monstrous Vortex', 'monstrous-vortex'],
    ['Path of Discovery', 'path-of-discovery'],
    ['Trumpeting Carnosaur', 'trumpeting-carnosaur'],
    ["Sunbird's Invocation", 'sunbirds-invocation'],
    ["Mind's Dilation", 'minds-dilation'],
    ['Chaos Warp', 'chaos-warp'],
    ['Adaptive Omnitool', 'adaptive-omnitool'],
    ['Armored Skyhunter', 'armored-skyhunter'],
    ["Songbirds' Blessing", 'songbirds-blessing'],
    ['Expressive Iteration', 'expressive-iteration'],
    ['Genesis Ultimatum', 'genesis-ultimatum'],
    ['Etali, Primal Conqueror // Etali, Primal Sickness', 'etali-primal-conqueror'],
    ['Into the Time Vortex', 'into-the-time-vortex'],
    ['Rabble Rousing', 'rabble-rousing'],
    ['Celebrate the Mountain-king', 'celebrate-mountain-king'],
    ["New Generation's Technique", 'new-generations-technique'],
    ["Tibalt's Trickery", 'tibalts-trickery'],
    ['Grenzo, Havoc Raiser', 'grenzo-havoc-raiser'],
    ['Power Pack', 'power-pack'],
    ['Improvisation Capstone', 'improvisation-capstone'],
  ] as const)('%s pinned production definition matches %s', (name, id) => {
    const pins = (
      JSON.parse(
        readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
      ) as { cards: { card: OracleCard }[] }
    ).cards;
    const pin = pins.find((entry) => entry.card.name === name)?.card;
    expect(pin, `pinned ${name}`).toBeDefined();
    // This comparison reads production definitions, but the independently authored definitions
    // above remain literal and were not built by the parser or override registry.
    expect(matchesBoundedPr09Library(interpretCard(pin!), id), `${name} / ${id}`).toBe(true);
  });
});
