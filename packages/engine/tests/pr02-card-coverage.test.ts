/**
 * PR02 card coverage: activation and casting costs (docs/plans/card-coverage-chunks.md).
 *
 * Each restored card has a `describe` block whose test names start with the engine test IDs the
 * verification manifest declares for it. The gate at the bottom ties the two together: every
 * restored card must be pinned, modeled under both its real Oracle ID and its fixture alias,
 * declared `implemented-reviewed` in the manifest, and mapped to engine tests in this file and to
 * Card Test Lab scenarios that the real-viewer Playwright spec exercises.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { GameEvent, OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  activationCostReductionFor,
  computePriorityOptions,
  type PriorityActionPayload,
} from '../src/actions/legal';
import type { ActivatedAbility } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { constant } from '../src/cards/value';
import { allOf, IS_TOKEN, not, ofType, YOURS as YOURS_SELECTOR } from '../src/cards/selector';
import { fixtureOracleId, getOverride, registerOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects, executeAbility } from '../src/effects/resolve';
import { parseManaCost } from '../src/mana/cost';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { priorityCheckpoint } from '../src/sba/sba';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers, runCombatAndExtraCombats } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { prepareScenario } from '../src/testing/prepared-scenario';
import { moveObject, playerById } from '../src/state/objects';
import { effectivePT, manaSourcesFor, selfMayTap } from '../src/state/queries';
import { formatPlayerLog } from '../src/view/spectator';
import { buildPlayerView } from '../src/view/view';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
  declareBlocks,
  forest,
  gameConfig,
  island,
  oracle,
  plains,
  pump,
  spawn,
} from './fixtures';

interface PinnedFixture {
  cards: { sha256: string; card: OracleCard }[];
}

const PINNED_FILES = ['fixtures/marchesa-batch1-oracle.json', 'fixtures/coverage-pr02-oracle.json'];
const pinnedCards = PINNED_FILES.flatMap(
  (file) =>
    (JSON.parse(readFileSync(join(import.meta.dirname, file), 'utf8')) as PinnedFixture).cards,
);

function pinned(name: string): { sha256: string; card: OracleCard } {
  const entry = pinnedCards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`missing pinned Oracle fixture for ${name}`);
  return entry;
}

function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

function optionMatching(decision: PendingDecision, pattern: RegExp): DecisionOutcome {
  const index = decision.options.findIndex((option) => pattern.test(option.description));
  if (index < 0) {
    throw new Error(
      `no option matching ${String(pattern)} in: ${decision.options.map((o) => o.description).join(' | ')}`,
    );
  }
  return { index, targets: new Map() };
}

/** Answer each decision whose prompt matches with the option matching the paired pattern. */
function answers(rules: [prompt: RegExp, option: RegExp][]): Answer {
  return (decision) => {
    for (const [prompt, option] of rules) {
      if (prompt.test(decision.prompt)) return optionMatching(decision, option);
    }
    return { index: 0, targets: new Map() };
  };
}

function priorityOptions(ctx: GameContext, playerId: string) {
  return computePriorityOptions(ctx, playerById(ctx, playerId));
}

/** Every activation of `source` the player may take now, in option order. */
function activationsOf(ctx: GameContext, playerId: string, source: EnginePermanent) {
  return priorityOptions(ctx, playerId).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'activateAbility' && payload.objectId === source.id;
  });
}

/** The activation of `source` whose description matches `pattern`, if it is legal now. */
function activationMatching(
  ctx: GameContext,
  playerId: string,
  source: EnginePermanent,
  pattern: RegExp,
) {
  return activationsOf(ctx, playerId, source).find((option) => pattern.test(option.description));
}

/** Take a priority action through the normal legality/payment path and leave it on the stack. */
function takeAction(
  ctx: GameContext,
  playerId: string,
  payload: PriorityActionPayload,
  answer?: Answer,
  targets: ReadonlyMap<number, string> = new Map(),
) {
  return pump(
    applyPriorityAction(ctx, playerById(ctx, playerId), payload, { index: 0, targets }),
    answer,
  );
}

/** The priority option that casts `objectId` from its current zone, if it is legal now. */
function castOptionFor(ctx: GameContext, playerId: string, objectId: string) {
  return priorityOptions(ctx, playerId).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}

function resolveTop(ctx: GameContext, answer?: Answer) {
  return pump(resolveTopOfStack(ctx), answer);
}

/**
 * Run the normal priority loop with every player passing: pending triggers go on the stack and
 * resolve in order. Non-priority decisions go to `answer` (default: first option).
 */
function settle(ctx: GameContext, answer?: Answer) {
  return pump(runPrioritySequence(ctx), (decision, count) => {
    const pass = decision.options.findIndex((option) => option.type === 'pass');
    if (pass >= 0) return { index: pass, targets: new Map() };
    return answer?.(decision, count) ?? { index: 0, targets: new Map() };
  });
}

const SECRET_CARD = (name: string) => oracle({ name, typeLine: 'Creature — Secret' });

/** Move a card onto the battlefield through the normal zone change, queueing its triggers. */
function enterFor(ctx: GameContext, controllerId: string, card: OracleCard) {
  const object = conjure(ctx, controllerId, card, 'hand');
  pump(moveObject(ctx, object, { zone: 'battlefield', controllerId }));
  return ctx.state.battlefield.find((perm) => perm.cardId === object.cardId);
}

const generic = (n: number) => Array.from({ length: n }, () => ({ symbol: 'C' as const }));

/** The pinned card is modeled under both ids with no remaining reasons. */
function expectModeled(card: OracleCard): void {
  for (const candidate of [card, { ...card, oracleId: fixtureOracleId(card.name) }]) {
    const def = interpretCard(candidate);
    expect(def.unmodeledReasons, candidate.oracleId).toEqual([]);
    expect(def.modeled, candidate.oracleId).toBe(true);
  }
}

// ---------------------------------------------------------------------------------------------
// 2.03 Retrofitter Foundry
// ---------------------------------------------------------------------------------------------

describe('Retrofitter Foundry', () => {
  const foundry = pinned('Retrofitter Foundry');
  const SERVO = /Servo artifact creature token\.$/;
  const THOPTER = /Sacrifice a Servo/;
  const CONSTRUCT = /Sacrifice a Thopter/;
  const UNTAP = /Untap this artifact/;

  function ready(seed: string, mana: number) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', foundry.card);
    addMana(playerById(ctx, 'P1'), generic(mana));
    return { ctx, source };
  }

  function tokens(ctx: GameContext, name: string) {
    return ctx.state.battlefield.filter((perm) => perm.isToken && perm.name === name);
  }

  it('retrofitter-foundry-pinned-oracle-supported — the interpreter alone models all four abilities', () => {
    expect(foundry.sha256).toBe('39cf3707dcf66c91dc222d73e8ee28cb898c9969c597ae3c12a916d1b7537bc3');
    expect(foundry.card.oracleText).toBe(
      '{3}: Untap this artifact.\n{2}, {T}: Create a 1/1 colorless Servo artifact creature token.\n{1}, {T}, Sacrifice a Servo: Create a 1/1 colorless Thopter artifact creature token with flying.\n{T}, Sacrifice a Thopter: Create a 4/4 colorless Construct artifact creature token.',
    );
    // The fail-closed registration is gone: nothing replaces the parsed activated abilities.
    expect(getOverride(foundry.card.oracleId)).toBeUndefined();
    expect(getOverride(fixtureOracleId(foundry.card.name))).toBeUndefined();
    expectModeled(foundry.card);
    const def = interpretCard(foundry.card);
    expect(def.activatedAbilities.map((entry) => entry.ability.description)).toEqual(
      foundry.card.oracleText.split('\n'),
    );
  });

  it('retrofitter-foundry-servo — {2}, {T} creates a 1/1 colorless Servo artifact creature', () => {
    const { ctx, source } = ready('foundry-servo', 2);
    const option = activationMatching(ctx, 'P1', source, SERVO);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    resolveTop(ctx);
    const [servo] = tokens(ctx, 'Servo');
    expect(servo).toBeDefined();
    const chars = computeCharacteristics(ctx, servo!);
    expect(chars.types).toEqual(['Artifact', 'Creature']);
    expect(chars.subtypes).toEqual(['Servo']);
    expect(chars.colors).toEqual([]);
    expect([chars.power, chars.toughness]).toEqual([1, 1]);
  });

  it('retrofitter-foundry-servo-needs-mana-and-untapped — {1} is not enough and a tapped Foundry cannot', () => {
    const short = ready('foundry-servo-short', 1);
    expect(activationMatching(short.ctx, 'P1', short.source, SERVO)).toBeUndefined();
    const tapped = ready('foundry-servo-tapped', 2);
    tapped.source.tapped = true;
    expect(activationMatching(tapped.ctx, 'P1', tapped.source, SERVO)).toBeUndefined();
    expect(activationsOf(tapped.ctx, 'P2', tapped.source)).toEqual([]);
  });

  it('retrofitter-foundry-untap — {3} untaps the Foundry through the stack', () => {
    const { ctx, source } = ready('foundry-untap', 3);
    source.tapped = true;
    const option = activationMatching(ctx, 'P1', source, UNTAP);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    expect(ctx.state.stack).toHaveLength(1);
    resolveTop(ctx);
    expect(source.tapped).toBe(false);
  });

  it('retrofitter-foundry-untap-needs-three — {2} cannot pay the untap ability', () => {
    const { ctx, source } = ready('foundry-untap-short', 2);
    source.tapped = true;
    expect(activationMatching(ctx, 'P1', source, UNTAP)).toBeUndefined();
  });

  it('retrofitter-foundry-thopter — {1}, {T}, sacrifice a Servo creates a flying Thopter', () => {
    const { ctx, source } = ready('foundry-thopter', 1);
    const servo = spawn(
      ctx,
      'P1',
      oracle({ name: 'Lab Servo', typeLine: 'Artifact Creature — Servo' }),
    );
    const option = activationMatching(ctx, 'P1', source, THOPTER);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.battlefield.some((perm) => perm.id === servo.id)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toContain('Lab Servo');
    resolveTop(ctx);
    const [thopter] = tokens(ctx, 'Thopter');
    expect(thopter).toBeDefined();
    const chars = computeCharacteristics(ctx, thopter!);
    expect(chars.keywords).toContain('flying');
    expect(chars.colors).toEqual([]);
    expect([chars.power, chars.toughness]).toEqual([1, 1]);
  });

  it('retrofitter-foundry-thopter-needs-own-servo — no Servo, or only an opponent’s, offers nothing', () => {
    const none = ready('foundry-thopter-none', 1);
    spawn(none.ctx, 'P1', oracle({ name: 'Lab Bear', typeLine: 'Creature — Bear' }));
    expect(activationMatching(none.ctx, 'P1', none.source, THOPTER)).toBeUndefined();
    const theirs = ready('foundry-thopter-theirs', 1);
    spawn(theirs.ctx, 'P2', oracle({ name: 'Lab Servo', typeLine: 'Artifact Creature — Servo' }));
    expect(activationMatching(theirs.ctx, 'P1', theirs.source, THOPTER)).toBeUndefined();
  });

  it('retrofitter-foundry-construct — {T}, sacrifice a Thopter creates a 4/4 Construct', () => {
    const { ctx, source } = ready('foundry-construct', 0);
    const thopter = spawn(
      ctx,
      'P1',
      oracle({ name: 'Lab Thopter', typeLine: 'Artifact Creature — Thopter' }),
    );
    const option = activationMatching(ctx, 'P1', source, CONSTRUCT);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.battlefield.some((perm) => perm.id === thopter.id)).toBe(false);
    resolveTop(ctx);
    const [construct] = tokens(ctx, 'Construct');
    expect(construct).toBeDefined();
    const chars = computeCharacteristics(ctx, construct!);
    expect(chars.types).toEqual(['Artifact', 'Creature']);
    expect([chars.power, chars.toughness]).toEqual([4, 4]);
  });

  it('retrofitter-foundry-construct-needs-thopter — a Servo is not a Thopter', () => {
    const { ctx, source } = ready('foundry-construct-none', 0);
    spawn(ctx, 'P1', oracle({ name: 'Lab Servo', typeLine: 'Artifact Creature — Servo' }));
    expect(activationMatching(ctx, 'P1', source, CONSTRUCT)).toBeUndefined();
  });

  it('retrofitter-foundry-full-chain — Servo, untap, Thopter, untap, Construct in one turn', () => {
    const { ctx, source } = ready('foundry-chain', 9);
    const step = (pattern: RegExp, answer?: Answer) => {
      const option = activationMatching(ctx, 'P1', source, pattern);
      expect(option, String(pattern)).toBeDefined();
      takeAction(ctx, 'P1', option!.payload as PriorityActionPayload, answer);
      resolveTop(ctx);
    };
    step(SERVO);
    step(UNTAP);
    step(THOPTER);
    step(UNTAP);
    step(CONSTRUCT);
    expect(tokens(ctx, 'Servo')).toEqual([]);
    expect(tokens(ctx, 'Thopter')).toEqual([]);
    expect(tokens(ctx, 'Construct')).toHaveLength(1);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    expect(settle(ctx)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Shared primitive: extendCard appends authored ability lists to the interpreted ones
// ---------------------------------------------------------------------------------------------

describe('extendCard ability composition', () => {
  const twoLines = (name: string) =>
    oracle({
      name,
      typeLine: 'Artifact',
      oracleText: '{T}: Add {C}.\nFrobnicate the widget.',
    });
  const authored = {
    manaAbilities: [{ units: [['G' as const]] }],
  };

  it('extend-card-appends-to-parsed-lists — an append override keeps the parsed mana ability', () => {
    const card = twoLines('Lab Append Rock');
    registerOverride({
      oracleId: card.oracleId,
      name: card.name,
      handledLines: ['Frobnicate the widget.'],
      def: authored,
      compose: 'append',
    });
    const def = interpretCard(card);
    expect(def.modeled).toBe(true);
    expect(def.manaAbilities).toEqual([{ units: [['C']] }, { units: [['G']] }]);
  });

  it('extend-card-default-merge-still-replaces — a plain override still replaces the list (rule 4)', () => {
    const card = twoLines('Lab Replace Rock');
    registerOverride({
      oracleId: card.oracleId,
      name: card.name,
      handledLines: ['Frobnicate the widget.'],
      def: authored,
    });
    expect(interpretCard(card).manaAbilities).toEqual([{ units: [['G']] }]);
  });

  it('extend-card-leaves-unlisted-fields-alone — lists the override omits stay interpreted', () => {
    const card = oracle({
      name: 'Lab Untouched Rock',
      typeLine: 'Artifact',
      oracleText: '{T}: Add {C}.\n{3}: Untap this artifact.\nFrobnicate the widget.',
    });
    const parsed = interpretCard({ ...card, oracleId: 'lab-untouched-rock-unregistered' });
    expect(parsed.activatedAbilities).toHaveLength(1);
    registerOverride({
      oracleId: card.oracleId,
      name: card.name,
      handledLines: ['Frobnicate the widget.'],
      def: authored,
      compose: 'append',
    });
    const def = interpretCard(card);
    expect(def.manaAbilities).toEqual([{ units: [['C']] }, { units: [['G']] }]);
    expect(def.activatedAbilities).toEqual(parsed.activatedAbilities);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.23 Aether Hub
// ---------------------------------------------------------------------------------------------

describe('Aether Hub', () => {
  const hub = pinned('Aether Hub');
  const greenSpell = () =>
    oracle({ name: 'Hub Green Spell', typeLine: 'Creature — Bear', manaCost: '{G}' });
  const colorlessSpell = () =>
    oracle({ name: 'Hub Generic Spell', typeLine: 'Creature — Bear', manaCost: '{1}' });

  function withHub(seed: string, energy: number) {
    const ctx = pod(seed);
    const land = spawn(ctx, 'P1', hub.card);
    playerById(ctx, 'P1').energy = energy;
    return { ctx, land };
  }

  it('aether-hub-pinned-oracle-supported — appends the energy ability to the parsed {T}: Add {C}', () => {
    expect(hub.sha256).toBe('a6641d8a589b60feec25b6da189a097707da60158d6196778bc6365bcccf88ec');
    expect(hub.card.oracleText).toBe(
      'When this land enters, you get {E} (an energy counter).\n{T}: Add {C}.\n{T}, Pay {E}: Add one mana of any color.',
    );
    expectModeled(hub.card);
    expect(getOverride(hub.card.oracleId)?.compose).toBe('append');
    const def = interpretCard(hub.card);
    expect(def.manaAbilities).toEqual([
      { units: [['C']] },
      {
        units: [['W', 'U', 'B', 'R', 'G']],
        costs: [{ kind: 'tap' }, { kind: 'payEnergy', amount: 1 }],
      },
    ]);
    expect(def.triggers).toHaveLength(1);
  });

  it('aether-hub-enters-energy — a normal land play triggers and gives one energy', () => {
    const ctx = pod('hub-land-play');
    const inHand = conjure(ctx, 'P1', hub.card, 'hand');
    const play = priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === inHand.id;
    });
    expect(play).toBeDefined();
    takeAction(ctx, 'P1', play!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').energy).toBe(0);
    settle(ctx);
    expect(playerById(ctx, 'P1').energy).toBe(1);
    const entered = ctx.state.battlefield.find((entry) => entry.cardId === inHand.cardId);
    expect(entered?.tapped).toBe(false);
  });

  it('aether-hub-colorless-without-energy — {T}: Add {C} pays a generic cost and spends no energy', () => {
    const { ctx, land } = withHub('hub-colorless', 0);
    const spell = conjure(ctx, 'P1', colorlessSpell(), 'hand');
    expect(manaSourcesFor(ctx, 'P1').some((source) => source.cardId === land.cardId)).toBe(true);
    const cast = castOptionFor(ctx, 'P1', spell.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    expect(land.tapped).toBe(true);
    expect(playerById(ctx, 'P1').energy).toBe(0);
    expect(ctx.state.stack).toHaveLength(1);
  });

  it('aether-hub-energy-any-color — {T}, Pay {E} adds a colored mana and spends the energy', () => {
    const { ctx, land } = withHub('hub-any-color', 2);
    const spell = conjure(ctx, 'P1', greenSpell(), 'hand');
    const cast = castOptionFor(ctx, 'P1', spell.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    expect(land.tapped).toBe(true);
    expect(playerById(ctx, 'P1').energy).toBe(1);
    expect(ctx.state.stack).toHaveLength(1);
  });

  it('aether-hub-no-energy-no-color — without energy the Hub cannot pay {G}', () => {
    const { ctx } = withHub('hub-no-energy', 0);
    const spell = conjure(ctx, 'P1', greenSpell(), 'hand');
    expect(castOptionFor(ctx, 'P1', spell.id)).toBeUndefined();
  });

  it('aether-hub-one-mana-per-tap — both abilities need {T}, so the Hub cannot pay {G}{1}', () => {
    const { ctx } = withHub('hub-one-tap', 3);
    const spell = conjure(
      ctx,
      'P1',
      oracle({ name: 'Hub Two Mana Spell', typeLine: 'Creature — Bear', manaCost: '{1}{G}' }),
      'hand',
    );
    expect(castOptionFor(ctx, 'P1', spell.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// 2.29 Solar Transformer
// ---------------------------------------------------------------------------------------------

describe('Solar Transformer', () => {
  const transformer = pinned('Solar Transformer');
  const bear = (manaCost: string) =>
    oracle({ name: `Solar Bear ${manaCost}`, typeLine: 'Creature — Bear', manaCost });

  function withTransformer(seed: string, energy: number) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', transformer.card);
    playerById(ctx, 'P1').energy = energy;
    return { ctx, source };
  }

  it('solar-transformer-pinned-oracle-supported — keeps enters-tapped and {T}: Add {C}, appends the energy ability', () => {
    expect(transformer.sha256).toBe(
      '2a416da6016481cde18645f08b0a9c28b2da620d08fe234bb82abcf7ef8719a3',
    );
    expect(transformer.card.oracleText).toBe(
      'This artifact enters tapped.\nWhen this artifact enters, you get {E}{E}{E} (three energy counters).\n{T}: Add {C}.\n{T}, Pay {E}: Add one mana of any color.',
    );
    expectModeled(transformer.card);
    expect(getOverride(transformer.card.oracleId)?.compose).toBe('append');
    const def = interpretCard(transformer.card);
    expect(def.entersTapped).toBe(true);
    expect(def.manaAbilities).toEqual([
      { units: [['C']] },
      {
        units: [['W', 'U', 'B', 'R', 'G']],
        costs: [{ kind: 'tap' }, { kind: 'payEnergy', amount: 1 }],
      },
    ]);
  });

  it('solar-transformer-cast-enters-tapped-with-energy — cast for {2}, it enters tapped and gives three energy', () => {
    const ctx = pod('solar-cast');
    const inHand = conjure(ctx, 'P1', transformer.card, 'hand');
    addMana(playerById(ctx, 'P1'), generic(2));
    const cast = castOptionFor(ctx, 'P1', inHand.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    settle(ctx);
    const entered = ctx.state.battlefield.find((entry) => entry.cardId === inHand.cardId);
    expect(entered?.tapped).toBe(true);
    expect(playerById(ctx, 'P1').energy).toBe(3);
  });

  it('solar-transformer-tapped-on-entry-makes-no-mana — the turn it enters it cannot pay for anything', () => {
    const ctx = pod('solar-entry-tapped');
    const inHand = conjure(ctx, 'P1', transformer.card, 'hand');
    addMana(playerById(ctx, 'P1'), generic(2));
    takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', inHand.id)!.payload as PriorityActionPayload);
    settle(ctx);
    const follow = conjure(ctx, 'P1', bear('{1}'), 'hand');
    expect(castOptionFor(ctx, 'P1', follow.id)).toBeUndefined();
  });

  it('solar-transformer-colorless — {T}: Add {C} pays {1} without spending energy', () => {
    const { ctx, source } = withTransformer('solar-colorless', 0);
    const spell = conjure(ctx, 'P1', bear('{1}'), 'hand');
    takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', spell.id)!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    expect(playerById(ctx, 'P1').energy).toBe(0);
  });

  it('solar-transformer-energy-any-color — {T}, Pay {E} pays {R} and spends one energy', () => {
    const { ctx, source } = withTransformer('solar-any-color', 3);
    const spell = conjure(ctx, 'P1', bear('{R}'), 'hand');
    takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', spell.id)!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    expect(playerById(ctx, 'P1').energy).toBe(2);
  });

  it('solar-transformer-no-energy-no-color — without energy it cannot pay {R}', () => {
    const { ctx } = withTransformer('solar-no-energy', 0);
    const spell = conjure(ctx, 'P1', bear('{R}'), 'hand');
    expect(castOptionFor(ctx, 'P1', spell.id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// 2.32 Bespoke Battlewagon
// ---------------------------------------------------------------------------------------------

describe('Bespoke Battlewagon', () => {
  const wagon = pinned('Bespoke Battlewagon');
  const GAIN = /\{T\}: You get \{E\}\{E\}/;
  const TAP_TARGET = /Tap target creature/;
  const DRAW = /Draw a card/;
  const ANIMATE = /becomes an artifact creature/;
  const CREW = /^.*Crew 4/;

  function ready(seed: string, energy: number) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', wagon.card);
    playerById(ctx, 'P1').energy = energy;
    return { ctx, source };
  }

  const isCreature = (ctx: GameContext, perm: EnginePermanent) =>
    computeCharacteristics(ctx, perm).types.includes('Creature');

  it('bespoke-battlewagon-pinned-oracle-supported — appends four energy activations to the parsed Crew 4', () => {
    expect(wagon.sha256).toBe('17244fc3e0a51b50c27c6b7583124bd9d6773c9a102cea36f4055792ea885d21');
    expect(wagon.card.oracleText).toBe(
      '{T}: You get {E}{E} (two energy counters).\n{T}, Pay {E}{E}: Tap target creature.\n{T}, Pay {E}{E}{E}: Draw a card.\nPay {E}{E}{E}{E}: This Vehicle becomes an artifact creature until end of turn.\nCrew 4',
    );
    expectModeled(wagon.card);
    expect(getOverride(wagon.card.oracleId)?.compose).toBe('append');
    const def = interpretCard(wagon.card);
    expect(def.activatedAbilities.map((entry) => entry.ability.description)).toEqual([
      'Crew 4',
      '{T}: You get {E}{E}.',
      '{T}, Pay {E}{E}: Tap target creature.',
      '{T}, Pay {E}{E}{E}: Draw a card.',
      'Pay {E}{E}{E}{E}: This Vehicle becomes an artifact creature until end of turn.',
    ]);
  });

  it('prepared-scenario-energy — a Card Test Lab position can start a player with energy', () => {
    const ctx = pod('wagon-prepared-energy');
    prepareScenario(ctx, {
      currentTurnPlayer: 'P1',
      phase: 'precombatMain',
      step: null,
      turnNumber: 1,
      hand: [],
      battlefield: [],
      energy: [{ playerId: 'P1', amount: 7 }],
    });
    expect(playerById(ctx, 'P1').energy).toBe(7);
    expect(playerById(ctx, 'P2').energy).toBe(0);
    expect(() =>
      prepareScenario(ctx, {
        currentTurnPlayer: 'P1',
        phase: 'precombatMain',
        step: null,
        turnNumber: 1,
        hand: [],
        battlefield: [],
        energy: [{ playerId: 'P9', amount: 1 }],
      }),
    ).toThrow(/unknown player/);
  });

  it('bespoke-battlewagon-gain-energy — {T} gives two energy through the stack', () => {
    const { ctx, source } = ready('wagon-gain', 0);
    const option = activationMatching(ctx, 'P1', source, GAIN);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    expect(playerById(ctx, 'P1').energy).toBe(0);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').energy).toBe(2);
  });

  it('bespoke-battlewagon-tap-abilities-need-untapped — a tapped Battlewagon offers only the energy animation', () => {
    const { ctx, source } = ready('wagon-tapped', 9);
    // A legal target exists, so only the tapped Battlewagon keeps "Tap target creature" away.
    spawn(ctx, 'P2', oracle({ name: 'Wagon Victim', typeLine: 'Creature — Ox' }));
    expect(activationMatching(ctx, 'P1', source, TAP_TARGET)).toBeDefined();
    source.tapped = true;
    const offered = activationsOf(ctx, 'P1', source).map((option) => option.description);
    expect(offered.some((text) => GAIN.test(text))).toBe(false);
    expect(offered.some((text) => TAP_TARGET.test(text))).toBe(false);
    expect(offered.some((text) => DRAW.test(text))).toBe(false);
    expect(offered.some((text) => ANIMATE.test(text))).toBe(true);
  });

  it('bespoke-battlewagon-tap-target-creature — {T}, Pay {E}{E} taps an opponent’s creature', () => {
    const { ctx, source } = ready('wagon-tap-target', 2);
    const victim = spawn(ctx, 'P2', oracle({ name: 'Wagon Victim', typeLine: 'Creature — Ox' }));
    const option = activationMatching(ctx, 'P1', source, TAP_TARGET);
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, victim.id]]),
    );
    expect(playerById(ctx, 'P1').energy).toBe(0);
    expect(victim.tapped).toBe(false);
    resolveTop(ctx);
    expect(victim.tapped).toBe(true);
  });

  it('bespoke-battlewagon-tap-target-needs-two-energy — one energy cannot pay it', () => {
    const { ctx, source } = ready('wagon-tap-short', 1);
    spawn(ctx, 'P2', oracle({ name: 'Wagon Victim', typeLine: 'Creature — Ox' }));
    expect(activationMatching(ctx, 'P1', source, TAP_TARGET)).toBeUndefined();
  });

  it('bespoke-battlewagon-draw — {T}, Pay {E}{E}{E} draws a card', () => {
    const { ctx, source } = ready('wagon-draw', 3);
    const before = playerById(ctx, 'P1').hand.length;
    const option = activationMatching(ctx, 'P1', source, DRAW);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').energy).toBe(0);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(before + 1);
    const short = ready('wagon-draw-short', 2);
    expect(activationsOf(short.ctx, 'P1', short.source).length).toBeGreaterThan(0);
    expect(activationMatching(short.ctx, 'P1', short.source, DRAW)).toBeUndefined();
  });

  it('bespoke-battlewagon-animate — Pay {E}{E}{E}{E} makes it a 5/6 artifact creature until end of turn', () => {
    const { ctx, source } = ready('wagon-animate', 4);
    expect(isCreature(ctx, source)).toBe(false);
    const option = activationMatching(ctx, 'P1', source, ANIMATE);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(false);
    expect(playerById(ctx, 'P1').energy).toBe(0);
    resolveTop(ctx);
    const chars = computeCharacteristics(ctx, source);
    expect(chars.types).toEqual(expect.arrayContaining(['Artifact', 'Creature']));
    expect([chars.power, chars.toughness]).toEqual([5, 6]);
    endUntilEotEffects(ctx);
    expect(isCreature(ctx, source)).toBe(false);
  });

  it('bespoke-battlewagon-animate-needs-four-energy — three energy cannot pay it', () => {
    const { ctx, source } = ready('wagon-animate-short', 3);
    expect(activationMatching(ctx, 'P1', source, ANIMATE)).toBeUndefined();
  });

  it('bespoke-battlewagon-crew-kept — Crew 4 still taps power-4 creatures to animate it', () => {
    const { ctx, source } = ready('wagon-crew', 0);
    const crew = spawn(
      ctx,
      'P1',
      oracle({ name: 'Wagon Crew', typeLine: 'Creature — Giant', power: '4', toughness: '4' }),
    );
    const option = activationMatching(ctx, 'P1', source, CREW);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(crew.tapped).toBe(true);
    resolveTop(ctx);
    expect(isCreature(ctx, source)).toBe(true);
  });

  it('bespoke-battlewagon-crew-needs-power-four — a 3-power creature cannot crew it', () => {
    const { ctx, source } = ready('wagon-crew-short', 0);
    spawn(
      ctx,
      'P1',
      oracle({ name: 'Wagon Weakling', typeLine: 'Creature — Elf', power: '3', toughness: '3' }),
    );
    expect(activationMatching(ctx, 'P1', source, CREW)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Shared primitive: "Activate only if <condition>." on activated abilities (CR 602.5b)
// ---------------------------------------------------------------------------------------------

describe('activation-condition grammar', () => {
  const withLine = (name: string, line: string) =>
    interpretCard(oracle({ name, typeLine: 'Artifact', oracleText: line }));

  it('activation-condition-parses-known-phrasings — each phrasing becomes a condition on the ability', () => {
    const cases: [string, unknown][] = [
      [
        'you control three or more lands with the same name',
        { kind: 'controlsLandsWithSameName', n: 3 },
      ],
      [
        'an opponent controls more lands than you',
        { kind: 'opponentControlsMore', selector: { kind: 'type', value: 'Land' } },
      ],
      ['you created a token this turn', { kind: 'createdTokenThisTurn' }],
    ];
    for (const [phrase, condition] of cases) {
      const def = withLine(`Lab Gate ${phrase}`, `{1}: Draw a card. Activate only if ${phrase}.`);
      expect(def.modeled, phrase).toBe(true);
      expect(def.activatedAbilities[0]?.condition, phrase).toEqual(condition);
    }
  });

  it('activation-condition-unknown-phrasing-stays-unmodeled — an unread condition never becomes unconditional', () => {
    const def = withLine(
      'Lab Gate Unknown',
      '{1}: Draw a card. Activate only if the moon is full.',
    );
    expect(def.modeled).toBe(false);
    expect(def.activatedAbilities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.10 Endless Atlas
// ---------------------------------------------------------------------------------------------

describe('Endless Atlas', () => {
  const atlas = pinned('Endless Atlas');

  function ready(seed: string, lands: (() => OracleCard)[], mana = 2) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', atlas.card);
    for (const land of lands) spawn(ctx, 'P1', land());
    addMana(playerById(ctx, 'P1'), generic(mana));
    return { ctx, source };
  }

  it('endless-atlas-pinned-oracle-supported — the interpreter reads the draw and its same-name condition', () => {
    expect(atlas.sha256).toBe('e1d31dc2c8118f97fe833d58fce9caf77240ad6f11bae0a80cb066638303a610');
    expect(atlas.card.oracleText).toBe(
      '{2}, {T}: Draw a card. Activate only if you control three or more lands with the same name.',
    );
    expect(getOverride(atlas.card.oracleId)).toBeUndefined();
    expect(getOverride(fixtureOracleId(atlas.card.name))).toBeUndefined();
    expectModeled(atlas.card);
    expect(interpretCard(atlas.card).activatedAbilities).toEqual([
      expect.objectContaining({ condition: { kind: 'controlsLandsWithSameName', n: 3 } }),
    ]);
  });

  it('endless-atlas-draws-with-three-same-name-lands — three Forests allow the {2}, {T} draw', () => {
    const { ctx, source } = ready('atlas-three-forests', [forest, forest, forest]);
    const before = playerById(ctx, 'P1').hand.length;
    const option = activationsOf(ctx, 'P1', source)[0];
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(before + 1);
  });

  it('endless-atlas-mixed-names-blocked — two Forests and an Island do not satisfy it', () => {
    const { ctx, source } = ready('atlas-mixed', [forest, forest, island, plains]);
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
  });

  it('endless-atlas-only-your-lands — an opponent’s Forests do not count toward yours', () => {
    const { ctx, source } = ready('atlas-theirs', [forest, forest]);
    for (let i = 0; i < 3; i++) spawn(ctx, 'P2', forest());
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
    spawn(ctx, 'P1', forest());
    expect(activationsOf(ctx, 'P1', source)).toHaveLength(1);
  });

  it('endless-atlas-costs — {1} or a tapped Atlas cannot activate it', () => {
    // The Forests still count while tapped; tapping them leaves only the pool's {1} to pay.
    const short = ready('atlas-short-mana', [forest, forest, forest], 1);
    for (const land of short.ctx.state.battlefield) {
      if (land.name === 'Forest') land.tapped = true;
    }
    expect(activationsOf(short.ctx, 'P1', short.source)).toEqual([]);
    addMana(playerById(short.ctx, 'P1'), generic(1));
    expect(activationsOf(short.ctx, 'P1', short.source)).toHaveLength(1);
    const tapped = ready('atlas-tapped', [forest, forest, forest]);
    tapped.source.tapped = true;
    expect(activationsOf(tapped.ctx, 'P1', tapped.source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.21 Sceptre of Eternal Glory
// ---------------------------------------------------------------------------------------------

describe('Sceptre of Eternal Glory', () => {
  const sceptre = pinned('Sceptre of Eternal Glory');
  const bear = (manaCost: string) =>
    oracle({ name: `Sceptre Bear ${manaCost}`, typeLine: 'Creature — Bear', manaCost });

  /** The lands count for the condition but are tapped, so only the Sceptre can pay. */
  function ready(seed: string, lands: (() => OracleCard)[]) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', sceptre.card);
    for (const land of lands) spawn(ctx, 'P1', land()).tapped = true;
    return { ctx, source };
  }

  const castable = (ctx: GameContext, manaCost: string) =>
    castOptionFor(ctx, 'P1', conjure(ctx, 'P1', bear(manaCost), 'hand').id) !== undefined;

  it('sceptre-of-eternal-glory-pinned-oracle-supported — the interpreter reads both mana abilities and the condition', () => {
    expect(sceptre.sha256).toBe('51ed0fa70d837b566989f2a57ef7b70bf50985d3c5c84b9d713f04a501aac2f5');
    expect(sceptre.card.oracleText).toBe(
      '{T}: Add one mana of any color.\n{T}: Add three mana of any one color. Activate only if you control three or more lands with the same name.',
    );
    expect(getOverride(sceptre.card.oracleId)).toBeUndefined();
    expectModeled(sceptre.card);
    const any = ['W', 'U', 'B', 'R', 'G'];
    expect(interpretCard(sceptre.card).manaAbilities).toEqual([
      { units: [any] },
      {
        units: [any, any, any],
        linked: true,
        condition: { kind: 'controlsLandsWithSameName', n: 3 },
      },
    ]);
  });

  it('sceptre-of-eternal-glory-one-of-any-color — without the condition it still makes one mana of any color', () => {
    const { ctx } = ready('sceptre-one', [forest, forest, island]);
    expect(castable(ctx, '{U}')).toBe(true);
    expect(castable(ctx, '{U}{U}')).toBe(false);
  });

  it('sceptre-of-eternal-glory-three-of-one-color — three same-name lands unlock {B}{B}{B}', () => {
    const { ctx, source } = ready('sceptre-three', [forest, forest, forest]);
    const spell = conjure(ctx, 'P1', bear('{B}{B}{B}'), 'hand');
    const cast = castOptionFor(ctx, 'P1', spell.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    expect(ctx.state.stack).toHaveLength(1);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
  });

  it('sceptre-of-eternal-glory-one-color-only — the three mana are one color, so {W}{U}{1} stays unpayable', () => {
    const { ctx } = ready('sceptre-linked', [forest, forest, forest]);
    expect(castable(ctx, '{W}{W}{1}')).toBe(true);
    expect(castable(ctx, '{W}{U}{1}')).toBe(false);
  });

  it('sceptre-of-eternal-glory-condition-is-yours — an opponent’s three Forests do not unlock it', () => {
    const { ctx } = ready('sceptre-theirs', [forest, forest]);
    for (let i = 0; i < 3; i++) spawn(ctx, 'P2', forest());
    expect(castable(ctx, '{B}{B}{B}')).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.22 Weathered Wayfarer
// ---------------------------------------------------------------------------------------------

describe('Weathered Wayfarer', () => {
  const wayfarer = pinned('Weathered Wayfarer');
  const SECRET_LAND = () =>
    oracle({ name: 'Wayfarer Secret Land', typeLine: 'Land', manaCost: null, oracleText: '' });

  /** P1 has the Wayfarer and `mine` lands; P2 has `theirs`; P3 has `third`. */
  function ready(seed: string, mine: number, theirs: number, third = 0) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', wayfarer.card);
    for (let i = 0; i < mine; i++) spawn(ctx, 'P1', plains()).tapped = true;
    for (let i = 0; i < theirs; i++) spawn(ctx, 'P2', forest());
    for (let i = 0; i < third; i++) spawn(ctx, 'P3', forest());
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }]);
    return { ctx, source };
  }

  it('weathered-wayfarer-pinned-oracle-supported — the interpreter reads the revealed search and its condition', () => {
    expect(wayfarer.sha256).toBe(
      '42ef11f806b155602ccdd9ce54d2cd2e123a4df1d42d90c83dcedad110cfaafd',
    );
    expect(wayfarer.card.oracleText).toBe(
      '{W}, {T}: Search your library for a land card, reveal it, put it into your hand, then shuffle. Activate only if an opponent controls more lands than you.',
    );
    expect(getOverride(wayfarer.card.oracleId)).toBeUndefined();
    expectModeled(wayfarer.card);
    const [ability] = interpretCard(wayfarer.card).activatedAbilities;
    expect(ability?.condition).toEqual({
      kind: 'opponentControlsMore',
      selector: { kind: 'type', value: 'Land' },
    });
    expect(ability?.ability.effects).toEqual([
      {
        op: 'searchLibrary',
        filter: { kind: 'type', value: 'Land' },
        destinations: [{ zone: 'hand' }],
        reveal: true,
      },
      { op: 'shuffle' },
    ]);
  });

  it('weathered-wayfarer-search-reveals-land — behind on lands, {W}, {T} reveals a land into hand', () => {
    const { ctx, source } = ready('wayfarer-search', 1, 2);
    const land = conjure(ctx, 'P1', SECRET_LAND(), 'library');
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Wayfarer Library Bear', typeLine: 'Creature — Bear' }),
      'library',
    );
    const option = activationsOf(ctx, 'P1', source)[0];
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand.map((card) => card.cardId)).toContain(land.cardId);
    expect(ctx.state.eventLog.find((event) => event.type === 'searchFound')?.payload).toMatchObject(
      {
        name: 'Wayfarer Secret Land',
        to: 'hand',
        revealed: true,
      },
    );
    expect(ctx.state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
    // Revealed (CR 701.16a): an opponent's view names the card that went to P1's hand.
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).toContain('Wayfarer Secret Land');
  });

  it('search-grammar-reveal-those-cards — Cultivate’s "reveal those cards" is public too', () => {
    const ctx = pod('cultivate-reveal');
    const cultivate = oracle({
      name: 'Cultivate',
      typeLine: 'Sorcery',
      manaCost: '{2}{G}',
      oracleText:
        'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
    });
    const effects = interpretCard(cultivate).spellAbility?.effects;
    expect(effects?.[0]).toMatchObject({ op: 'searchLibrary', reveal: true });
    const inHand = conjure(ctx, 'P1', cultivate, 'hand');
    conjure(ctx, 'P1', plains(), 'library');
    conjure(ctx, 'P1', island(), 'library');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }, ...generic(2)]);
    takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', inHand.id)!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const found = ctx.state.eventLog.filter((event) => event.type === 'searchFound');
    expect(found.length).toBe(2);
    for (const event of found) expect(event.payload).toMatchObject({ revealed: true });
    const handLand = playerById(ctx, 'P1').hand.find((card) => card.name !== 'Cultivate');
    expect(handLand).toBeDefined();
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).toContain(handLand!.name);
  });

  it('weathered-wayfarer-only-lands-match — the search offers every land and no nonland card', () => {
    const { ctx, source } = ready('wayfarer-only-lands', 1, 2);
    conjure(ctx, 'P1', SECRET_LAND(), 'library');
    conjure(ctx, 'P1', island(), 'library');
    conjure(
      ctx,
      'P1',
      oracle({ name: 'Wayfarer Library Bear', typeLine: 'Creature — Bear' }),
      'library',
    );
    takeAction(ctx, 'P1', activationsOf(ctx, 'P1', source)[0]!.payload as PriorityActionPayload);
    const { decisions } = resolveTop(ctx, answers([[/search your library/, /Put Island/]]));
    const search = decisions.find((decision) => /search your library/.test(decision.prompt));
    expect(search?.options.map((option) => option.description)).toEqual(
      expect.arrayContaining([
        'Put Wayfarer Secret Land into your hand',
        'Put Island into your hand',
      ]),
    );
    expect(search?.options.some((option) => /Wayfarer Library Bear/.test(option.description))).toBe(
      false,
    );
    expect(playerById(ctx, 'P1').hand.map((card) => card.name)).toEqual(['Island']);
  });

  it('weathered-wayfarer-equal-lands-blocked — with as many lands as every opponent, it cannot activate', () => {
    const { ctx, source } = ready('wayfarer-equal', 2, 2, 2);
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
  });

  it('weathered-wayfarer-single-opponent-not-pooled — two opponents with one land each do not outnumber two', () => {
    const { ctx, source } = ready('wayfarer-pooled', 2, 1, 1);
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
    spawn(ctx, 'P3', forest());
    spawn(ctx, 'P3', forest());
    expect(activationsOf(ctx, 'P1', source)).toHaveLength(1);
  });

  it('weathered-wayfarer-costs — it needs {W} and to be untapped', () => {
    const tapped = ready('wayfarer-tapped', 0, 1);
    tapped.source.tapped = true;
    expect(activationsOf(tapped.ctx, 'P1', tapped.source)).toEqual([]);
    const ctx = pod('wayfarer-no-mana');
    const source = spawn(ctx, 'P1', wayfarer.card);
    spawn(ctx, 'P2', forest());
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.01 Idol of Oblivion
// ---------------------------------------------------------------------------------------------

describe('Idol of Oblivion', () => {
  const idol = pinned('Idol of Oblivion');
  const DRAW = /\{T\}: Draw a card/;
  const ELDRAZI = /Create a 10\/10 colorless Eldrazi/;
  const TOKEN_MAKER = () =>
    oracle({
      name: 'Lab Token Maker',
      typeLine: 'Artifact',
      manaCost: '{1}',
      oracleText: '{1}: Create a 1/1 colorless Servo artifact creature token.',
    });

  function ready(seed: string, mana = 0) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', idol.card);
    if (mana > 0) addMana(playerById(ctx, 'P1'), generic(mana));
    return { ctx, source };
  }

  /** Create a token for `playerId` through a normal activated ability. */
  function makeToken(ctx: GameContext, playerId: string) {
    const maker = spawn(ctx, playerId, TOKEN_MAKER());
    addMana(playerById(ctx, playerId), generic(1));
    takeAction(
      ctx,
      playerId,
      activationsOf(ctx, playerId, maker)[0]!.payload as PriorityActionPayload,
    );
    resolveTop(ctx);
  }

  it('idol-of-oblivion-pinned-oracle-supported — the interpreter reads the conditional draw and the Eldrazi', () => {
    expect(idol.sha256).toBe('3baa23cd967df7e2c0549ab91ce4f57a51d53fd1282487e1236073936643962b');
    expect(idol.card.oracleText).toBe(
      '{T}: Draw a card. Activate only if you created a token this turn.\n{8}, {T}, Sacrifice this artifact: Create a 10/10 colorless Eldrazi creature token.',
    );
    expect(getOverride(idol.card.oracleId)).toBeUndefined();
    expectModeled(idol.card);
    const [draw, eldrazi] = interpretCard(idol.card).activatedAbilities;
    expect(draw?.condition).toEqual({ kind: 'createdTokenThisTurn' });
    expect(eldrazi?.condition).toBeUndefined();
  });

  it('idol-of-oblivion-draw-blocked-without-token — no token this turn, no draw', () => {
    const { ctx, source } = ready('idol-no-token');
    expect(activationMatching(ctx, 'P1', source, DRAW)).toBeUndefined();
  });

  it('idol-of-oblivion-draw-after-token — after you create a token, {T} draws a card', () => {
    const { ctx, source } = ready('idol-token');
    makeToken(ctx, 'P1');
    const before = playerById(ctx, 'P1').hand.length;
    const option = activationMatching(ctx, 'P1', source, DRAW);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(before + 1);
  });

  it('idol-of-oblivion-opponent-token-does-not-count — only tokens you created unlock it', () => {
    const { ctx, source } = ready('idol-their-token');
    makeToken(ctx, 'P2');
    expect(activationMatching(ctx, 'P1', source, DRAW)).toBeUndefined();
  });

  it('idol-of-oblivion-eldrazi — {8}, {T}, sacrifice it: a 10/10 colorless Eldrazi creature, not an artifact', () => {
    const { ctx, source } = ready('idol-eldrazi', 8);
    const option = activationMatching(ctx, 'P1', source, ELDRAZI);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.battlefield.some((perm) => perm.id === source.id)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toContain('Idol of Oblivion');
    resolveTop(ctx);
    const token = ctx.state.battlefield.find((perm) => perm.isToken && perm.name === 'Eldrazi');
    expect(token).toBeDefined();
    const chars = computeCharacteristics(ctx, token!);
    expect(chars.types).toEqual(['Creature']);
    expect(chars.subtypes).toEqual(['Eldrazi']);
    expect(chars.colors).toEqual([]);
    expect([chars.power, chars.toughness]).toEqual([10, 10]);
    // Creating the Eldrazi is itself a token this turn.
    expect(ctx.state.createdTokenThisTurn['P1']).toBe(true);
  });

  it('idol-of-oblivion-eldrazi-needs-eight — seven mana cannot pay it', () => {
    const { ctx, source } = ready('idol-eldrazi-short', 7);
    expect(activationMatching(ctx, 'P1', source, ELDRAZI)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// 2.17 Mistveil Plains
// ---------------------------------------------------------------------------------------------

describe('Mistveil Plains', () => {
  const mistveil = pinned('Mistveil Plains');
  const WHITE = (name: string) =>
    oracle({ name, typeLine: 'Creature — Soldier', manaCost: '{W}', colors: ['W'] });

  /** Mistveil Plains, an untapped Plains for {W}, `whites` white creatures, and a graveyard card. */
  function ready(seed: string, whites: number) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', mistveil.card);
    source.tapped = false;
    spawn(ctx, 'P1', plains());
    for (let i = 0; i < whites; i++) spawn(ctx, 'P1', WHITE(`Mistveil Soldier ${i}`));
    const buried = conjure(ctx, 'P1', SECRET_CARD('Mistveil Buried Card'), 'graveyard');
    conjure(ctx, 'P1', SECRET_CARD('Mistveil Library Top'), 'library');
    return { ctx, source, buried };
  }

  it('mistveil-plains-pinned-oracle-supported — the interpreter reads enters-tapped, {W}, and the bottom activation', () => {
    expect(mistveil.sha256).toBe(
      'ba245c46e7ecea52425fded3beb73f5bba3666af9f1c85e8234df1a5a3430791',
    );
    expect(mistveil.card.oracleText).toBe(
      '({T}: Add {W}.)\nThis land enters tapped.\n{W}, {T}: Put target card from your graveyard on the bottom of your library. Activate only if you control two or more white permanents.',
    );
    expect(getOverride(mistveil.card.oracleId)).toBeUndefined();
    expectModeled(mistveil.card);
    const def = interpretCard(mistveil.card);
    expect(def.entersTapped).toBe(true);
    expect(def.manaAbilities).toEqual([{ units: [['W']] }]);
    expect(def.activatedAbilities[0]?.ability.effects).toEqual([
      { op: 'graveyardToLibraryBottom', target: 0 },
    ]);
    expect(def.activatedAbilities[0]?.condition).toEqual({
      kind: 'countPermanents',
      selector: { kind: 'color', value: 'W' },
      scope: 'you',
      cmp: '>=',
      n: 2,
    });
  });

  it('mistveil-plains-enters-tapped — a normal land play puts it onto the battlefield tapped', () => {
    const ctx = pod('mistveil-land-play');
    const inHand = conjure(ctx, 'P1', mistveil.card, 'hand');
    const play = priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'playLand' && payload.objectId === inHand.id;
    });
    takeAction(ctx, 'P1', play!.payload as PriorityActionPayload);
    expect(ctx.state.battlefield.find((perm) => perm.cardId === inHand.cardId)?.tapped).toBe(true);
  });

  it('mistveil-plains-taps-for-white — {T}: Add {W} pays a white spell', () => {
    const ctx = pod('mistveil-white');
    spawn(ctx, 'P1', mistveil.card);
    const spell = conjure(ctx, 'P1', WHITE('Mistveil Bear'), 'hand');
    expect(castOptionFor(ctx, 'P1', spell.id)).toBeDefined();
  });

  it('mistveil-plains-bottom-of-library — with two white permanents, a graveyard card goes to the bottom', () => {
    const { ctx, source, buried } = ready('mistveil-bottom', 2);
    const option = activationsOf(ctx, 'P1', source)[0];
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, buried.id]]),
    );
    expect(source.tapped).toBe(true);
    resolveTop(ctx);
    const library = playerById(ctx, 'P1').library;
    expect(library.at(-1)?.cardId).toBe(buried.cardId);
    expect(library[0]?.name).toBe('Mistveil Library Top');
    expect(playerById(ctx, 'P1').graveyard).toEqual([]);
  });

  it('mistveil-plains-needs-two-white-permanents — one white permanent is not enough (the land is colorless)', () => {
    const { ctx, source } = ready('mistveil-one-white', 1);
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
    spawn(ctx, 'P1', WHITE('Mistveil Second Soldier'));
    expect(activationsOf(ctx, 'P1', source)).toHaveLength(1);
  });

  it('mistveil-plains-own-graveyard-only — an opponent’s graveyard card is not a legal target', () => {
    const { ctx, source } = ready('mistveil-theirs', 2);
    playerById(ctx, 'P1').graveyard = [];
    conjure(ctx, 'P2', SECRET_CARD('Mistveil Opponent Card'), 'graveyard');
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.05 Carrion Feeder
// ---------------------------------------------------------------------------------------------

describe('Carrion Feeder', () => {
  const feeder = pinned('Carrion Feeder');
  const victim = (name: string) =>
    oracle({ name, typeLine: 'Creature — Thrull', power: '1', toughness: '1' });

  it('carrion-feeder-pinned-oracle-supported — the interpreter reads can’t-block and the self-inclusive sacrifice', () => {
    expect(feeder.sha256).toBe('7fb3a771052de7acaa2d3eaebe9c39509ae68522bd344b4bd2491f77e6a3e069');
    expect(feeder.card.oracleText).toBe(
      "This creature can't block.\nSacrifice a creature: Put a +1/+1 counter on this creature.",
    );
    expect(getOverride(feeder.card.oracleId)).toBeUndefined();
    expectModeled(feeder.card);
    const def = interpretCard(feeder.card);
    expect(def.cantBlock).toBe(true);
    expect(def.activatedAbilities[0]?.costs).toEqual([
      {
        kind: 'sacrificeOther',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'controller', who: 'you' },
            { kind: 'type', value: 'Creature' },
          ],
        },
        allowSelf: true,
      },
    ]);
  });

  it('carrion-feeder-cant-block — it is never offered as a blocker; another creature is', () => {
    const ctx = pod('feeder-cant-block');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const self = spawn(ctx, 'P1', feeder.card);
    const wall = spawn(ctx, 'P1', victim('Feeder Wall'));
    const attacker = spawn(ctx, 'P2', victim('Feeder Attacker'));
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    const asked: string[][] = [];
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) {
        return declareAttacks(decision, (subjectId) => (subjectId === attacker.id ? 'P1' : null));
      }
      if (decision.presentationBlockDeclaration !== undefined) {
        asked.push(decision.presentationBlockDeclaration.subjects.map((subject) => subject.name));
        return { index: 0, targets: new Map() };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(asked.flat()).toContain(wall.name);
    expect(asked.flat()).not.toContain(self.name);
  });

  it('carrion-feeder-sacrifices-another — sacrificing another creature puts a counter on it', () => {
    const ctx = pod('feeder-another');
    const self = spawn(ctx, 'P1', feeder.card);
    const fodder = spawn(ctx, 'P1', victim('Feeder Fodder'));
    const option = activationsOf(ctx, 'P1', self)[0];
    expect(option).toBeDefined();
    const { decisions } = takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      answers([[/sacrifice/i, /Feeder Fodder/]]),
    );
    expect(decisions.some((decision) => /sacrifice/i.test(decision.prompt))).toBe(true);
    expect(ctx.state.battlefield.some((perm) => perm.id === fodder.id)).toBe(false);
    resolveTop(ctx);
    expect(self.counters['+1/+1']).toBe(1);
  });

  it('carrion-feeder-sacrifices-itself — alone, it may sacrifice itself to pay the cost', () => {
    const ctx = pod('feeder-self');
    const self = spawn(ctx, 'P1', feeder.card);
    const option = activationsOf(ctx, 'P1', self)[0];
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.battlefield.some((perm) => perm.id === self.id)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toContain('Carrion Feeder');
    resolveTop(ctx);
    expect(ctx.state.stack).toEqual([]);
  });

  it('carrion-feeder-only-your-creatures — an opponent’s creature is never offered as the sacrifice', () => {
    const ctx = pod('feeder-theirs');
    const self = spawn(ctx, 'P1', feeder.card);
    spawn(ctx, 'P2', victim('Feeder Opponent Creature'));
    const option = activationsOf(ctx, 'P1', self)[0];
    const { decisions } = takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    for (const decision of decisions) {
      expect(
        decision.options.some((choice) => /Feeder Opponent Creature/.test(choice.description)),
      ).toBe(false);
    }
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Feeder Opponent Creature')).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// 2.18 Nullmage Shepherd
// ---------------------------------------------------------------------------------------------

describe('Nullmage Shepherd', () => {
  const shepherd = pinned('Nullmage Shepherd');
  const elf = (name: string) =>
    oracle({ name, typeLine: 'Creature — Elf', power: '1', toughness: '1' });
  const relic = () => oracle({ name: 'Nullmage Relic', typeLine: 'Artifact', manaCost: '{1}' });

  /** Nullmage Shepherd (summoning sick), `others` other untapped creatures, and P2's artifact. */
  function ready(seed: string, others: number) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', shepherd.card);
    source.summoningSick = true;
    const helpers = Array.from({ length: others }, (_, i) =>
      spawn(ctx, 'P1', elf(`Nullmage Elf ${i}`)),
    );
    const target = spawn(ctx, 'P2', relic());
    return { ctx, source, helpers, target };
  }

  it('nullmage-shepherd-pinned-oracle-supported — the interpreter reads tap-four with allowSelf', () => {
    expect(shepherd.sha256).toBe(
      '9778d0c0a47ec527656f5c9551f1708cfbf65ce71b0636143efe86c288b3ba1a',
    );
    expect(shepherd.card.oracleText).toBe(
      'Tap four untapped creatures you control: Destroy target artifact or enchantment.',
    );
    expect(getOverride(shepherd.card.oracleId)).toBeUndefined();
    expectModeled(shepherd.card);
    expect(interpretCard(shepherd.card).activatedAbilities[0]?.costs).toEqual([
      {
        kind: 'tapOthers',
        selector: {
          kind: 'allOf',
          of: [
            { kind: 'type', value: 'Creature' },
            { kind: 'controller', who: 'you' },
          ],
        },
        count: 4,
        allowSelf: true,
      },
    ]);
  });

  it('tap-cost-self-allowed-only-without-tap-symbol — a {T} in the same cost keeps the source out', () => {
    const tapFour = {
      kind: 'tapOthers' as const,
      selector: ofType('Creature'),
      count: 4,
      allowSelf: true,
    };
    expect(selfMayTap(tapFour, [tapFour])).toBe(true);
    expect(selfMayTap(tapFour, [{ kind: 'tap' }, tapFour])).toBe(false);
    expect(selfMayTap({ ...tapFour, allowSelf: false }, [tapFour])).toBe(false);
  });

  it('nullmage-shepherd-taps-itself-and-three-others — a summoning-sick Shepherd counts toward the four', () => {
    const { ctx, source, helpers, target } = ready('nullmage-four', 3);
    const option = activationsOf(ctx, 'P1', source)[0];
    expect(option).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, target.id]]),
    );
    expect(source.tapped).toBe(true);
    for (const helper of helpers) expect(helper.tapped).toBe(true);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.id === target.id)).toBe(false);
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toContain('Nullmage Relic');
  });

  it('nullmage-shepherd-chooses-four-of-five — with five creatures the controller picks which four tap', () => {
    const { ctx, source, helpers, target } = ready('nullmage-five', 4);
    const option = activationsOf(ctx, 'P1', source)[0];
    const { decisions } = takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      answers([[/to tap as an activation cost/, /Nullmage Elf/]]),
      new Map([[0, target.id]]),
    );
    const taps = decisions.filter((decision) =>
      /to tap as an activation cost/.test(decision.prompt),
    );
    expect(taps).toHaveLength(4);
    expect(taps[0]?.options.map((choice) => choice.description)).toContain('Tap Nullmage Shepherd');
    expect(helpers.every((helper) => helper.tapped)).toBe(true);
    expect(source.tapped).toBe(false);
  });

  it('nullmage-shepherd-needs-four-untapped — three creatures, or a tapped fourth, cannot pay', () => {
    const three = ready('nullmage-three', 2);
    expect(activationsOf(three.ctx, 'P1', three.source)).toEqual([]);
    const tapped = ready('nullmage-tapped', 3);
    tapped.helpers[0]!.tapped = true;
    expect(activationsOf(tapped.ctx, 'P1', tapped.source)).toEqual([]);
  });

  it('nullmage-shepherd-only-your-creatures — opponents’ creatures never help pay', () => {
    const { ctx, source } = ready('nullmage-theirs', 2);
    spawn(ctx, 'P2', elf('Nullmage Opponent Elf'));
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
  });

  it('nullmage-shepherd-artifact-or-enchantment — it destroys an enchantment too; creatures are not targets', () => {
    expect(interpretCard(shepherd.card).activatedAbilities[0]?.ability.targets).toEqual([
      { kind: 'artifactOrEnchantment' },
    ]);
    const { ctx, source } = ready('nullmage-enchantment', 3);
    const aura = spawn(ctx, 'P2', oracle({ name: 'Nullmage Hex', typeLine: 'Enchantment' }));
    const option = activationsOf(ctx, 'P1', source)[0];
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, aura.id]]),
    );
    resolveTop(ctx);
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toContain('Nullmage Hex');
  });

  it('nullmage-shepherd-tap-and-tap-other — a source that also pays {T} can never be one of the creatures it taps', () => {
    // CR 302.6 lets a creature tap itself for "tap an untapped creature you control" only when
    // the same ability does not already cost {T} (Selesnya Evangel, Jaspera Sentinel).
    const evangel = oracle({
      name: 'Tap Test Evangel',
      typeLine: 'Creature — Elf',
      oracleText:
        '{1}, {T}, Tap an untapped creature you control: Create a 1/1 green Saproling creature token.',
    });
    const ctx = pod('tap-and-tap-other');
    const source = spawn(ctx, 'P1', evangel);
    addMana(playerById(ctx, 'P1'), generic(1));
    expect(activationMatching(ctx, 'P1', source, /Saproling/)).toBeUndefined();
    const helper = spawn(
      ctx,
      'P1',
      oracle({ name: 'Tap Test Helper', typeLine: 'Creature — Elf' }),
    );
    const option = activationMatching(ctx, 'P1', source, /Saproling/);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    expect(helper.tapped).toBe(true);
  });

  it('nullmage-shepherd-tap-then-sacrifice-same — one creature may be tapped for one cost and sacrificed for another', () => {
    const altar = oracle({
      name: 'Tap Sac Altar',
      typeLine: 'Artifact',
      oracleText: 'Tap an untapped creature you control, Sacrifice a creature: Draw a card.',
      power: null,
      toughness: null,
    });
    const ctx = pod('tap-then-sacrifice');
    const source = spawn(ctx, 'P1', altar);
    const lone = spawn(ctx, 'P1', oracle({ name: 'Tap Sac Bear', typeLine: 'Creature — Bear' }));
    const option = activationMatching(ctx, 'P1', source, /Draw a card/);
    expect(option).toBeDefined();
    const before = playerById(ctx, 'P1').hand.length;
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.battlefield.some((perm) => perm.id === lone.id)).toBe(false);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(before + 1);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.20 Sage of Fables
// ---------------------------------------------------------------------------------------------

describe('Sage of Fables', () => {
  const sage = pinned('Sage of Fables');
  const wizard = (name: string) =>
    oracle({
      name,
      typeLine: 'Creature — Human Wizard',
      manaCost: '{1}',
      power: '1',
      toughness: '1',
    });
  const ogre = (name: string) =>
    oracle({ name, typeLine: 'Creature — Ogre', manaCost: '{1}', power: '3', toughness: '3' });

  it('sage-of-fables-pinned-oracle-supported — the interpreter reads the Wizard counters and the from-among cost', () => {
    expect(sage.sha256).toBe('1423e05e7e7fc5bf74c33c20c1f368ebd1f4224c9c5112df484d654181aeb382');
    expect(sage.card.oracleText).toBe(
      'Each other Wizard creature you control enters with an additional +1/+1 counter on it.\n{2}, Remove a +1/+1 counter from a creature you control: Draw a card.',
    );
    expect(getOverride(sage.card.oracleId)).toBeUndefined();
    expectModeled(sage.card);
    const def = interpretCard(sage.card);
    expect(def.activatedAbilities[0]?.costs[1]).toEqual({
      kind: 'removeCountersFromAmong',
      counter: '+1/+1',
      count: 1,
      selector: {
        kind: 'allOf',
        of: [
          { kind: 'controller', who: 'you' },
          { kind: 'type', value: 'Creature' },
        ],
      },
    });
  });

  it('sage-of-fables-wizard-enters-with-counter — another Wizard you cast enters with a +1/+1 counter; a non-Wizard does not', () => {
    const ctx = pod('sage-wizard');
    spawn(ctx, 'P1', sage.card);
    addMana(playerById(ctx, 'P1'), generic(2));
    const apprentice = conjure(ctx, 'P1', wizard('Sage Apprentice'), 'hand');
    takeAction(
      ctx,
      'P1',
      castOptionFor(ctx, 'P1', apprentice.id)!.payload as PriorityActionPayload,
    );
    settle(ctx);
    const brute = conjure(ctx, 'P1', ogre('Sage Brute'), 'hand');
    takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', brute.id)!.payload as PriorityActionPayload);
    settle(ctx);
    const onField = (name: string) => ctx.state.battlefield.find((perm) => perm.name === name);
    expect(onField('Sage Apprentice')?.counters['+1/+1']).toBe(1);
    expect(onField('Sage Brute')?.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('sage-of-fables-not-itself-or-opponents — the Sage gets no counter, nor does an opponent’s Wizard', () => {
    const ctx = pod('sage-other');
    const self = spawn(ctx, 'P1', sage.card);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'U' }, ...generic(2)]);
    const inHand = conjure(ctx, 'P1', sage.card, 'hand');
    takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', inHand.id)!.payload as PriorityActionPayload);
    settle(ctx);
    // The second Sage is another Wizard, so the first Sage gives it a counter; neither gets one
    // from itself.
    const second = ctx.state.battlefield.find((perm) => perm.cardId === inHand.cardId);
    expect(second?.counters['+1/+1']).toBe(1);
    expect(self.counters['+1/+1'] ?? 0).toBe(0);
    const theirs = enterFor(ctx, 'P2', wizard('Sage Rival Wizard'));
    expect(theirs?.counters['+1/+1'] ?? 0).toBe(0);
  });

  it('sage-of-fables-draw-removing-another-creatures-counter — {2} and a counter from any creature you control draws', () => {
    const ctx = pod('sage-draw');
    const self = spawn(ctx, 'P1', sage.card);
    const brute = spawn(ctx, 'P1', ogre('Sage Brute'));
    brute.counters['+1/+1'] = 2;
    self.counters['+1/+1'] = 1;
    addMana(playerById(ctx, 'P1'), generic(2));
    const before = playerById(ctx, 'P1').hand.length;
    const option = activationsOf(ctx, 'P1', self)[0];
    expect(option).toBeDefined();
    const { decisions } = takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      answers([[/to remove a \+1\/\+1 counter from/, /Remove from Sage Brute/]]),
    );
    const choice = decisions.find((decision) =>
      /to remove a \+1\/\+1 counter from/.test(decision.prompt),
    );
    expect(choice?.options.map((option) => option.description)).toEqual([
      'Remove from Sage of Fables',
      'Remove from Sage Brute',
    ]);
    expect(brute.counters['+1/+1']).toBe(1);
    expect(self.counters['+1/+1']).toBe(1);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(before + 1);
  });

  it('sage-of-fables-draw-from-itself — the Sage may pay with its own counter', () => {
    const ctx = pod('sage-self');
    const self = spawn(ctx, 'P1', sage.card);
    self.counters['+1/+1'] = 1;
    addMana(playerById(ctx, 'P1'), generic(2));
    takeAction(ctx, 'P1', activationsOf(ctx, 'P1', self)[0]!.payload as PriorityActionPayload);
    expect(self.counters['+1/+1']).toBe(0);
  });

  it('sage-of-fables-needs-a-counter-you-control — no counter, or only an opponent’s, offers nothing', () => {
    const ctx = pod('sage-none');
    const self = spawn(ctx, 'P1', sage.card);
    addMana(playerById(ctx, 'P1'), generic(2));
    expect(activationsOf(ctx, 'P1', self)).toEqual([]);
    const theirs = spawn(ctx, 'P2', ogre('Sage Rival Ogre'));
    theirs.counters['+1/+1'] = 3;
    expect(activationsOf(ctx, 'P1', self)).toEqual([]);
    const mine = spawn(ctx, 'P1', ogre('Sage Brute'));
    mine.counters['+1/+1'] = 1;
    expect(activationsOf(ctx, 'P1', self)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.15 Illuminor Szeras
// ---------------------------------------------------------------------------------------------

describe('Illuminor Szeras', () => {
  const szeras = pinned('Illuminor Szeras');
  const creature = (name: string, manaCost: string, cmc: number) =>
    oracle({ name, typeLine: 'Creature — Construct', manaCost, cmc, power: '1', toughness: '1' });
  const blackSpell = (manaCost: string) =>
    oracle({ name: `Szeras Spell ${manaCost}`, typeLine: 'Creature — Zombie', manaCost });

  function ready(seed: string) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', szeras.card);
    return { ctx, source };
  }

  const szerasSources = (ctx: GameContext, source: EnginePermanent) =>
    manaSourcesFor(ctx, 'P1').filter((entry) => entry.cardId === source.cardId);

  it('illuminor-szeras-pinned-oracle-supported — a {T}+sacrifice mana ability sized by mana value', () => {
    expect(szeras.sha256).toBe('7b83ca63d63f5b6abb39060bab1bc0dd086714872059ed3c0db58a8edb205486');
    expect(szeras.card.oracleText).toBe(
      "Secrets of the Soul — {T}, Sacrifice another creature: Add an amount of {B} equal to the sacrificed creature's mana value.",
    );
    expectModeled(szeras.card);
    const def = interpretCard(szeras.card);
    expect(def.activatedAbilities).toEqual([]);
    expect(def.manaAbilities).toEqual([
      {
        units: [['B']],
        costs: [
          { kind: 'tap' },
          {
            kind: 'sacrificeOther',
            selector: {
              kind: 'allOf',
              of: [
                { kind: 'type', value: 'Creature' },
                { kind: 'controller', who: 'you' },
              ],
            },
          },
        ],
        amountFromSacrificedManaValue: true,
      },
    ]);
  });

  it('illuminor-szeras-one-source-per-candidate — each other creature offers its mana value in {B}', () => {
    const { ctx, source } = ready('szeras-sources');
    const three = spawn(ctx, 'P1', creature('Szeras Three', '{2}{B}', 3));
    const one = spawn(ctx, 'P1', creature('Szeras One', '{1}', 1));
    const token = spawn(ctx, 'P1', creature('Szeras Token', '', 0));
    token.isToken = true;
    const offered = szerasSources(ctx, source);
    expect(offered.map((entry) => [entry.units.length, entry.sacrifices])).toEqual([
      [3, [[three.cardId]]],
      [1, [[one.cardId]]],
    ]);
    for (const entry of offered)
      expect(entry.units.every((unit) => unit.join() === 'B')).toBe(true);
  });

  it('illuminor-szeras-pays-black-by-sacrificing — {B}{B}{B} is paid by sacrificing a 3-mana-value creature', () => {
    const { ctx, source } = ready('szeras-pay');
    const fodder = spawn(ctx, 'P1', creature('Szeras Three', '{2}{B}', 3));
    const spell = conjure(ctx, 'P1', blackSpell('{B}{B}{B}'), 'hand');
    const cast = castOptionFor(ctx, 'P1', spell.id);
    expect(cast).toBeDefined();
    takeAction(ctx, 'P1', cast!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(true);
    expect(ctx.state.battlefield.some((perm) => perm.id === fodder.id)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toContain('Szeras Three');
    expect(ctx.state.stack).toHaveLength(1);
  });

  it('illuminor-szeras-too-small-a-sacrifice — a 1-mana-value creature cannot pay {B}{B}', () => {
    const { ctx } = ready('szeras-small');
    spawn(ctx, 'P1', creature('Szeras One', '{1}', 1));
    const spell = conjure(ctx, 'P1', blackSpell('{B}{B}'), 'hand');
    expect(castOptionFor(ctx, 'P1', spell.id)).toBeUndefined();
  });

  it('illuminor-szeras-another-creature-only — alone, it cannot sacrifice itself', () => {
    const { ctx, source } = ready('szeras-alone');
    expect(szerasSources(ctx, source)).toEqual([]);
    spawn(ctx, 'P2', creature('Szeras Rival', '{4}', 4));
    expect(szerasSources(ctx, source)).toEqual([]);
  });

  it('illuminor-szeras-summoning-sick — its {T} mana ability is unavailable the turn it arrives', () => {
    const { ctx, source } = ready('szeras-sick');
    source.summoningSick = true;
    spawn(ctx, 'P1', creature('Szeras Three', '{2}{B}', 3));
    expect(szerasSources(ctx, source)).toEqual([]);
  });

  it('illuminor-szeras-lands-first — a spell lands can pay never sacrifices a creature', () => {
    const { ctx, source } = ready('szeras-lands-first');
    const fodder = spawn(ctx, 'P1', creature('Szeras Three', '{2}{B}', 3));
    spawn(ctx, 'P1', oracle({ name: 'Swamp', typeLine: 'Basic Land — Swamp', manaCost: null }));
    const spell = conjure(ctx, 'P1', blackSpell('{B}'), 'hand');
    takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', spell.id)!.payload as PriorityActionPayload);
    expect(source.tapped).toBe(false);
    expect(ctx.state.battlefield.some((perm) => perm.id === fodder.id)).toBe(true);
  });

  it('illuminor-szeras-keeps-sacrifice-fodder — its mana never takes what the ability being paid must sacrifice', () => {
    const altarCard = oracle({
      name: 'Szeras Construct Altar',
      typeLine: 'Artifact',
      manaCost: '{2}',
      oracleText: '{1}, Sacrifice a Construct: You gain 1 life.',
      power: null,
      toughness: null,
    });
    // Only one Construct: Szeras sacrificing it for {B} would leave nothing to sacrifice.
    const lone = ready('szeras-reserve-lone');
    spawn(lone.ctx, 'P1', creature('Szeras Lone Construct', '{1}', 1));
    const loneAltar = spawn(lone.ctx, 'P1', altarCard);
    expect(activationMatching(lone.ctx, 'P1', loneAltar, /gain 1 life/)).toBeUndefined();

    // A second, non-Construct creature pays the {1}; the Construct is kept for the sacrifice.
    const { ctx } = ready('szeras-reserve-pair');
    const construct = spawn(ctx, 'P1', creature('Szeras Kept Construct', '{1}', 1));
    const ox = spawn(
      ctx,
      'P1',
      oracle({ name: 'Szeras Fodder Ox', typeLine: 'Creature — Ox', manaCost: '{1}', cmc: 1 }),
    );
    const altar = spawn(ctx, 'P1', altarCard);
    const option = activationMatching(ctx, 'P1', altar, /gain 1 life/);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    const graveyard = playerById(ctx, 'P1').graveyard.map((card) => card.cardId);
    expect(graveyard).toEqual(expect.arrayContaining([construct.cardId, ox.cardId]));
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').life).toBe(41);
  });

  it('illuminor-szeras-view-mana — the player view credits its largest sacrifice, not their sum', () => {
    const { ctx } = ready('szeras-view-mana');
    spawn(ctx, 'P1', creature('Szeras View Three', '{3}', 3));
    spawn(ctx, 'P1', creature('Szeras View Two', '{2}', 2));
    spawn(ctx, 'P1', creature('Szeras View One', '{1}', 1));
    const view = buildPlayerView(ctx, 'P1');
    // One activation sacrifices one creature: at most {B}{B}{B}, not 3 + 2 + 1.
    expect(view.availableMana['B']).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.28 Peema Trailblazer
// ---------------------------------------------------------------------------------------------

describe('Peema Trailblazer', () => {
  const peema = pinned('Peema Trailblazer');
  const big = (power: string) =>
    oracle({ name: `Peema Giant ${power}`, typeLine: 'Creature — Giant', power, toughness: power });

  function ready(seed: string, energy: number) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', peema.card);
    playerById(ctx, 'P1').energy = energy;
    for (let i = 0; i < 8; i++) conjure(ctx, 'P1', SECRET_CARD(`Peema Library ${i}`), 'library');
    return { ctx, source };
  }

  it('peema-trailblazer-pinned-oracle-supported — the exhaust ability costs only six energy', () => {
    expect(peema.sha256).toBe('ac39b4f00910602a5d4f2038f9ed5a9c13f09de367d4c89bc66eaa8efc823f51');
    expect(peema.card.oracleText).toBe(
      'Trample\nWhenever this creature deals combat damage to a player, you get that many {E} (energy counters).\nExhaust — Pay six {E}: Put two +1/+1 counters on this creature. Then draw cards equal to the greatest power among creatures you control. (Activate each exhaust ability only once.)',
    );
    expectModeled(peema.card);
    const [exhaust] = interpretCard(peema.card).activatedAbilities;
    expect(exhaust?.costs).toEqual([{ kind: 'payEnergy', amount: 6 }]);
    expect(exhaust?.exhaust).toBe(true);
    expect(interpretCard(peema.card).keywords).toContain('trample');
  });

  it('peema-trailblazer-combat-damage-energy — combat damage to a player gives that much energy', () => {
    const ctx = pod('peema-combat');
    const self = spawn(ctx, 'P1', peema.card);
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) {
        return declareAttacks(decision, (subjectId) => (subjectId === self.id ? 'P2' : null));
      }
      if (decision.presentationBlockDeclaration !== undefined) {
        return { index: 0, targets: new Map() };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(playerById(ctx, 'P2').life).toBe(37);
    expect(playerById(ctx, 'P1').energy).toBe(3);
  });

  it('peema-trailblazer-trample-excess-energy — blocked by a 1/1, 2 damage tramples over and gives 2 energy', () => {
    const ctx = pod('peema-trample');
    const self = spawn(ctx, 'P1', peema.card);
    const blocker = spawn(
      ctx,
      'P2',
      oracle({ name: 'Peema Blocker', typeLine: 'Creature — Thrull', power: '1', toughness: '1' }),
    );
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) {
        return declareAttacks(decision, (subjectId) => (subjectId === self.id ? 'P2' : null));
      }
      if (decision.presentationBlockDeclaration !== undefined) {
        return declareBlocks(decision, (subjectId) => (subjectId === blocker.id ? self.id : null));
      }
      if (decision.decisionType === 'assignCombatDamage') {
        return { index: 0, targets: new Map(), combatDamageSplit: { [blocker.id]: 1, P2: 2 } };
      }
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toContain('Peema Blocker');
    expect(playerById(ctx, 'P2').life).toBe(38);
    expect(playerById(ctx, 'P1').energy).toBe(2);
  });

  it('peema-trailblazer-exhaust-counters-then-draw — two counters, then draws the greatest power (after the counters)', () => {
    const { ctx, source } = ready('peema-exhaust', 6);
    // Untapped and summoning sick: exhaust has no {T}, so neither matters.
    source.summoningSick = true;
    source.tapped = true;
    const before = playerById(ctx, 'P1').hand.length;
    const option = activationsOf(ctx, 'P1', source)[0];
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').energy).toBe(0);
    resolveTop(ctx);
    expect(source.counters['+1/+1']).toBe(2);
    expect(playerById(ctx, 'P1').hand).toHaveLength(before + 5);
  });

  it('peema-trailblazer-exhaust-greatest-power-among-yours — a bigger creature you control sets the draw', () => {
    const { ctx, source } = ready('peema-greatest', 6);
    spawn(ctx, 'P1', big('7'));
    spawn(ctx, 'P2', big('9'));
    const before = playerById(ctx, 'P1').hand.length;
    takeAction(ctx, 'P1', activationsOf(ctx, 'P1', source)[0]!.payload as PriorityActionPayload);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(before + 7);
  });

  it('peema-trailblazer-exhaust-needs-six — five energy cannot pay it', () => {
    const { ctx, source } = ready('peema-short', 5);
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
  });

  it('peema-trailblazer-exhaust-only-once — never again for this object, even on a later turn', () => {
    const { ctx, source } = ready('peema-once', 12);
    takeAction(ctx, 'P1', activationsOf(ctx, 'P1', source)[0]!.payload as PriorityActionPayload);
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
    resolveTop(ctx);
    source.activationsThisTurn = [];
    expect(playerById(ctx, 'P1').energy).toBe(6);
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
  });

  it('peema-trailblazer-new-object-may-exhaust — after leaving and returning it is a new object', () => {
    const { ctx, source } = ready('peema-blink', 12);
    takeAction(ctx, 'P1', activationsOf(ctx, 'P1', source)[0]!.payload as PriorityActionPayload);
    resolveTop(ctx);
    // Exile it and return it through the real zone changes: a new object (CR 400.7).
    pump(moveObject(ctx, source, { zone: 'exile' }));
    const exiled = ctx.state.exile.find((card) => card.name === 'Peema Trailblazer')!;
    pump(moveObject(ctx, exiled, { zone: 'battlefield', controllerId: 'P1' }));
    const returned = ctx.state.battlefield.find((perm) => perm.name === 'Peema Trailblazer');
    expect(returned).toBeDefined();
    expect(returned!.exhaustedAbilities ?? []).toEqual([]);
    expect(activationsOf(ctx, 'P1', returned!)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.30 Soul-Guide Lantern
// ---------------------------------------------------------------------------------------------

describe('Soul-Guide Lantern', () => {
  const lantern = pinned('Soul-Guide Lantern');
  const EXILE_GRAVEYARDS = /Exile each opponent's graveyard/;
  const DRAW = /Draw a card/;

  function withGraveyards(seed: string) {
    const ctx = pod(seed);
    const mine = conjure(ctx, 'P1', SECRET_CARD('Lantern Own Card'), 'graveyard');
    const theirs = conjure(ctx, 'P2', SECRET_CARD('Lantern P2 Card'), 'graveyard');
    const third = conjure(ctx, 'P3', SECRET_CARD('Lantern P3 Card'), 'graveyard');
    return { ctx, mine, theirs, third };
  }

  it('soul-guide-lantern-pinned-oracle-supported — appends the trigger and the exile ability to the parsed draw', () => {
    expect(lantern.sha256).toBe('93d00eeabc06f7b9cfb8d6d1ca01b8a6cce4ba7b83905a680d591c3aa5fb93ec');
    expect(lantern.card.oracleText).toBe(
      "When this artifact enters, exile target card from a graveyard.\n{T}, Sacrifice this artifact: Exile each opponent's graveyard.\n{1}, {T}, Sacrifice this artifact: Draw a card.",
    );
    expectModeled(lantern.card);
    expect(getOverride(lantern.card.oracleId)?.compose).toBe('append');
    const def = interpretCard(lantern.card);
    expect(def.activatedAbilities.map((entry) => entry.costs.map((cost) => cost.kind))).toEqual([
      ['mana', 'tap', 'sacrificeSelf'],
      ['tap', 'sacrificeSelf'],
    ]);
    expect(def.triggers[0]?.targets).toEqual([
      { kind: 'cardInGraveyard', graveyardOwnerScope: 'any' },
    ]);
  });

  it('soul-guide-lantern-enters-exiles-any-graveyard-card — cast normally, its trigger exiles an opponent’s card', () => {
    const { ctx, theirs, mine } = withGraveyards('lantern-enters');
    const inHand = conjure(ctx, 'P1', lantern.card, 'hand');
    addMana(playerById(ctx, 'P1'), generic(1));
    takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', inHand.id)!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const offered: string[][] = [];
    settle(ctx, (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot === undefined) return { index: 0, targets: new Map() };
      offered.push([...slot.options]);
      return { index: 0, targets: new Map([[slot.slot, theirs.id]]) };
    });
    // Any graveyard: yours and every opponent's cards are legal targets.
    expect(offered[0]).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.cardId)).not.toContain(theirs.cardId);
    expect(ctx.state.exile.map((card) => card.name)).toContain('Lantern P2 Card');
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.cardId)).toContain(mine.cardId);
  });

  it('soul-guide-lantern-exile-opponents-graveyards — {T}, sacrifice: every opponent’s graveyard, not yours', () => {
    const { ctx, mine } = withGraveyards('lantern-exile-all');
    const source = spawn(ctx, 'P1', lantern.card);
    const option = activationMatching(ctx, 'P1', source, EXILE_GRAVEYARDS);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(ctx.state.battlefield.some((perm) => perm.id === source.id)).toBe(false);
    resolveTop(ctx);
    expect(playerById(ctx, 'P2').graveyard).toEqual([]);
    expect(playerById(ctx, 'P3').graveyard).toEqual([]);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.cardId)).toContain(mine.cardId);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toContain(
      'Soul-Guide Lantern',
    );
  });

  it('soul-guide-lantern-exile-costs-no-mana — the exile ability needs no mana; the draw needs {1}', () => {
    const { ctx } = withGraveyards('lantern-costs');
    const source = spawn(ctx, 'P1', lantern.card);
    expect(activationMatching(ctx, 'P1', source, EXILE_GRAVEYARDS)).toBeDefined();
    expect(activationMatching(ctx, 'P1', source, DRAW)).toBeUndefined();
    source.tapped = true;
    expect(activationsOf(ctx, 'P1', source)).toEqual([]);
  });

  it('soul-guide-lantern-draw — {1}, {T}, sacrifice it: draw a card, and the graveyards stay', () => {
    const { ctx } = withGraveyards('lantern-draw');
    const source = spawn(ctx, 'P1', lantern.card);
    addMana(playerById(ctx, 'P1'), generic(1));
    const before = playerById(ctx, 'P1').hand.length;
    takeAction(
      ctx,
      'P1',
      activationMatching(ctx, 'P1', source, DRAW)!.payload as PriorityActionPayload,
    );
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(before + 1);
    expect(playerById(ctx, 'P2').graveyard).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// 2.12 Ghost Ark
// ---------------------------------------------------------------------------------------------

describe('Ghost Ark', () => {
  const ark = pinned('Ghost Ark');
  const CREW = /Crew 2/;
  const UNEARTH = /\(graveyard\): Unearth \{3\}$/;

  const thopter = (name: string) =>
    oracle({
      name,
      typeLine: 'Artifact Creature — Thopter',
      manaCost: '{2}',
      power: '2',
      toughness: '2',
    });

  /** Ghost Ark, a 2-power crew member, and graveyards holding each kind of card. */
  function arkWithGraveyard(seed: string) {
    const ctx = pod(seed);
    const source = spawn(ctx, 'P1', ark.card);
    const crew = spawn(
      ctx,
      'P1',
      oracle({ name: 'Ark Deckhand', typeLine: 'Creature — Human', power: '2', toughness: '2' }),
    );
    const robot = conjure(ctx, 'P1', thopter('Ark Thopter'), 'graveyard');
    const beast = conjure(ctx, 'P1', SECRET_CARD('Ark Plain Creature'), 'graveyard');
    const relic = conjure(
      ctx,
      'P1',
      oracle({ name: 'Ark Relic', typeLine: 'Artifact', manaCost: '{1}' }),
      'graveyard',
    );
    const theirs = conjure(ctx, 'P2', thopter('Ark Rival Thopter'), 'graveyard');
    return { ctx, source, crew, robot, beast, relic, theirs };
  }

  /** The unearth activation offered for the graveyard card named `name`, if any. */
  function unearthFor(ctx: GameContext, playerId: string, name: string) {
    return priorityOptions(ctx, playerId).find(
      (option) =>
        option.description.startsWith(`${name} (graveyard)`) && UNEARTH.test(option.description),
    );
  }

  /** Crew the Ark through the normal activation path and resolve the crew ability. */
  function crewArk(ctx: GameContext, source: EnginePermanent) {
    const option = activationMatching(ctx, 'P1', source, CREW);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
  }

  it('ghost-ark-pinned-oracle-supported — the interpreter reads flying, the crewed trigger and Crew 2', () => {
    expect(ark.sha256).toBe('bd5d0a53132a9b86c3ced3f9f31a6856b362023b2b014b354c27ffdf92d12ffc');
    expect(ark.card.oracleText).toBe(
      'Flying\nRepair Barge — Whenever this Vehicle becomes crewed, each artifact creature card in your graveyard gains unearth {3} until end of turn.\nCrew 2 (Tap any number of creatures you control with total power 2 or more: This Vehicle becomes an artifact creature until end of turn.)',
    );
    expectModeled(ark.card);
    expect(getOverride(ark.card.oracleId)).toBeUndefined();
    const def = interpretCard(ark.card);
    expect(def.keywords).toContain('flying');
    expect(def.triggers.map((trigger) => trigger.trigger)).toEqual([
      { when: 'becomesCrewed', subject: { kind: 'self' } },
    ]);
    expect(def.triggers[0]?.effects).toEqual([
      {
        op: 'grantUnearthToArtifactCreaturesInGraveyard',
        cost: { generic: 3, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
      },
    ]);
    expect(def.activatedAbilities.map((entry) => entry.ability.effects)).toEqual([
      [{ op: 'crewVehicle', minPower: 2 }],
    ]);
  });

  it('ghost-ark-flying — the crewed Ark is a 3/3 flying artifact creature until end of turn', () => {
    const { ctx, source } = arkWithGraveyard('ark-flying');
    expect(computeCharacteristics(ctx, source).types).not.toContain('Creature');
    crewArk(ctx, source);
    const chars = computeCharacteristics(ctx, source);
    expect(chars.types).toEqual(expect.arrayContaining(['Artifact', 'Creature']));
    expect(chars.keywords).toContain('flying');
    expect([chars.power, chars.toughness]).toEqual([3, 3]);
  });

  it('ghost-ark-crew-two — a 1-power creature cannot crew it; a 2-power one can', () => {
    const ctx = pod('ark-crew-short');
    const source = spawn(ctx, 'P1', ark.card);
    spawn(
      ctx,
      'P1',
      oracle({ name: 'Ark Cabin Boy', typeLine: 'Creature — Human', power: '1', toughness: '1' }),
    );
    expect(activationMatching(ctx, 'P1', source, CREW)).toBeUndefined();
    const { ctx: ready, source: readyArk, crew } = arkWithGraveyard('ark-crew-ready');
    crewArk(ready, readyArk);
    expect(crew.tapped).toBe(true);
    expect(computeCharacteristics(ready, readyArk).types).toContain('Creature');
  });

  it('ghost-ark-crewed-grants-unearth — crewing it gives only your artifact creature cards unearth {3}', () => {
    const { ctx, source } = arkWithGraveyard('ark-grant');
    expect(unearthFor(ctx, 'P1', 'Ark Thopter')).toBeUndefined();
    crewArk(ctx, source);
    // The crew ability resolving is the crewed event (CR 702.122e): one trigger, on the stack
    // after priority, not yet resolved.
    expect(ctx.state.pendingTriggers.map((trigger) => trigger.sourceName)).toEqual(['Ghost Ark']);
    expect(unearthFor(ctx, 'P1', 'Ark Thopter')).toBeUndefined();
    settle(ctx);
    addMana(playerById(ctx, 'P1'), generic(3));
    expect(unearthFor(ctx, 'P1', 'Ark Thopter')).toBeDefined();
    expect(unearthFor(ctx, 'P1', 'Ark Plain Creature')).toBeUndefined();
    expect(unearthFor(ctx, 'P1', 'Ark Relic')).toBeUndefined();
    // "Your graveyard": the opponent's artifact creature card gains nothing, even on their turn.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    addMana(playerById(ctx, 'P2'), generic(3));
    expect(unearthFor(ctx, 'P2', 'Ark Rival Thopter')).toBeUndefined();
  });

  it('ghost-ark-only-crew-fires — tapping it or animating it another way does not crew it', () => {
    const { ctx, source } = arkWithGraveyard('ark-not-crewed');
    source.tapped = true;
    pump(
      executeAbility(
        ctx,
        {
          cardId: source.cardId,
          name: source.name,
          oracleId: source.oracleId,
          controllerId: 'P1',
        },
        {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'becomeArtifactCreature' }],
        },
        [],
      ),
    );
    expect(computeCharacteristics(ctx, source).types).toContain('Creature');
    expect(ctx.state.pendingTriggers).toEqual([]);
    settle(ctx);
    addMana(playerById(ctx, 'P1'), generic(3));
    expect(unearthFor(ctx, 'P1', 'Ark Thopter')).toBeUndefined();
  });

  it('ghost-ark-unearth-returns-with-haste — pay {3}: the card returns with haste and is exiled at the next end step', () => {
    const { ctx, source, robot } = arkWithGraveyard('ark-unearth');
    crewArk(ctx, source);
    settle(ctx);
    addMana(playerById(ctx, 'P1'), generic(3));
    takeAction(ctx, 'P1', unearthFor(ctx, 'P1', 'Ark Thopter')!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    resolveTop(ctx);
    const returned = ctx.state.battlefield.find((perm) => perm.cardId === robot.cardId);
    expect(returned).toBeDefined();
    expect(computeCharacteristics(ctx, returned!).keywords).toContain('haste');
    queueStepTriggers(ctx, 'endStep');
    settle(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.cardId === robot.cardId)).toBe(false);
    expect(ctx.state.exile.map((card) => card.cardId)).toContain(robot.cardId);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.cardId)).not.toContain(robot.cardId);
  });

  it('ghost-ark-unearth-is-sorcery-speed — the granted unearth waits for your main phase with an empty stack', () => {
    const { ctx, source } = arkWithGraveyard('ark-sorcery');
    crewArk(ctx, source);
    settle(ctx);
    addMana(playerById(ctx, 'P1'), generic(3));
    expect(unearthFor(ctx, 'P1', 'Ark Thopter')).toBeDefined();
    ctx.state.phase = 'combat';
    ctx.state.step = 'declareAttackers';
    expect(unearthFor(ctx, 'P1', 'Ark Thopter')).toBeUndefined();
  });

  it('ghost-ark-unearthed-exiled-instead — an unearthed permanent that would leave the battlefield is exiled instead', () => {
    for (const zone of ['graveyard', 'hand', 'library'] as const) {
      const { ctx, source, robot } = arkWithGraveyard(`ark-replace-${zone}`);
      crewArk(ctx, source);
      settle(ctx);
      addMana(playerById(ctx, 'P1'), generic(3));
      takeAction(ctx, 'P1', unearthFor(ctx, 'P1', 'Ark Thopter')!.payload as PriorityActionPayload);
      resolveTop(ctx);
      const returned = ctx.state.battlefield.find((perm) => perm.cardId === robot.cardId)!;
      pump(moveObject(ctx, returned, { zone }));
      expect(
        ctx.state.exile.map((card) => card.cardId),
        zone,
      ).toContain(robot.cardId);
      const p1 = playerById(ctx, 'P1');
      for (const other of [p1.graveyard, p1.hand, p1.library]) {
        expect(
          other.map((card) => card.cardId),
          zone,
        ).not.toContain(robot.cardId);
      }
    }
  });

  it('ghost-ark-unearthed-never-dies — lethal damage exiles it through state-based actions, with no dies trigger', () => {
    const ctx = pod('ark-unearthed-sba');
    const source = spawn(ctx, 'P1', ark.card);
    spawn(
      ctx,
      'P1',
      oracle({ name: 'Ark Deckhand', typeLine: 'Creature — Human', power: '2', toughness: '2' }),
    );
    const mourner = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Ark Mourning Thopter',
        typeLine: 'Artifact Creature — Thopter',
        manaCost: '{1}',
        power: '1',
        toughness: '1',
        oracleText: 'When this creature dies, you gain 3 life.',
      }),
      'graveyard',
    );
    crewArk(ctx, source);
    settle(ctx);
    addMana(playerById(ctx, 'P1'), generic(3));
    takeAction(
      ctx,
      'P1',
      unearthFor(ctx, 'P1', 'Ark Mourning Thopter')!.payload as PriorityActionPayload,
    );
    resolveTop(ctx);
    const returned = ctx.state.battlefield.find((perm) => perm.cardId === mourner.cardId)!;
    returned.damageMarked = 3;
    const diedBefore = ctx.state.creaturesDiedThisTurn;
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.exile.map((card) => card.cardId)).toContain(mourner.cardId);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.cardId)).not.toContain(
      mourner.cardId,
    );
    // It was exiled instead of put into a graveyard, so it never died (CR 700.4, 702.84a).
    expect(ctx.state.pendingTriggers).toEqual([]);
    expect(ctx.state.creaturesDiedThisTurn).toBe(diedBefore);
    expect(playerById(ctx, 'P1').life).toBe(40);
  });

  it('ghost-ark-grant-ends-at-cleanup — the unearth grant lasts until end of turn', () => {
    const { ctx, source } = arkWithGraveyard('ark-cleanup');
    crewArk(ctx, source);
    settle(ctx);
    addMana(playerById(ctx, 'P1'), generic(3));
    expect(unearthFor(ctx, 'P1', 'Ark Thopter')).toBeDefined();
    endUntilEotEffects(ctx);
    expect(unearthFor(ctx, 'P1', 'Ark Thopter')).toBeUndefined();
  });

  it('ghost-ark-grant-survives-other-costs — paying another ability’s costs does not end the grant', () => {
    const { ctx, source } = arkWithGraveyard('ark-other-costs');
    crewArk(ctx, source);
    settle(ctx);
    // Any cost payment used to wipe every graveyard grant. A different ability, so nothing re-grants.
    const lookout = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Ark Lookout',
        typeLine: 'Artifact',
        oracleText: '{T}: You gain 1 life.',
      }),
    );
    const option = activationMatching(ctx, 'P1', lookout, /gain 1 life/);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(lookout.tapped).toBe(true);
    resolveTop(ctx);
    addMana(playerById(ctx, 'P1'), generic(3));
    expect(unearthFor(ctx, 'P1', 'Ark Thopter')).toBeDefined();
  });

  it('ghost-ark-grant-ends-when-card-leaves-graveyard — a card that leaves and returns is a new object without unearth', () => {
    const { ctx, source, robot } = arkWithGraveyard('ark-new-object');
    crewArk(ctx, source);
    settle(ctx);
    const card = playerById(ctx, 'P1').graveyard.find((entry) => entry.cardId === robot.cardId)!;
    pump(moveObject(ctx, card, { zone: 'hand' }));
    const inHand = playerById(ctx, 'P1').hand.find((entry) => entry.cardId === robot.cardId)!;
    pump(moveObject(ctx, inHand, { zone: 'graveyard' }));
    addMana(playerById(ctx, 'P1'), generic(3));
    expect(playerById(ctx, 'P1').graveyard.map((entry) => entry.cardId)).toContain(robot.cardId);
    expect(unearthFor(ctx, 'P1', 'Ark Thopter')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Group D: alternative casting
// ---------------------------------------------------------------------------------------------

/** Every cast option the player has for `objectId` right now, in option order. */
function castOptionsFor(ctx: GameContext, playerId: string, objectId: string) {
  return priorityOptions(ctx, playerId).filter((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === objectId;
  });
}

const ALTERNATE = /alternate cost/;

const coloredCreature = (name: string, color: 'U' | 'B' | 'G') =>
  oracle({
    name,
    typeLine: 'Creature — Wizard',
    manaCost: `{${color}}`,
    colors: [color],
    power: '1',
    toughness: '1',
  });

const LAB_SHOCK = oracle({
  name: 'Flare Lab Shock',
  typeLine: 'Instant',
  manaCost: '{R}',
  colors: ['R'],
  oracleText: 'Flare Lab Shock deals 2 damage to any target.',
  power: null,
  toughness: null,
});

const LAB_BEAR = oracle({
  name: 'Flare Lab Bear',
  typeLine: 'Creature — Bear',
  manaCost: '{1}',
  power: '2',
  toughness: '2',
});

/** P1 casts a creature spell that stays on the stack: something for a counterspell to target. */
function ownSpellOnStack(ctx: GameContext) {
  const bear = conjure(ctx, 'P1', LAB_BEAR, 'hand');
  addMana(playerById(ctx, 'P1'), generic(1));
  takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', bear.id)!.payload as PriorityActionPayload);
  return ctx.state.stack.at(-1)!;
}

describe('Flare of Denial', () => {
  const flare = pinned('Flare of Denial');

  it('flare-of-denial-pinned-oracle-supported — a sacrifice alternative cost and an unrestricted counter', () => {
    expect(flare.sha256).toBe('bf7016907d2dd85f89b718bc7cb81fa45db2423f52bfee50eff788eab5d3ac34');
    expect(flare.card.oracleText).toBe(
      "You may sacrifice a nontoken blue creature rather than pay this spell's mana cost.\nCounter target spell.",
    );
    expectModeled(flare.card);
    const def = interpretCard(flare.card);
    expect(def.alternativeCasts).toHaveLength(1);
    expect(def.alternativeCasts?.[0]).toMatchObject({ kind: 'nonMana' });
    expect(def.alternativeCasts?.[0]?.from).toBeUndefined();
    expect(def.alternativeCasts?.[0]?.costs).toEqual([
      expect.objectContaining({ kind: 'sacrificeOther' }),
    ]);
    expect(def.spellAbility?.targets).toEqual([{ kind: 'spell' }]);
    expect(def.spellAbility?.effects).toEqual([{ op: 'counter', target: 0 }]);
  });

  it('flare-of-denial-sacrifice-alternative — sacrifice a nontoken blue creature, pay no mana, counter the spell', () => {
    const ctx = pod('flare-denial-alt');
    const merfolk = spawn(ctx, 'P1', coloredCreature('Flare Blue Merfolk', 'U'));
    const spell = ownSpellOnStack(ctx);
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    const alternative = castOptionsFor(ctx, 'P1', inHand.id).find((option) =>
      ALTERNATE.test(option.description),
    );
    expect(alternative).toBeDefined();
    takeAction(
      ctx,
      'P1',
      alternative!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, spell.id]]),
    );
    expect(ctx.state.battlefield.some((perm) => perm.id === merfolk.id)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toContain(
      'Flare Blue Merfolk',
    );
    resolveTop(ctx);
    expect(ctx.state.stack).toEqual([]);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual(
      expect.arrayContaining(['Flare Lab Bear', 'Flare of Denial']),
    );
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Flare Lab Bear')).toBe(false);
  });

  it('flare-of-denial-sacrifice-needs-nontoken-blue — a token or a nonblue creature cannot pay it', () => {
    const ctx = pod('flare-denial-unpayable');
    spawn(ctx, 'P1', coloredCreature('Flare Blue Token', 'U'), { isToken: true });
    spawn(ctx, 'P1', coloredCreature('Flare Black Wizard', 'B'));
    ownSpellOnStack(ctx);
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    expect(castOptionsFor(ctx, 'P1', inHand.id)).toEqual([]);
    // The opponent's blue creature is not yours to sacrifice.
    spawn(ctx, 'P2', coloredCreature('Flare Rival Merfolk', 'U'));
    expect(castOptionsFor(ctx, 'P1', inHand.id)).toEqual([]);
    spawn(ctx, 'P1', coloredCreature('Flare Blue Merfolk', 'U'));
    expect(
      castOptionsFor(ctx, 'P1', inHand.id).some((option) => ALTERNATE.test(option.description)),
    ).toBe(true);
  });

  it('flare-of-denial-needs-a-spell — with nothing on the stack there is nothing to cast it at', () => {
    const ctx = pod('flare-denial-no-target');
    spawn(ctx, 'P1', coloredCreature('Flare Blue Merfolk', 'U'));
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    expect(castOptionsFor(ctx, 'P1', inHand.id)).toEqual([]);
  });

  it('flare-of-denial-counters-any-spell — an opponent’s instant or your own spell are both targets', () => {
    const ctx = pod('flare-denial-any-spell');
    spawn(ctx, 'P1', coloredCreature('Flare Blue Merfolk', 'U'));
    const own = ownSpellOnStack(ctx);
    const shock = conjure(ctx, 'P2', LAB_SHOCK, 'hand');
    addMana(playerById(ctx, 'P2'), [{ symbol: 'R' }]);
    takeAction(
      ctx,
      'P2',
      castOptionFor(ctx, 'P2', shock.id)!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, 'P1']]),
    );
    const theirs = ctx.state.stack.at(-1)!;
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    const option = castOptionsFor(ctx, 'P1', inHand.id).find((entry) =>
      ALTERNATE.test(entry.description),
    );
    expect(option?.targets?.[0]?.options).toEqual(expect.arrayContaining([own.id, theirs.id]));
  });

  it('flare-of-denial-normal-cast — {1}{U}{U} still casts it without a sacrifice', () => {
    const ctx = pod('flare-denial-normal');
    const merfolk = spawn(ctx, 'P1', coloredCreature('Flare Blue Merfolk', 'U'));
    const spell = ownSpellOnStack(ctx);
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'U' }, { symbol: 'U' }, { symbol: 'C' }]);
    const normal = castOptionsFor(ctx, 'P1', inHand.id).find(
      (option) => !ALTERNATE.test(option.description),
    );
    expect(normal).toBeDefined();
    takeAction(
      ctx,
      'P1',
      normal!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, spell.id]]),
    );
    expect(ctx.state.battlefield.some((perm) => perm.id === merfolk.id)).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    resolveTop(ctx);
    expect(ctx.state.stack).toEqual([]);
  });
});

describe('Flare of Malice', () => {
  const flare = pinned('Flare of Malice');

  const withMV = (name: string, typeLine: string, mv: number) =>
    oracle({
      name,
      typeLine,
      manaCost: `{${mv}}`,
      cmc: mv,
      ...(typeLine.includes('Planeswalker') ? { loyalty: '3', power: null, toughness: null } : {}),
      ...(typeLine.includes('Creature') ? {} : { power: null, toughness: null }),
    });

  /** P2: a 3-MV creature and a 4-MV planeswalker. P3: two 2-MV creatures and a 5-MV artifact. */
  function boards(seed: string) {
    const ctx = pod(seed);
    const p2Creature = spawn(ctx, 'P2', withMV('Malice P2 Ogre', 'Creature — Ogre', 3));
    const p2Walker = spawn(
      ctx,
      'P2',
      withMV('Malice P2 Walker', 'Legendary Planeswalker — Test', 4),
    );
    const p3First = spawn(ctx, 'P3', withMV('Malice P3 First', 'Creature — Elf', 2));
    const p3Second = spawn(ctx, 'P3', withMV('Malice P3 Second', 'Creature — Elf', 2));
    const p3Relic = spawn(ctx, 'P3', withMV('Malice P3 Relic', 'Artifact', 5));
    const mine = spawn(ctx, 'P1', withMV('Malice Own Giant', 'Creature — Giant', 6));
    return { ctx, p2Creature, p2Walker, p3First, p3Second, p3Relic, mine };
  }

  const onBattlefield = (ctx: GameContext, perm: EnginePermanent) =>
    ctx.state.battlefield.some((candidate) => candidate.id === perm.id);

  it('flare-of-malice-pinned-oracle-supported — a sacrifice alternative cost and a greatest-mana-value edict', () => {
    expect(flare.sha256).toBe('d358e361fe29eb5d7bb7a2b7150da42213f3ec722749868738013cf835d87ec0');
    expect(flare.card.oracleText).toBe(
      "You may sacrifice a nontoken black creature rather than pay this spell's mana cost.\nEach opponent sacrifices a creature or planeswalker with the greatest mana value among creatures and planeswalkers they control.",
    );
    expectModeled(flare.card);
    expect(getOverride(flare.card.oracleId)).toBeUndefined();
    const def = interpretCard(flare.card);
    expect(def.alternativeCasts?.[0]?.costs).toEqual([
      expect.objectContaining({ kind: 'sacrificeOther' }),
    ]);
    expect(def.spellAbility?.effects).toEqual([
      {
        op: 'sacrificeGreatestEachOpponent',
        selector: 'creatureOrPlaneswalker',
        metric: 'manaValue',
        action: 'sacrifice',
      },
    ]);
  });

  it('flare-of-malice-sacrifice-alternative — sacrifice a nontoken black creature and pay no mana', () => {
    const { ctx } = boards('malice-alt');
    const wizard = spawn(ctx, 'P1', coloredCreature('Malice Black Wizard', 'B'));
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    const options = castOptionsFor(ctx, 'P1', inHand.id);
    expect(options.map((option) => ALTERNATE.test(option.description))).toEqual([true]);
    takeAction(ctx, 'P1', options[0]!.payload as PriorityActionPayload);
    expect(onBattlefield(ctx, wizard)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toContain(
      'Malice Black Wizard',
    );
    expect(ctx.state.stack.at(-1)?.sourceCardId).toBe(inHand.cardId);
  });

  it('flare-of-malice-greatest-mana-value — each opponent sacrifices their greatest creature or planeswalker', () => {
    const { ctx, p2Creature, p2Walker, p3First, p3Second, p3Relic, mine } = boards('malice-edict');
    spawn(ctx, 'P1', coloredCreature('Malice Black Wizard', 'B'));
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    takeAction(
      ctx,
      'P1',
      castOptionsFor(ctx, 'P1', inHand.id)[0]!.payload as PriorityActionPayload,
    );
    const offered: string[][] = [];
    resolveTop(ctx, (decision) => {
      offered.push(decision.options.map((option) => option.description));
      return optionMatching(decision, /Malice P3 Second/);
    });
    // P2's 4-MV planeswalker outranks its 3-MV creature.
    expect(onBattlefield(ctx, p2Walker)).toBe(false);
    expect(onBattlefield(ctx, p2Creature)).toBe(true);
    // P3's 5-MV artifact is neither a creature nor a planeswalker; its two 2-MV creatures tie,
    // and P3 chooses which.
    expect(offered).toHaveLength(1);
    expect(offered[0]?.join(' | ')).toMatch(/Malice P3 First/);
    expect(offered[0]?.join(' | ')).not.toMatch(/Malice P3 Relic/);
    expect(onBattlefield(ctx, p3Second)).toBe(false);
    expect(onBattlefield(ctx, p3First)).toBe(true);
    expect(onBattlefield(ctx, p3Relic)).toBe(true);
    // P4 controls nothing; your own creatures are untouched.
    expect(onBattlefield(ctx, mine)).toBe(true);
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toEqual(['Malice P2 Walker']);
  });

  it('flare-of-malice-sacrifice-needs-nontoken-black — a token or a nonblack creature cannot pay it', () => {
    const { ctx } = boards('malice-unpayable');
    spawn(ctx, 'P1', coloredCreature('Malice Black Token', 'B'), { isToken: true });
    spawn(ctx, 'P1', coloredCreature('Malice Blue Wizard', 'U'));
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    expect(castOptionsFor(ctx, 'P1', inHand.id)).toEqual([]);
  });

  it('flare-of-malice-normal-cast — {2}{B}{B} casts it without a sacrifice', () => {
    const { ctx, p2Walker } = boards('malice-normal');
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }, { symbol: 'B' }, ...generic(2)]);
    const options = castOptionsFor(ctx, 'P1', inHand.id);
    expect(options.map((option) => ALTERNATE.test(option.description))).toEqual([false]);
    takeAction(ctx, 'P1', options[0]!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    resolveTop(ctx, answers([[/sacrifice/i, /Malice P3 First/]]));
    expect(onBattlefield(ctx, p2Walker)).toBe(false);
  });

  it('flare-of-malice-face-down-mana-value — a face-down creature has mana value 0 (CR 708.2)', () => {
    const ctx = pod('malice-face-down');
    const hidden = spawn(ctx, 'P2', withMV('Malice Hidden Titan', 'Creature — Giant', 6));
    hidden.faceDown = true;
    const ogre = spawn(ctx, 'P2', withMV('Malice P2 Ogre', 'Creature — Ogre', 3));
    spawn(ctx, 'P1', coloredCreature('Malice Black Wizard', 'B'));
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    takeAction(
      ctx,
      'P1',
      castOptionsFor(ctx, 'P1', inHand.id)[0]!.payload as PriorityActionPayload,
    );
    resolveTop(ctx);
    expect(onBattlefield(ctx, ogre)).toBe(false);
    expect(onBattlefield(ctx, hidden)).toBe(true);
  });

  it('flare-of-malice-simultaneous — every opponent chooses first, then all sacrifice at once (CR 101.4)', () => {
    const { ctx, p2Walker, p3First } = boards('malice-simultaneous');
    spawn(ctx, 'P1', coloredCreature('Malice Black Wizard', 'B'));
    const inHand = conjure(ctx, 'P1', flare.card, 'hand');
    takeAction(
      ctx,
      'P1',
      castOptionsFor(ctx, 'P1', inHand.id)[0]!.payload as PriorityActionPayload,
    );
    // When P3 chooses, P2's planeswalker must still be on the battlefield.
    let walkerAtChoice: boolean | undefined;
    resolveTop(ctx, (decision) => {
      walkerAtChoice = onBattlefield(ctx, p2Walker);
      return optionMatching(decision, /Malice P3 First/);
    });
    expect(walkerAtChoice).toBe(true);
    expect(onBattlefield(ctx, p2Walker)).toBe(false);
    expect(onBattlefield(ctx, p3First)).toBe(false);
  });
});

describe('Blasphemous Edict', () => {
  const edict = pinned('Blasphemous Edict');
  const ALT_B = /\(\{B\}\) \(alternate cost\)/;

  const bodies = (ctx: GameContext, playerId: string, n: number, prefix: string) =>
    Array.from({ length: n }, (_, i) =>
      spawn(ctx, playerId, oracle({ name: `${prefix} ${i + 1}`, typeLine: 'Creature — Zombie' })),
    );

  it('blasphemous-edict-pinned-oracle-supported — a conditional {B} alternative cost and a thirteen-creature edict', () => {
    expect(edict.sha256).toBe('6994bb591cb20faee9759d2070892083e2cea7b20e36ece110b5cc740790b4d3');
    expect(edict.card.oracleText).toBe(
      "You may pay {B} rather than pay this spell's mana cost if there are thirteen or more creatures on the battlefield.\nEach player sacrifices thirteen creatures of their choice.",
    );
    expectModeled(edict.card);
    expect(getOverride(edict.card.oracleId)).toBeUndefined();
    const def = interpretCard(edict.card);
    expect(def.alternativeCasts).toEqual([
      expect.objectContaining({
        kind: 'nonMana',
        manaCost: { generic: 0, colored: { W: 0, U: 0, B: 1, R: 0, G: 0 }, colorless: 0 },
        condition: {
          kind: 'countPermanents',
          selector: ofType('Creature'),
          scope: 'all',
          cmp: '>=',
          n: 13,
        },
      }),
    ]);
    expect(def.spellAbility?.effects).toEqual([
      { op: 'sacrificeEachPlayer', count: 13, filter: 'creature' },
    ]);
  });

  it('blasphemous-edict-needs-thirteen-creatures — twelve creatures on the battlefield do not unlock {B}', () => {
    const ctx = pod('edict-twelve');
    bodies(ctx, 'P1', 6, 'Edict Own');
    bodies(ctx, 'P2', 6, 'Edict Rival');
    const inHand = conjure(ctx, 'P1', edict.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }]);
    expect(castOptionsFor(ctx, 'P1', inHand.id)).toEqual([]);
    // Every player's creatures count, not only yours: the thirteenth is an opponent's.
    bodies(ctx, 'P3', 1, 'Edict Third');
    expect(castOptionsFor(ctx, 'P1', inHand.id).map((option) => option.description)).toEqual([
      expect.stringMatching(ALT_B),
    ]);
  });

  it('blasphemous-edict-alternative-pays-b — the alternative cost spends {B}, not nothing', () => {
    const ctx = pod('edict-pays-b');
    bodies(ctx, 'P2', 13, 'Edict Rival');
    const inHand = conjure(ctx, 'P1', edict.card, 'hand');
    expect(castOptionsFor(ctx, 'P1', inHand.id)).toEqual([]);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }]);
    const option = castOptionsFor(ctx, 'P1', inHand.id).find((entry) =>
      ALT_B.test(entry.description),
    );
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(ctx.state.stack.at(-1)?.sourceCardId).toBe(inHand.cardId);
  });

  it('blasphemous-edict-each-player-sacrifices-thirteen — each player sacrifices thirteen of their choice, or all they have', () => {
    const ctx = pod('edict-resolve');
    const mine = bodies(ctx, 'P1', 14, 'Edict Own');
    const theirs = bodies(ctx, 'P2', 3, 'Edict Rival');
    const relic = spawn(
      ctx,
      'P2',
      oracle({ name: 'Edict Relic', typeLine: 'Artifact', power: null, toughness: null }),
    );
    const inHand = conjure(ctx, 'P1', edict.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }]);
    takeAction(
      ctx,
      'P1',
      castOptionsFor(ctx, 'P1', inHand.id).find((entry) => ALT_B.test(entry.description))!
        .payload as PriorityActionPayload,
    );
    const prompts: string[] = [];
    resolveTop(ctx, (decision) => {
      prompts.push(`${decision.player}: ${decision.prompt}`);
      // P1 keeps its last creature: choose every other one first.
      const keep = decision.options.findIndex((option) => !/Edict Own 14/.test(option.description));
      return { index: Math.max(0, keep), targets: new Map() };
    });
    const alive = (perm: EnginePermanent) =>
      ctx.state.battlefield.some((candidate) => candidate.id === perm.id);
    // P1 chose thirteen of fourteen; P2 owed thirteen and had three, so all went unasked.
    expect(prompts).toHaveLength(13);
    expect(prompts.every((prompt) => prompt.startsWith('P1:'))).toBe(true);
    expect(mine.filter(alive).map((perm) => perm.name)).toEqual(['Edict Own 14']);
    expect(theirs.filter(alive)).toEqual([]);
    expect(alive(relic)).toBe(true);
  });

  it('blasphemous-edict-normal-cast — {3}{B}{B} casts it at sorcery speed with no creature count', () => {
    const ctx = pod('edict-normal');
    const inHand = conjure(ctx, 'P1', edict.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }, { symbol: 'B' }, ...generic(3)]);
    const options = castOptionsFor(ctx, 'P1', inHand.id);
    expect(options.map((option) => ALTERNATE.test(option.description))).toEqual([false]);
    takeAction(ctx, 'P1', options[0]!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    // A sorcery: not on an opponent's turn.
    const later = pod('edict-normal-off-turn');
    later.state.currentTurnPlayer = 'P2';
    later.state.activePlayerIndex = 1;
    const offTurn = conjure(later, 'P1', edict.card, 'hand');
    addMana(playerById(later, 'P1'), [{ symbol: 'B' }, { symbol: 'B' }, ...generic(3)]);
    expect(castOptionsFor(later, 'P1', offTurn.id)).toEqual([]);
  });
});

describe('Dread Return', () => {
  const dread = pinned('Dread Return');
  const FLASHBACK = /from your graveyard/;

  /** Dread Return and a creature card in P1's graveyard, and `fodder` creatures on the battlefield. */
  function setup(seed: string, fodder: number) {
    const ctx = pod(seed);
    const spell = conjure(ctx, 'P1', dread.card, 'graveyard');
    const target = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Dread Buried Giant',
        typeLine: 'Creature — Giant',
        power: '5',
        toughness: '5',
      }),
      'graveyard',
    );
    const bodies = Array.from({ length: fodder }, (_, i) =>
      spawn(ctx, 'P1', oracle({ name: `Dread Fodder ${i + 1}`, typeLine: 'Creature — Zombie' })),
    );
    return { ctx, spell, target, bodies };
  }

  const flashbackOption = (ctx: GameContext, objectId: string) =>
    castOptionsFor(ctx, 'P1', objectId).find((option) => FLASHBACK.test(option.description));

  it('dread-return-pinned-oracle-supported — the reanimation and a flashback whose whole cost is three sacrifices', () => {
    expect(dread.sha256).toBe('bda6e9277a015c56401c6b4f23fca3e7258d3aaeb53a6f234f3610f44b650553');
    expect(dread.card.oracleText).toBe(
      'Return target creature card from your graveyard to the battlefield.\nFlashback—Sacrifice three creatures. (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
    );
    expectModeled(dread.card);
    expect(getOverride(dread.card.oracleId)).toBeUndefined();
    const def = interpretCard(dread.card);
    expect(def.alternativeCasts).toEqual([
      expect.objectContaining({
        kind: 'nonMana',
        from: 'graveyard',
        manaCost: { generic: 0, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
        exileOnResolution: true,
        costs: [expect.objectContaining({ kind: 'sacrificeOther', count: 3 })],
      }),
    ]);
  });

  it('dread-return-flashback-sacrifice-three — sacrifice three creatures, return the target, exile Dread Return', () => {
    const { ctx, spell, target, bodies } = setup('dread-flashback', 3);
    const option = flashbackOption(ctx, spell.id);
    expect(option).toBeDefined();
    expect(option?.targets?.[0]?.options).toEqual([target.id]);
    const { decisions } = takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, target.id]]),
    );
    // Exactly three creatures for three sacrifices: nothing to choose, so nothing is asked.
    expect(decisions.filter((decision) => /sacrifice/i.test(decision.prompt))).toEqual([]);
    for (const body of bodies) {
      expect(ctx.state.battlefield.some((perm) => perm.id === body.id)).toBe(false);
    }
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.cardId === target.cardId)).toBe(true);
    expect(ctx.state.exile.map((card) => card.cardId)).toContain(spell.cardId);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.cardId)).not.toContain(spell.cardId);
  });

  it('dread-return-flashback-needs-three-creatures — two creatures cannot pay it, and an opponent’s do not count', () => {
    const { ctx, spell } = setup('dread-two', 2);
    spawn(ctx, 'P2', oracle({ name: 'Dread Rival Zombie', typeLine: 'Creature — Zombie' }));
    expect(flashbackOption(ctx, spell.id)).toBeUndefined();
    spawn(ctx, 'P1', oracle({ name: 'Dread Third Zombie', typeLine: 'Creature — Zombie' }));
    expect(flashbackOption(ctx, spell.id)).toBeDefined();
  });

  it('dread-return-flashback-sorcery-speed — a sorcery’s flashback waits for your main phase', () => {
    const { ctx, spell } = setup('dread-timing', 3);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(flashbackOption(ctx, spell.id)).toBeUndefined();
  });

  it('dread-return-flashback-exiled-when-countered-by-rules — an illegal target still sends it to exile', () => {
    const { ctx, spell, target } = setup('dread-fizzle', 3);
    takeAction(
      ctx,
      'P1',
      flashbackOption(ctx, spell.id)!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, target.id]]),
    );
    const buried = playerById(ctx, 'P1').graveyard.find((card) => card.cardId === target.cardId)!;
    pump(moveObject(ctx, buried, { zone: 'exile' }));
    resolveTop(ctx);
    // CR 702.34a: a flashback spell is exiled whenever it would leave the stack.
    expect(ctx.state.exile.map((card) => card.cardId)).toContain(spell.cardId);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.cardId)).not.toContain(spell.cardId);
  });

  it('dread-return-normal-cast — {2}{B}{B} from hand returns the target, and the card goes to the graveyard', () => {
    const ctx = pod('dread-hand');
    const target = conjure(
      ctx,
      'P1',
      oracle({ name: 'Dread Buried Giant', typeLine: 'Creature — Giant' }),
      'graveyard',
    );
    const inHand = conjure(ctx, 'P1', dread.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }, { symbol: 'B' }, ...generic(2)]);
    const options = castOptionsFor(ctx, 'P1', inHand.id);
    expect(options).toHaveLength(1);
    takeAction(
      ctx,
      'P1',
      options[0]!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, target.id]]),
    );
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.cardId === target.cardId)).toBe(true);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.cardId)).toContain(inHand.cardId);
  });
});

describe("Raffine's Guidance", () => {
  const guidance = pinned("Raffine's Guidance");
  const RECAST = /from your graveyard/;

  function setup(seed: string) {
    const ctx = pod(seed);
    const knight = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Guidance Knight',
        typeLine: 'Creature — Knight',
        power: '2',
        toughness: '2',
      }),
    );
    const aura = conjure(ctx, 'P1', guidance.card, 'graveyard');
    return { ctx, knight, aura };
  }

  const recastOption = (ctx: GameContext, objectId: string) =>
    castOptionsFor(ctx, 'P1', objectId).find((option) => RECAST.test(option.description));

  const attachedAura = (ctx: GameContext, cardId: string) =>
    ctx.state.battlefield.find((perm) => perm.cardId === cardId);

  it("raffines-guidance-pinned-oracle-supported — the Aura's +1/+1 and a {2}{W} graveyard alternative cost", () => {
    expect(guidance.sha256).toBe(
      '44bdca5ef478f6340f60ac4c911274747431dab346b34c92e2d3c2c092759823',
    );
    expect(guidance.card.oracleText).toBe(
      'Enchant creature\nEnchanted creature gets +1/+1.\nYou may cast this card from your graveyard by paying {2}{W} rather than paying its mana cost.',
    );
    expectModeled(guidance.card);
    expect(getOverride(guidance.card.oracleId)).toBeUndefined();
    const def = interpretCard(guidance.card);
    expect(def.alternativeCasts).toEqual([
      {
        kind: 'nonMana',
        from: 'graveyard',
        manaCost: { generic: 2, colored: { W: 1, U: 0, B: 0, R: 0, G: 0 }, colorless: 0 },
        description:
          'You may cast this card from your graveyard by paying {2}{W} rather than paying its mana cost.',
      },
    ]);
  });

  it('raffines-guidance-graveyard-recast — pay {2}{W} from the graveyard to enchant a creature for +1/+1', () => {
    const { ctx, knight, aura } = setup('guidance-recast');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, ...generic(2)]);
    const option = recastOption(ctx, aura.id);
    expect(option).toBeDefined();
    expect(option?.targets?.[0]?.options).toContain(knight.id);
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, knight.id]]),
    );
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    resolveTop(ctx);
    expect(attachedAura(ctx, aura.cardId)?.attachedTo).toBe(knight.id);
    const chars = computeCharacteristics(ctx, knight);
    expect([chars.power, chars.toughness]).toEqual([3, 3]);
  });

  it('raffines-guidance-recast-needs-two-and-white — {W} alone cannot cast it from the graveyard', () => {
    const { ctx, aura } = setup('guidance-short');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, ...generic(1)]);
    expect(recastOption(ctx, aura.id)).toBeUndefined();
    addMana(playerById(ctx, 'P1'), generic(1));
    expect(recastOption(ctx, aura.id)).toBeDefined();
  });

  it('raffines-guidance-recast-sorcery-speed — an Aura is cast from the graveyard only at sorcery speed', () => {
    const { ctx, aura } = setup('guidance-timing');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, ...generic(2)]);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(recastOption(ctx, aura.id)).toBeUndefined();
  });

  it('raffines-guidance-recast-again — not exiled: when the creature dies the Aura returns to the graveyard and can be cast again', () => {
    const { ctx, knight, aura } = setup('guidance-again');
    const second = spawn(
      ctx,
      'P1',
      oracle({ name: 'Guidance Squire', typeLine: 'Creature — Human' }),
    );
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, ...generic(2)]);
    takeAction(
      ctx,
      'P1',
      recastOption(ctx, aura.id)!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, knight.id]]),
    );
    resolveTop(ctx);
    pump(moveObject(ctx, knight, { zone: 'graveyard' }));
    pump(priorityCheckpoint(ctx));
    const back = playerById(ctx, 'P1').graveyard.find((card) => card.cardId === aura.cardId);
    expect(back).toBeDefined();
    expect(ctx.state.exile.map((card) => card.cardId)).not.toContain(aura.cardId);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, ...generic(2)]);
    const again = recastOption(ctx, back!.id);
    expect(again?.targets?.[0]?.options).toContain(second.id);
  });

  it('raffines-guidance-normal-cast — {W} from hand casts it normally', () => {
    const ctx = pod('guidance-hand');
    const knight = spawn(
      ctx,
      'P1',
      oracle({ name: 'Guidance Knight', typeLine: 'Creature — Knight' }),
    );
    const inHand = conjure(ctx, 'P1', guidance.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }]);
    const options = castOptionsFor(ctx, 'P1', inHand.id);
    expect(options).toHaveLength(1);
    takeAction(
      ctx,
      'P1',
      options[0]!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, knight.id]]),
    );
    resolveTop(ctx);
    expect(attachedAura(ctx, inHand.cardId)?.attachedTo).toBe(knight.id);
  });
});

describe('Their Number Is Legion', () => {
  const legion = pinned('Their Number Is Legion');
  const fourBlack = () => [
    { symbol: 'B' as const },
    { symbol: 'B' as const },
    { symbol: 'B' as const },
    { symbol: 'B' as const },
  ];

  const optionWithX = (ctx: GameContext, objectId: string, x: number) =>
    castOptionsFor(ctx, 'P1', objectId).find((option) => option.description.includes(`X=${x}`));

  const warriors = (ctx: GameContext) =>
    ctx.state.battlefield.filter((perm) => perm.name === 'Necron Warrior');

  it('their-number-is-legion-pinned-oracle-supported — tapped Warriors, artifact-count life, self-exile, graveyard cast', () => {
    expect(legion.sha256).toBe('41b6712d088b044a1c75a4ef825006b3774b32f673850f48bb207b10e00e24a6');
    expect(legion.card.oracleText).toBe(
      'Create X tapped 2/2 black Necron Warrior artifact creature tokens, then you gain life equal to the number of artifacts you control. Exile Their Number Is Legion.\nYou may cast this card from your graveyard.',
    );
    expectModeled(legion.card);
    expect(getOverride(legion.card.oracleId)).toBeUndefined();
    const def = interpretCard(legion.card);
    expect(def.castFromGraveyard).toBe(true);
    expect(def.alternativeCasts).toBeUndefined();
    expect(def.spellAbility?.effects.map((effect) => effect.op)).toEqual([
      'createToken',
      'gainLife',
      'resolvingSpellExile',
    ]);
  });

  it('their-number-is-legion-tapped-tokens-and-life — X tapped Warriors, then life for every artifact you control', () => {
    const ctx = pod('legion-hand');
    spawn(
      ctx,
      'P1',
      oracle({ name: 'Legion Relic', typeLine: 'Artifact', power: null, toughness: null }),
    );
    spawn(
      ctx,
      'P2',
      oracle({ name: 'Legion Rival Relic', typeLine: 'Artifact', power: null, toughness: null }),
    );
    const inHand = conjure(ctx, 'P1', legion.card, 'hand');
    addMana(playerById(ctx, 'P1'), [...fourBlack(), ...generic(2)]);
    const option = optionWithX(ctx, inHand.id, 2);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    expect(warriors(ctx)).toHaveLength(2);
    expect(warriors(ctx).every((token) => token.tapped && token.controllerId === 'P1')).toBe(true);
    // Two Warriors and the Relic are yours; the opponent's Relic does not count.
    expect(playerById(ctx, 'P1').life).toBe(43);
  });

  it('their-number-is-legion-exiles-itself — after resolving it is exiled, not put into the graveyard', () => {
    const ctx = pod('legion-exile');
    const inHand = conjure(ctx, 'P1', legion.card, 'hand');
    addMana(playerById(ctx, 'P1'), fourBlack());
    takeAction(ctx, 'P1', optionWithX(ctx, inHand.id, 0)!.payload as PriorityActionPayload);
    resolveTop(ctx);
    expect(warriors(ctx)).toEqual([]);
    expect(ctx.state.exile.map((card) => card.cardId)).toContain(inHand.cardId);
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.cardId)).not.toContain(inHand.cardId);
  });

  it('their-number-is-legion-graveyard-cast — cast from the graveyard for its full cost, X included', () => {
    const ctx = pod('legion-graveyard');
    const inYard = conjure(ctx, 'P1', legion.card, 'graveyard');
    expect(castOptionsFor(ctx, 'P1', inYard.id)).toEqual([]);
    addMana(playerById(ctx, 'P1'), [...fourBlack(), ...generic(1)]);
    const options = castOptionsFor(ctx, 'P1', inYard.id);
    expect(options.map((option) => option.description)).toEqual([
      expect.stringMatching(/X=0/),
      expect.stringMatching(/X=1/),
    ]);
    takeAction(ctx, 'P1', optionWithX(ctx, inYard.id, 1)!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    resolveTop(ctx);
    expect(warriors(ctx)).toHaveLength(1);
    expect(ctx.state.exile.map((card) => card.cardId)).toContain(inYard.cardId);
  });

  it('their-number-is-legion-graveyard-sorcery-speed — a sorcery cast from the graveyard waits for your main phase', () => {
    const ctx = pod('legion-graveyard-timing');
    const inYard = conjure(ctx, 'P1', legion.card, 'graveyard');
    addMana(playerById(ctx, 'P1'), fourBlack());
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(castOptionsFor(ctx, 'P1', inYard.id)).toEqual([]);
  });

  it('their-number-is-legion-graveyard-only-yours — the permission is for your own graveyard', () => {
    const ctx = pod('legion-other-yard');
    const theirs = conjure(ctx, 'P2', legion.card, 'graveyard');
    addMana(playerById(ctx, 'P1'), fourBlack());
    expect(castOptionsFor(ctx, 'P1', theirs.id)).toEqual([]);
  });
});

describe('Anrakyr the Traveller', () => {
  const anrakyr = pinned('Anrakyr the Traveller');
  const artifact = (name: string, mv: number, typeLine = 'Artifact') =>
    oracle({
      name,
      typeLine,
      manaCost: `{${mv}}`,
      cmc: mv,
      ...(typeLine.includes('Creature') ? {} : { power: null, toughness: null }),
    });

  /**
   * Attack P2 with Anrakyr and answer its trigger: accept it, then pick the cast option matching
   * `pick` (or cast nothing when `pick` is null). Returns the cast options it was offered.
   */
  function attack(ctx: GameContext, self: EnginePermanent, pick: RegExp | null) {
    const offered: string[] = [];
    pump(runCombatAndExtraCombats(ctx), (decision) => {
      if (decision.presentationAttackDeclaration !== undefined) {
        return declareAttacks(decision, (subjectId) => (subjectId === self.id ? 'P2' : null));
      }
      if (decision.presentationBlockDeclaration !== undefined) {
        return { index: 0, targets: new Map() };
      }
      const casts = decision.options.filter((option) => /^Cast .* life$/.test(option.description));
      if (casts.length > 0) {
        offered.push(...casts.map((option) => option.description));
        const index =
          pick === null
            ? decision.options.findIndex((option) => option.type === 'decline')
            : decision.options.findIndex((option) => pick.test(option.description));
        return { index, targets: new Map() };
      }
      const accept = decision.options.findIndex((option) => option.type === 'acceptTrigger');
      if (accept >= 0) return { index: accept, targets: new Map() };
      const pass = decision.options.findIndex((option) => option.type === 'pass');
      return { index: Math.max(pass, 0), targets: new Map() };
    });
    return offered;
  }

  function ready(seed: string) {
    const ctx = pod(seed);
    const self = spawn(ctx, 'P1', anrakyr.card);
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    return { ctx, self };
  }

  const onBattlefield = (ctx: GameContext, cardId: string) =>
    ctx.state.battlefield.some((perm) => perm.cardId === cardId);

  it('anrakyr-the-traveller-pinned-oracle-supported — an optional attack trigger that casts an artifact for life', () => {
    expect(anrakyr.sha256).toBe('1f11aa229db25bcdc8cb4b657fc98252b59975ad92a97811bae330033a79dcf9');
    expect(anrakyr.card.oracleText).toBe(
      'Lord of the Pyrrhian Legions — Whenever Anrakyr the Traveller attacks, you may cast an artifact spell from your hand or graveyard by paying life equal to its mana value rather than paying its mana cost.',
    );
    expectModeled(anrakyr.card);
    expect(getOverride(anrakyr.card.oracleId)).toBeUndefined();
    const [trigger] = interpretCard(anrakyr.card).triggers;
    expect(trigger?.trigger).toEqual({ when: 'attacks', subject: { kind: 'self' } });
    expect(trigger?.optional).toBe(true);
    expect(trigger?.effects).toEqual([
      { op: 'castForLifeFromZones', selector: ofType('Artifact'), zones: ['hand', 'graveyard'] },
    ]);
  });

  it('anrakyr-the-traveller-cast-from-hand-for-life — pay 3 life to cast a 3-mana-value artifact from hand', () => {
    const { ctx, self } = ready('anrakyr-hand');
    const relic = conjure(ctx, 'P1', artifact('Anrakyr Relic', 3), 'hand');
    attack(ctx, self, /Anrakyr Relic/);
    expect(playerById(ctx, 'P1').life).toBe(37);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(onBattlefield(ctx, relic.cardId)).toBe(true);
  });

  it('anrakyr-the-traveller-cast-from-graveyard-for-life — an artifact creature card in the graveyard is castable too', () => {
    const { ctx, self } = ready('anrakyr-graveyard');
    const golem = conjure(
      ctx,
      'P1',
      artifact('Anrakyr Golem', 4, 'Artifact Creature — Golem'),
      'graveyard',
    );
    const offered = attack(ctx, self, /Anrakyr Golem/);
    expect(offered).toEqual(['Cast Anrakyr Golem from your graveyard for 4 life']);
    expect(playerById(ctx, 'P1').life).toBe(36);
    expect(onBattlefield(ctx, golem.cardId)).toBe(true);
  });

  it('anrakyr-the-traveller-only-your-artifacts — nonartifacts and an opponent’s graveyard are not offered', () => {
    const { ctx, self } = ready('anrakyr-filter');
    conjure(ctx, 'P1', oracle({ name: 'Anrakyr Bear', typeLine: 'Creature — Bear' }), 'hand');
    conjure(ctx, 'P2', artifact('Anrakyr Rival Relic', 1), 'graveyard');
    const relic = conjure(ctx, 'P1', artifact('Anrakyr Own Relic', 1), 'graveyard');
    const offered = attack(ctx, self, null);
    expect(offered).toEqual(['Cast Anrakyr Own Relic from your graveyard for 1 life']);
    // Declining casts nothing and costs nothing.
    expect(playerById(ctx, 'P1').life).toBe(40);
    expect(onBattlefield(ctx, relic.cardId)).toBe(false);
  });

  it('anrakyr-the-traveller-needs-the-life — you cannot pay more life than you have (CR 119.4)', () => {
    const { ctx, self } = ready('anrakyr-life');
    playerById(ctx, 'P1').life = 2;
    conjure(ctx, 'P1', artifact('Anrakyr Big Relic', 3), 'hand');
    const free = conjure(ctx, 'P1', artifact('Anrakyr Zero Relic', 0), 'hand');
    const offered = attack(ctx, self, /Anrakyr Zero Relic/);
    expect(offered).toEqual(['Cast Anrakyr Zero Relic from your hand for 0 life']);
    expect(playerById(ctx, 'P1').life).toBe(2);
    expect(onBattlefield(ctx, free.cardId)).toBe(true);
  });

  it('anrakyr-the-traveller-respects-cast-bans — "can\'t cast spells during combat" stops its cast', () => {
    const { ctx, self } = ready('anrakyr-ban');
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Anrakyr Combat Ban',
        typeLine: 'Enchantment',
        oracleText: "Players can't cast spells during combat.",
        power: null,
        toughness: null,
      }),
    );
    const relic = conjure(ctx, 'P1', artifact('Anrakyr Relic', 2), 'hand');
    const offered = attack(ctx, self, /Anrakyr Relic/);
    expect(offered).toEqual([]);
    expect(playerById(ctx, 'P1').life).toBe(40);
    expect(onBattlefield(ctx, relic.cardId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Group E: additional costs, cost keywords and reductions
// ---------------------------------------------------------------------------------------------

describe('Toxic Deluge', () => {
  const deluge = pinned('Toxic Deluge');
  const body = (name: string, size: number) =>
    oracle({ name, typeLine: 'Creature — Ooze', power: String(size), toughness: String(size) });

  function ready(seed: string, life = 40) {
    const ctx = pod(seed);
    playerById(ctx, 'P1').life = life;
    const inHand = conjure(ctx, 'P1', deluge.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }, ...generic(2)]);
    return { ctx, inHand };
  }

  const xs = (ctx: GameContext, objectId: string) =>
    castOptionsFor(ctx, 'P1', objectId).map(
      (option) => (option.payload as PriorityActionPayload & { x?: number }).x,
    );

  it('toxic-deluge-pinned-oracle-supported — an announced pay-X-life cost and a -X/-X sweep', () => {
    expect(deluge.sha256).toBe('8d4c686fcd606a82ad2a0dbba2ab363d1b5ca67300bf21b0a3de199ec277cad9');
    expect(deluge.card.oracleText).toBe(
      'As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.',
    );
    expectModeled(deluge.card);
    expect(getOverride(deluge.card.oracleId)).toBeUndefined();
    const def = interpretCard(deluge.card);
    expect(def.announcesX).toBe(true);
    expect(def.spellAdditionalCosts).toEqual([
      { kind: 'payLifeValue', amount: { kind: 'xValue' } },
    ]);
    expect(def.spellAbility?.effects).toEqual([
      {
        op: 'pumpEachUntilEot',
        selector: ofType('Creature'),
        power: { kind: 'negate', of: { kind: 'xValue' } },
        toughness: { kind: 'negate', of: { kind: 'xValue' } },
      },
    ]);
  });

  it('toxic-deluge-pay-x-life-on-cast — X life is paid while casting, before anyone can respond', () => {
    const { ctx, inHand } = ready('deluge-pay');
    const option = castOptionsFor(ctx, 'P1', inHand.id).find(
      (entry) => (entry.payload as PriorityActionPayload & { x?: number }).x === 3,
    );
    expect(option?.description).toMatch(/X=3/);
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    // Paid as a cost (CR 601.2h): already gone with the spell still on the stack.
    expect(playerById(ctx, 'P1').life).toBe(37);
    expect(ctx.state.stack.at(-1)?.announcedX).toBe(3);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  });

  it('toxic-deluge-x-bounded-by-life — X runs from 0 to your life total, never more', () => {
    const { ctx, inHand } = ready('deluge-bound', 2);
    expect(xs(ctx, inHand.id)).toEqual([0, 1, 2]);
  });

  it('toxic-deluge-minus-x-sweep — every creature gets -X/-X until end of turn', () => {
    const { ctx, inHand } = ready('deluge-sweep');
    const small = spawn(ctx, 'P1', body('Deluge Own Ooze', 3));
    const big = spawn(ctx, 'P2', body('Deluge Rival Ooze', 5));
    const option = castOptionsFor(ctx, 'P1', inHand.id).find(
      (entry) => (entry.payload as PriorityActionPayload & { x?: number }).x === 3,
    );
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    expect([
      computeCharacteristics(ctx, big).power,
      computeCharacteristics(ctx, big).toughness,
    ]).toEqual([2, 2]);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.some((perm) => perm.id === small.id)).toBe(false);
    expect(ctx.state.battlefield.some((perm) => perm.id === big.id)).toBe(true);
    endUntilEotEffects(ctx);
    expect([
      computeCharacteristics(ctx, big).power,
      computeCharacteristics(ctx, big).toughness,
    ]).toEqual([5, 5]);
  });

  it('toxic-deluge-x-zero — X=0 costs no life and changes nothing', () => {
    const { ctx, inHand } = ready('deluge-zero');
    const ooze = spawn(ctx, 'P2', body('Deluge Rival Ooze', 1));
    const option = castOptionsFor(ctx, 'P1', inHand.id).find(
      (entry) => (entry.payload as PriorityActionPayload & { x?: number }).x === 0,
    );
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    pump(priorityCheckpoint(ctx));
    expect(playerById(ctx, 'P1').life).toBe(40);
    expect(ctx.state.battlefield.some((perm) => perm.id === ooze.id)).toBe(true);
  });

  it('toxic-deluge-x-needs-an-announced-x — "-X/-X until end of turn" on a card with no announced X is not modeled as one', () => {
    const def = interpretCard(
      oracle({
        name: 'Deluge No X',
        typeLine: 'Sorcery',
        manaCost: '{2}',
        oracleText: 'Creatures get -X/-X until end of turn.',
        power: null,
        toughness: null,
      }),
    );
    expect(def.modeled).toBe(false);
  });

  /** A free search-and-cast of the Deluge from the library (a Sunforger-style effect). */
  function freeCast(ctx: GameContext, answer: Answer) {
    const tutor = spawn(
      ctx,
      'P1',
      oracle({ name: 'Deluge Tutor', typeLine: 'Artifact', power: null, toughness: null }),
    );
    return pump(
      executeAbility(
        ctx,
        { cardId: tutor.cardId, name: tutor.name, oracleId: tutor.oracleId, controllerId: 'P1' },
        {
          kind: 'activated',
          targets: [],
          effects: [{ op: 'searchLibraryCastFree', filter: ofType('Sorcery') }],
        },
        [],
      ),
      answer,
    );
  }

  it('toxic-deluge-free-cast-announces-x — cast without paying its mana cost, X is still announced and paid in life', () => {
    const ctx = pod('deluge-free');
    conjure(ctx, 'P1', deluge.card, 'library');
    const ox = spawn(ctx, 'P2', body('Deluge Free Ox', 3));
    const prompts: string[] = [];
    freeCast(ctx, (decision) => {
      prompts.push(decision.prompt ?? '');
      if (/Choose X/.test(decision.prompt ?? '')) {
        expect(decision.options).toHaveLength(41);
        return { index: 3, targets: new Map() };
      }
      return { index: 0, targets: new Map() };
    });
    expect(prompts.some((prompt) => /Choose X for free-cast Toxic Deluge/.test(prompt))).toBe(true);
    expect(playerById(ctx, 'P1').life).toBe(37);
    expect(ctx.state.stack.at(-1)?.announcedX).toBe(3);
    resolveTop(ctx);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.some((perm) => perm.id === ox.id)).toBe(false);
  });

  it('toxic-deluge-free-cast-respects-cast-bans — a search-and-cast finds nothing while casting is banned', () => {
    const ctx = pod('deluge-free-ban');
    conjure(ctx, 'P1', deluge.card, 'library');
    spawn(
      ctx,
      'P2',
      oracle({
        name: 'Deluge Combat Ban',
        typeLine: 'Enchantment',
        oracleText: "Players can't cast spells during combat.",
        power: null,
        toughness: null,
      }),
    );
    ctx.state.phase = 'combat';
    const { decisions } = freeCast(ctx, () => ({ index: 0, targets: new Map() }));
    expect(decisions).toEqual([]);
    expect(ctx.state.stack).toEqual([]);
    expect(playerById(ctx, 'P1').life).toBe(40);
  });
});

describe('Conclave Tribunal', () => {
  const tribunal = pinned('Conclave Tribunal');
  const soldier = (name: string, colors: ('W' | 'G')[] = []) =>
    oracle({ name, typeLine: 'Creature — Soldier', colors, manaCost: '{1}' });

  const tapped = (ctx: GameContext, perm: EnginePermanent) =>
    ctx.state.battlefield.find((candidate) => candidate.id === perm.id)?.tapped;

  it('conclave-tribunal-pinned-oracle-supported — convoke and an exile-until-it-leaves enters trigger', () => {
    expect(tribunal.sha256).toBe(
      'bead25eae71e919428001104ee03ad6fe6261144a909897511225298eb235fb9',
    );
    expect(tribunal.card.oracleText).toBe(
      "Convoke (Your creatures can help cast this spell. Each creature you tap while casting this spell pays for {1} or one mana of that creature's color.)\nWhen this enchantment enters, exile target nonland permanent an opponent controls until this enchantment leaves the battlefield.",
    );
    expectModeled(tribunal.card);
    expect(getOverride(tribunal.card.oracleId)).toBeUndefined();
    const def = interpretCard(tribunal.card);
    expect(def.ruleStatics).toContainEqual({ kind: 'convoke' });
    expect(def.triggers[0]?.targets).toEqual([
      { kind: 'nonlandPermanent', controller: 'opponent' },
    ]);
    expect(def.triggers[0]?.effects).toEqual([{ op: 'exileUntilSourceLeaves', targetSlot: 0 }]);
  });

  it('conclave-tribunal-convoke-generic — three creatures pay {3} and a Plains pays {W}, summoning sickness and all', () => {
    const ctx = pod('tribunal-generic');
    const land = spawn(ctx, 'P1', plains());
    const crew = [
      spawn(ctx, 'P1', soldier('Tribunal Soldier 1'), { summoningSick: true }),
      spawn(ctx, 'P1', soldier('Tribunal Soldier 2')),
      spawn(ctx, 'P1', soldier('Tribunal Soldier 3')),
    ];
    const inHand = conjure(ctx, 'P1', tribunal.card, 'hand');
    const option = castOptionFor(ctx, 'P1', inHand.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(tapped(ctx, land)).toBe(true);
    expect(crew.every((creature) => tapped(ctx, creature))).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    // Convoke is not mana (CR 702.51b): only the Plains' {W} counts as mana spent.
    expect(ctx.state.stack.at(-1)?.triggerScope?.manaSpent).toBe(1);
  });

  it('conclave-tribunal-convoke-colored — a white creature pays {W}; nonwhite ones cannot', () => {
    const ctx = pod('tribunal-colored');
    for (let i = 1; i <= 4; i++) spawn(ctx, 'P1', soldier(`Tribunal Green ${i}`, ['G']));
    const inHand = conjure(ctx, 'P1', tribunal.card, 'hand');
    expect(castOptionFor(ctx, 'P1', inHand.id)).toBeUndefined();
    spawn(ctx, 'P1', soldier('Tribunal White', ['W']));
    expect(castOptionFor(ctx, 'P1', inHand.id)).toBeDefined();
  });

  it('conclave-tribunal-convoke-taps-once — a mana creature pays once, by mana or by convoke, never both', () => {
    const ctx = pod('tribunal-once');
    spawn(ctx, 'P1', plains());
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Tribunal Elf',
        typeLine: 'Creature — Elf',
        colors: ['G'],
        oracleText: '{T}: Add {G}.',
      }),
    );
    spawn(ctx, 'P1', soldier('Tribunal Soldier'));
    const inHand = conjure(ctx, 'P1', tribunal.card, 'hand');
    // Three permanents can pay three of its four mana.
    expect(castOptionFor(ctx, 'P1', inHand.id)).toBeUndefined();
    spawn(ctx, 'P1', soldier('Tribunal Second Soldier'));
    expect(castOptionFor(ctx, 'P1', inHand.id)).toBeDefined();
  });

  it('conclave-tribunal-convoke-with-a-tap-cost-source — a creature tapped for a Drum cannot also convoke', () => {
    const ctx = pod('tribunal-drum');
    const land = spawn(ctx, 'P1', plains());
    const drum = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Tribunal Drum',
        typeLine: 'Artifact',
        power: null,
        toughness: null,
        oracleText: '{T}, Tap an untapped creature you control: Add one mana of any color.',
      }),
    );
    const crew = [spawn(ctx, 'P1', soldier('Tribunal Soldier 1'))];
    crew.push(spawn(ctx, 'P1', soldier('Tribunal Soldier 2')));
    const inHand = conjure(ctx, 'P1', tribunal.card, 'hand');
    // The Plains, the Drum (tapping one Soldier) and the other Soldier pay three of four.
    expect(castOptionFor(ctx, 'P1', inHand.id)).toBeUndefined();
    crew.push(spawn(ctx, 'P1', soldier('Tribunal Soldier 3')));
    const option = castOptionFor(ctx, 'P1', inHand.id);
    expect(option).toBeDefined();
    const before = ctx.state.eventLog.length;
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect([land, drum, ...crew].every((perm) => tapped(ctx, perm))).toBe(true);
    // Each Soldier is tapped exactly once: one for the Drum's cost, two for convoke.
    const tapEvents = ctx.state.eventLog
      .slice(before)
      .filter((event) => event.type === 'tap' || event.type === 'tapForMana')
      .map((event) => (event.payload as { cardId: string }).cardId);
    expect(new Set(tapEvents).size).toBe(tapEvents.length);
    expect(tapEvents).toHaveLength(5);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
  });

  it('conclave-tribunal-drum-and-elf — a Drum cannot tap the elf that is also paying mana', () => {
    const ctx = pod('drum-elf');
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Drum Only Drum',
        typeLine: 'Artifact',
        power: null,
        toughness: null,
        oracleText: '{T}, Tap an untapped creature you control: Add one mana of any color.',
      }),
    );
    spawn(
      ctx,
      'P1',
      oracle({
        name: 'Drum Elf',
        typeLine: 'Creature — Elf',
        colors: ['G'],
        oracleText: '{T}: Add {G}.',
      }),
    );
    const two = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Drum Two Drop',
        typeLine: 'Artifact',
        manaCost: '{2}',
        power: null,
        toughness: null,
      }),
      'hand',
    );
    expect(castOptionFor(ctx, 'P1', two.id)).toBeUndefined();
  });

  it('conclave-tribunal-drum-planner-scales — a Drum and many mana creatures price a cost just out of reach quickly', () => {
    const ctx = pod('drum-scale');
    for (let i = 0; i < 2; i++)
      spawn(
        ctx,
        'P1',
        oracle({
          name: 'Scale Drum',
          typeLine: 'Artifact',
          power: null,
          toughness: null,
          oracleText: '{T}, Tap an untapped creature you control: Add one mana of any color.',
        }),
      );
    for (let i = 0; i < 8; i++)
      spawn(
        ctx,
        'P1',
        oracle({
          name: `Scale Elf ${i}`,
          typeLine: 'Creature — Elf',
          colors: ['G'],
          oracleText: '{T}: Add {G}.',
        }),
      );
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', forest());
    // Twelve permanents can make twelve mana: each Drum only converts an elf's mana.
    const spell = (name: string, manaCost: string) =>
      conjure(
        ctx,
        'P1',
        oracle({
          name,
          typeLine: 'Sorcery',
          manaCost,
          oracleText: 'Draw a card.',
          power: null,
          toughness: null,
        }),
        'hand',
      );
    const reachable = spell('Scale Twelve', '{11}{G}');
    const beyond = spell('Scale Thirteen', '{12}{G}');
    const started = Date.now();
    expect(castOptionFor(ctx, 'P1', beyond.id)).toBeUndefined();
    expect(castOptionFor(ctx, 'P1', reachable.id)).toBeDefined();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('conclave-tribunal-self-tapping-source — a creature may tap itself for its own tap-a-creature cost', () => {
    const ctx = pod('self-tapper');
    const tapper = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Self Tapper',
        typeLine: 'Creature — Elf',
        colors: ['G'],
        oracleText: 'Tap an untapped creature you control: Add {G}.',
      }),
    );
    const spell = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Tapper Spell',
        typeLine: 'Sorcery',
        manaCost: '{G}',
        oracleText: 'Draw a card.',
        power: null,
        toughness: null,
      }),
      'hand',
    );
    const option = castOptionFor(ctx, 'P1', spell.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(tapper.tapped).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
  });

  it('conclave-tribunal-exile-until-leaves — its enters trigger exiles an opponent’s permanent until it leaves', () => {
    const ctx = pod('tribunal-exile');
    for (let i = 1; i <= 4; i++) spawn(ctx, 'P1', soldier(`Tribunal White ${i}`, ['W']));
    const relic = spawn(
      ctx,
      'P2',
      oracle({ name: 'Tribunal Relic', typeLine: 'Artifact', power: null, toughness: null }),
    );
    spawn(ctx, 'P2', forest());
    const inHand = conjure(ctx, 'P1', tribunal.card, 'hand');
    takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', inHand.id)!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const offered: string[][] = [];
    settle(ctx, (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot === undefined) return { index: 0, targets: new Map() };
      offered.push([...slot.options]);
      return { index: 0, targets: new Map([[slot.slot, relic.id]]) };
    });
    // Nonland and an opponent's: the Relic is the only legal target, so it is chosen unasked;
    // the Forest and P1's own creatures are never offered.
    expect(offered.flat().every((id) => id === relic.id)).toBe(true);
    expect(ctx.state.exile.map((card) => card.cardId)).toContain(relic.cardId);
    const self = ctx.state.battlefield.find((perm) => perm.cardId === inHand.cardId)!;
    pump(moveObject(ctx, self, { zone: 'graveyard' }));
    expect(
      ctx.state.battlefield.some(
        (perm) => perm.cardId === relic.cardId && perm.controllerId === 'P2',
      ),
    ).toBe(true);
  });
});

describe('Hour of Reckoning', () => {
  const hour = pinned('Hour of Reckoning');
  const knight = (name: string, colors: 'W'[] = []) =>
    oracle({ name, typeLine: 'Creature — Knight', colors, manaCost: '{1}' });

  it('hour-of-reckoning-pinned-oracle-supported — convoke and a nontoken-creature wipe', () => {
    expect(hour.sha256).toBe('5eb44a788bb619b66c8ba3006f639178af53b512c0aedf77cbbbcee0c0e8c135');
    expect(hour.card.oracleText).toBe(
      "Convoke (Your creatures can help cast this spell. Each creature you tap while casting this spell pays for {1} or one mana of that creature's color.)\nDestroy all nontoken creatures.",
    );
    expectModeled(hour.card);
    expect(getOverride(hour.card.oracleId)).toBeUndefined();
    const def = interpretCard(hour.card);
    expect(def.ruleStatics).toContainEqual({ kind: 'convoke' });
    expect(def.spellAbility?.effects).toEqual([
      { op: 'destroyEach', selector: allOf(not(IS_TOKEN), ofType('Creature')) },
    ]);
  });

  it('hour-of-reckoning-convoke-seven — seven creatures, three of them white, pay {4}{W}{W}{W}', () => {
    const ctx = pod('hour-convoke');
    const crew = [
      ...[1, 2, 3].map((i) => spawn(ctx, 'P1', knight(`Hour White ${i}`, ['W']))),
      ...[1, 2, 3, 4].map((i) => spawn(ctx, 'P1', knight(`Hour Plain ${i}`))),
    ];
    const inHand = conjure(ctx, 'P1', hour.card, 'hand');
    const option = castOptionFor(ctx, 'P1', inHand.id);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(crew.every((creature) => creature.tapped)).toBe(true);
    expect(ctx.state.stack.at(-1)?.triggerScope?.manaSpent).toBe(0);
  });

  it('hour-of-reckoning-convoke-needs-white — two white creatures cannot pay {W}{W}{W}', () => {
    const ctx = pod('hour-no-white');
    for (let i = 1; i <= 7; i++) spawn(ctx, 'P1', knight(`Hour Plain ${i}`));
    spawn(ctx, 'P1', knight('Hour White 1', ['W']));
    spawn(ctx, 'P1', knight('Hour White 2', ['W']));
    const inHand = conjure(ctx, 'P1', hour.card, 'hand');
    // Nine creatures but only two white: the third {W} has no payer.
    expect(castOptionFor(ctx, 'P1', inHand.id)).toBeUndefined();
    spawn(ctx, 'P1', plains());
    expect(castOptionFor(ctx, 'P1', inHand.id)).toBeDefined();
  });

  it('hour-of-reckoning-destroys-nontoken — every nontoken creature dies, the convokers included; tokens stay', () => {
    const ctx = pod('hour-destroy');
    for (let i = 1; i <= 3; i++) spawn(ctx, 'P1', knight(`Hour White ${i}`, ['W']));
    for (let i = 1; i <= 4; i++) spawn(ctx, 'P1', knight(`Hour Plain ${i}`));
    const token = spawn(ctx, 'P1', knight('Hour Soldier Token', ['W']), { isToken: true });
    const rival = spawn(ctx, 'P2', knight('Hour Rival'));
    const relic = spawn(
      ctx,
      'P2',
      oracle({ name: 'Hour Relic', typeLine: 'Artifact', power: null, toughness: null }),
    );
    const inHand = conjure(ctx, 'P1', hour.card, 'hand');
    takeAction(ctx, 'P1', castOptionFor(ctx, 'P1', inHand.id)!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const names = ctx.state.battlefield.map((perm) => perm.name);
    expect(
      names.filter((name) => name.startsWith('Hour White') || name.startsWith('Hour Plain')),
    ).toEqual([]);
    expect(ctx.state.battlefield.some((perm) => perm.id === rival.id)).toBe(false);
    expect(ctx.state.battlefield.some((perm) => perm.id === token.id)).toBe(true);
    expect(ctx.state.battlefield.some((perm) => perm.id === relic.id)).toBe(true);
  });
});

describe('Changing Loyalty', () => {
  const loyalty = pinned('Changing Loyalty');
  const creature = (name: string) => oracle({ name, typeLine: 'Creature — Ox' });

  function ready(seed: string, mana: number) {
    const ctx = pod(seed);
    const ox = spawn(ctx, 'P2', creature('Loyalty Rival Ox'));
    const bear = spawn(ctx, 'P2', creature('Loyalty Rival Bear'));
    const inHand = conjure(ctx, 'P1', loyalty.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }, ...generic(mana - 1)]);
    return { ctx, ox, bear, inHand };
  }

  const replicates = (option: { payload?: unknown }) =>
    (option.payload as PriorityActionPayload & { optionalCostCount?: number }).optionalCostCount ??
    0;

  /** Cast it with `count` replicate payments targeting `target`. */
  function cast(ctx: GameContext, objectId: string, count: number, target: string) {
    const option = castOptionsFor(ctx, 'P1', objectId).find((entry) => replicates(entry) === count);
    expect(option, `replicate ${count}`).toBeDefined();
    takeAction(
      ctx,
      'P1',
      option!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, target]]),
    );
  }

  const attachedTo = (ctx: GameContext, id: string) =>
    ctx.state.battlefield.filter(
      (perm) => perm.attachedTo === id && perm.name === 'Changing Loyalty',
    );

  it('changing-loyalty-pinned-oracle-supported — flash, replicate {2}, enchant creature, and a steal-on-death trigger', () => {
    expect(loyalty.sha256).toBe('c57a249316e0f083aae223224957ca14c9fd90badb941b38c27ed6c6cab578d0');
    expect(loyalty.card.oracleText).toBe(
      'Flash\nReplicate {2} (When you cast this spell, copy it for each time you paid its replicate cost. You may choose new targets for the copies. Copies become tokens.)\nEnchant creature\nWhen enchanted creature dies, return it to the battlefield under your control.',
    );
    expectModeled(loyalty.card);
    expect(getOverride(loyalty.card.oracleId)).toBeUndefined();
    const def = interpretCard(loyalty.card);
    expect(def.keywords).toContain('flash');
    expect(def.optionalAdditionalCost).toMatchObject({ mechanic: 'replicate', repeatable: true });
    expect(def.spellAbility?.targets).toEqual([{ kind: 'creature' }]);
    expect(def.triggers).toEqual([
      expect.objectContaining({
        trigger: {
          when: 'dies',
          subject: { kind: 'permanent', selector: { kind: 'attachedToSource' } },
        },
        effects: [{ op: 'graveyardToBattlefield', target: 'triggerObject' }],
      }),
    ]);
  });

  it('changing-loyalty-replicate-counts — each affordable number of replicate payments is offered', () => {
    const { ctx, inHand } = ready('loyalty-counts', 6);
    // {1}{B} plus {2} per copy: six mana pays for up to two copies.
    expect(castOptionsFor(ctx, 'P1', inHand.id).map(replicates)).toEqual([0, 1, 2]);
  });

  it('changing-loyalty-copies-become-aura-tokens — a replicated copy chooses a new target and resolves into an Aura token', () => {
    const { ctx, ox, bear, inHand } = ready('loyalty-copy', 4);
    cast(ctx, inHand.id, 1, ox.id);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    // The replicate trigger is on the stack above the spell; its copy retargets the Bear.
    const prompts: string[] = [];
    settle(ctx, (decision) => {
      prompts.push(decision.prompt ?? '');
      return optionMatching(decision, /Target Loyalty Rival Bear/);
    });
    expect(prompts).toContain('Changing Loyalty: choose a target for copy 1 of 1.');
    const onOx = attachedTo(ctx, ox.id);
    const onBear = attachedTo(ctx, bear.id);
    expect(onOx).toHaveLength(1);
    expect(onOx[0]?.isToken).toBe(false);
    expect(onBear).toHaveLength(1);
    expect(onBear[0]?.isToken).toBe(true);
    expect(onBear[0]?.controllerId).toBe('P1');
    // A copy of a permanent spell is not "created" (CR 608.3f).
    expect(ctx.state.eventLog.some((event) => event.type === 'tokenCreated')).toBe(false);
  });

  it('changing-loyalty-copy-triggers-ward — a copy retargeted onto a ward creature is countered unless ward is paid', () => {
    const { ctx, ox, inHand } = ready('loyalty-ward', 4);
    const warded = spawn(
      ctx,
      'P2',
      oracle({ name: 'Loyalty Warded Wolf', typeLine: 'Creature — Wolf', oracleText: 'Ward {2}' }),
    );
    cast(ctx, inHand.id, 1, ox.id);
    // P1 has no mana left, so the copy aimed at the warded Wolf cannot pay for ward.
    settle(ctx, (decision) =>
      /choose a target for copy/.test(decision.prompt ?? '')
        ? optionMatching(decision, /Target Loyalty Warded Wolf/)
        : { index: decision.options.length - 1, targets: new Map() },
    );
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'counterSpell' || event.type === 'unlessNotPaid',
      ),
    ).toBe(true);
    expect(attachedTo(ctx, warded.id)).toEqual([]);
    expect(attachedTo(ctx, ox.id)).toHaveLength(1);
  });

  it('changing-loyalty-copy-may-keep-its-target — the copy may keep the original target', () => {
    const { ctx, ox, inHand } = ready('loyalty-keep', 4);
    cast(ctx, inHand.id, 1, ox.id);
    settle(ctx, (decision) => optionMatching(decision, /Keep Loyalty Rival Ox/));
    expect(attachedTo(ctx, ox.id)).toHaveLength(2);
  });

  it('changing-loyalty-copies-use-last-known-information — the copies are created even if the original left the stack', () => {
    const { ctx, ox, bear, inHand } = ready('loyalty-lki', 4);
    cast(ctx, inHand.id, 1, ox.id);
    // Counter the original before the replicate trigger resolves.
    const original = ctx.state.stack.findIndex((entry) => entry.card?.cardId === inHand.cardId);
    expect(original).toBeGreaterThanOrEqual(0);
    ctx.state.stack.splice(original, 1);
    settle(ctx, (decision) => optionMatching(decision, /Target Loyalty Rival Bear/));
    expect(attachedTo(ctx, bear.id)).toEqual([expect.objectContaining({ isToken: true })]);
    expect(attachedTo(ctx, ox.id)).toEqual([]);
  });

  it("changing-loyalty-steals-on-death — when the enchanted opponent's creature dies, it returns under your control", () => {
    const { ctx, ox, inHand } = ready('loyalty-steal', 2);
    cast(ctx, inHand.id, 0, ox.id);
    settle(ctx);
    expect(attachedTo(ctx, ox.id)).toHaveLength(1);
    pump(moveObject(ctx, ox, { zone: 'graveyard' }));
    settle(ctx);
    const returned = ctx.state.battlefield.find((perm) => perm.cardId === ox.cardId);
    expect(returned?.controllerId).toBe('P1');
    expect(returned?.ownerId).toBe('P2');
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toEqual([]);
    // The Aura itself went to the graveyard once its creature left (CR 704.5m).
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.name)).toEqual(['Changing Loyalty']);
  });

  it('changing-loyalty-token-copy-steals-too — an Aura token from replicate has the same trigger', () => {
    const { ctx, ox, bear, inHand } = ready('loyalty-token-steal', 4);
    cast(ctx, inHand.id, 1, ox.id);
    settle(ctx, (decision) => optionMatching(decision, /Target Loyalty Rival Bear/));
    const token = attachedTo(ctx, bear.id)[0]!;
    pump(moveObject(ctx, bear, { zone: 'graveyard' }));
    settle(ctx);
    expect(ctx.state.battlefield.find((perm) => perm.cardId === bear.cardId)?.controllerId).toBe(
      'P1',
    );
    // The token Aura ceased to exist rather than sitting in a graveyard (CR 704.5d).
    expect(ctx.state.battlefield.some((perm) => perm.cardId === token.cardId)).toBe(false);
    expect(playerById(ctx, 'P1').graveyard).toEqual([]);
  });

  it('changing-loyalty-flash — it can be cast on an opponent’s turn', () => {
    const { ctx, ox, inHand } = ready('loyalty-flash', 2);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    cast(ctx, inHand.id, 0, ox.id);
    settle(ctx);
    expect(attachedTo(ctx, ox.id)).toHaveLength(1);
  });

  it('changing-loyalty-unattached-death-does-nothing — another creature dying does not trigger it', () => {
    const { ctx, ox, bear, inHand } = ready('loyalty-other', 2);
    cast(ctx, inHand.id, 0, ox.id);
    settle(ctx);
    pump(moveObject(ctx, bear, { zone: 'graveyard' }));
    settle(ctx);
    expect(playerById(ctx, 'P2').graveyard.map((card) => card.name)).toEqual([
      'Loyalty Rival Bear',
    ]);
    expect(attachedTo(ctx, ox.id)).toHaveLength(1);
  });
});

describe('Grim Haruspex', () => {
  const haruspex = pinned('Grim Haruspex');
  const FACE_DOWN = /^Cast Grim Haruspex face down for \{3\}$/;
  const creature = (name: string) => oracle({ name, typeLine: 'Creature — Soldier' });

  function ready(seed: string) {
    const ctx = pod(seed);
    const inHand = conjure(ctx, 'P1', haruspex.card, 'hand');
    addMana(playerById(ctx, 'P1'), generic(3));
    return { ctx, inHand };
  }

  /** Cast it face down and let the spell resolve; returns the face-down permanent. */
  function faceDown(ctx: GameContext, objectId: string) {
    const cardId = playerById(ctx, 'P1').hand.find((card) => card.id === objectId)!.cardId;
    const option = castOptionsFor(ctx, 'P1', objectId).find((entry) =>
      FACE_DOWN.test(entry.description),
    );
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    return ctx.state.battlefield.find((perm) => perm.cardId === cardId)!;
  }

  const turnUp = (ctx: GameContext, perm: EnginePermanent) =>
    priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as { kind: string; objectId?: string };
      return payload.kind === 'turnFaceUp' && payload.objectId === perm.id;
    });

  it('grim-haruspex-pinned-oracle-supported — morph {B} and a draw on another nontoken creature dying', () => {
    expect(haruspex.sha256).toBe(
      'a82c1aeef591b7eaeb584f94d66076ac45cfafde3a65de88cdb36f4ae14866ef',
    );
    expect(haruspex.card.oracleText).toBe(
      'Morph {B} (You may cast this card face down as a 2/2 creature for {3}. Turn it face up any time for its morph cost.)\nWhenever another nontoken creature you control dies, draw a card.',
    );
    expectModeled(haruspex.card);
    expect(getOverride(haruspex.card.oracleId)).toBeUndefined();
    const def = interpretCard(haruspex.card);
    expect(def.morphCost).toEqual(parseManaCost('{B}').cost);
    expect(def.triggers).toEqual([
      expect.objectContaining({
        trigger: {
          when: 'dies',
          subject: {
            kind: 'permanent',
            selector: allOf({ kind: 'other' }, not(IS_TOKEN), YOURS_SELECTOR, ofType('Creature')),
          },
        },
        effects: [{ op: 'draw', count: constant(1) }],
      }),
    ]);
  });

  it('grim-haruspex-face-down-cast — {3} casts it face down as a vanilla 2/2 creature spell', () => {
    const { ctx, inHand } = ready('haruspex-cast');
    const option = castOptionsFor(ctx, 'P1', inHand.id).find((entry) =>
      FACE_DOWN.test(entry.description),
    );
    expect(option?.data?.['publicDescription']).toBe('Cast a face-down creature spell for {3}');
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    const spell = ctx.state.stack.at(-1)!;
    expect(spell.description).toBe('Face-down creature spell');
    const spellDef = ctx.defs.get(spell.sourceOracleId)!;
    expect(spellDef).toMatchObject({ types: ['Creature'], colors: [], power: 2, toughness: 2 });
    expect(spellDef.triggers).toEqual([]);
    expect(ctx.state.eventLog.find((event) => event.type === 'castSpell')?.payload['name']).toBe(
      'Face-down creature spell',
    );
    // No other player can learn what it is.
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain('Grim Haruspex');
    resolveTop(ctx);
    const perm = ctx.state.battlefield.find((candidate) => candidate.cardId === inHand.cardId)!;
    expect(perm.faceDown).toBe(true);
    expect(effectivePT(ctx, perm)).toEqual({ power: 2, toughness: 2 });
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain('Grim Haruspex');
  });

  it('grim-haruspex-face-down-stays-nameless — targeting and damaging it never names it', () => {
    const { ctx, inHand } = ready('haruspex-nameless');
    const perm = faceDown(ctx, inHand.id);
    expect(perm.name).toBe('Face-down permanent');
    const ping = conjure(
      ctx,
      'P2',
      oracle({
        name: 'Haruspex Rival Ping',
        typeLine: 'Instant',
        manaCost: '{R}',
        colors: ['R'],
        oracleText: 'Haruspex Rival Ping deals 1 damage to any target.',
        power: null,
        toughness: null,
      }),
      'hand',
    );
    addMana(playerById(ctx, 'P2'), [{ symbol: 'R' }]);
    takeAction(
      ctx,
      'P2',
      castOptionsFor(ctx, 'P2', ping.id)[0]!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, perm.id]]),
    );
    resolveTop(ctx);
    expect(perm.damageMarked).toBe(1);
    expect(JSON.stringify(ctx.state.eventLog)).not.toContain('Grim Haruspex');
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).not.toContain('Grim Haruspex');
    // Turned face up, it has its name again.
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }]);
    takeAction(ctx, 'P1', turnUp(ctx, perm)!.payload as PriorityActionPayload);
    expect(perm.name).toBe('Grim Haruspex');
    expect(JSON.stringify(buildPlayerView(ctx, 'P2'))).toContain('Grim Haruspex');
  });

  it('grim-haruspex-face-down-sorcery-speed — the face-down cast is not offered at instant speed', () => {
    const { ctx, inHand } = ready('haruspex-instant');
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(castOptionsFor(ctx, 'P1', inHand.id)).toEqual([]);
  });

  it('grim-haruspex-face-down-has-no-abilities — face down, another creature dying draws nothing', () => {
    const { ctx, inHand } = ready('haruspex-silent');
    faceDown(ctx, inHand.id);
    const soldier = spawn(ctx, 'P1', creature('Haruspex Soldier'));
    const hand = playerById(ctx, 'P1').hand.length;
    pump(moveObject(ctx, soldier, { zone: 'graveyard' }));
    settle(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(hand);
  });

  it('grim-haruspex-turn-face-up — {B} turns it face up as a special action, keeping its status', () => {
    const { ctx, inHand } = ready('haruspex-up');
    const perm = faceDown(ctx, inHand.id);
    perm.tapped = true;
    perm.damageMarked = 1;
    expect(turnUp(ctx, perm)).toBeUndefined();
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }]);
    // Any time you have priority — on an opponent's turn too.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    const option = turnUp(ctx, perm);
    expect(option?.description).toBe('Turn Grim Haruspex face up ({B})');
    expect(option?.data?.['publicDescription']).toBe('Turn a face-down permanent face up');
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(perm.faceDown).toBe(false);
    expect(perm.tapped).toBe(true);
    expect(perm.damageMarked).toBe(1);
    expect(effectivePT(ctx, perm)).toEqual({ power: 3, toughness: 2 });
    // A special action: nothing went on the stack, and it did not enter the battlefield again.
    expect(ctx.state.stack).toEqual([]);
    expect(ctx.state.pendingTriggers).toEqual([]);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    expect(turnUp(ctx, perm)).toBeUndefined();
  });

  it('grim-haruspex-draws-face-up — face up, another nontoken creature you control dying draws a card', () => {
    const { ctx, inHand } = ready('haruspex-draws');
    const perm = faceDown(ctx, inHand.id);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }]);
    takeAction(ctx, 'P1', turnUp(ctx, perm)!.payload as PriorityActionPayload);
    const soldier = spawn(ctx, 'P1', creature('Haruspex Soldier'));
    const token = spawn(ctx, 'P1', creature('Haruspex Token'), { isToken: true });
    const rival = spawn(ctx, 'P2', creature('Haruspex Rival'));
    const hand = playerById(ctx, 'P1').hand.length;
    for (const dying of [token, rival]) pump(moveObject(ctx, dying, { zone: 'graveyard' }));
    settle(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(hand);
    pump(moveObject(ctx, soldier, { zone: 'graveyard' }));
    settle(ctx);
    expect(playerById(ctx, 'P1').hand).toHaveLength(hand + 1);
  });

  it('grim-haruspex-normal-cast — it can still be cast face up for {2}{B}', () => {
    const ctx = pod('haruspex-normal');
    const inHand = conjure(ctx, 'P1', haruspex.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }, ...generic(2)]);
    const normal = castOptionsFor(ctx, 'P1', inHand.id).find((entry) =>
      /^Cast Grim Haruspex \(\{2\}\{B\}\)$/.test(entry.description),
    );
    takeAction(ctx, 'P1', normal!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const perm = ctx.state.battlefield.find((candidate) => candidate.cardId === inHand.cardId)!;
    expect(perm.faceDown).not.toBe(true);
    expect(turnUp(ctx, perm)).toBeUndefined();
  });

  it('grim-haruspex-public-log — other seats read a face-down cast by its public description', () => {
    const event = {
      sequence: 1,
      turn: 1,
      phase: 'precombatMain',
      step: null,
      actorSeat: 'P1',
      type: 'decision',
      payload: {
        decisionType: 'priority',
        description: 'Cast Grim Haruspex face down for {3}',
        publicDescription: 'Cast a face-down creature spell for {3}',
      },
    } as GameEvent;
    expect(formatPlayerLog([event], 'P2').map((line) => line.text)).toEqual([
      'Cast a face-down creature spell for {3}',
    ]);
    expect(formatPlayerLog([event], 'P1').map((line) => line.text)).toEqual([
      'Cast Grim Haruspex face down for {3}',
    ]);
  });
});

describe('Dream Devourer', () => {
  const devourer = pinned('Dream Devourer');
  const BOLT = oracle({
    name: 'Devourer Lab Bolt',
    typeLine: 'Instant',
    manaCost: '{2}{R}',
    colors: ['R'],
    oracleText: 'Devourer Lab Bolt deals 2 damage to any target.',
    power: null,
    toughness: null,
  });
  const GREEN = oracle({
    name: 'Devourer Lab Growth',
    typeLine: 'Sorcery',
    manaCost: '{1}{G}{G}',
    colors: ['G'],
    oracleText: 'Draw a card.',
    power: null,
    toughness: null,
  });

  function ready(seed: string) {
    const ctx = pod(seed);
    const self = spawn(ctx, 'P1', devourer.card);
    const bolt = conjure(ctx, 'P1', BOLT, 'hand');
    const land = conjure(ctx, 'P1', forest(), 'hand');
    return { ctx, self, bolt, land };
  }

  const foretellOf = (ctx: GameContext, objectId: string) =>
    priorityOptions(ctx, 'P1').find((option) => {
      const payload = option.payload as { kind: string; objectId?: string };
      return payload.kind === 'foretell' && payload.objectId === objectId;
    });

  /** Foretell `objectId` now; returns the face-down exiled card. */
  function foretell(ctx: GameContext, objectId: string, cardId: string) {
    addMana(playerById(ctx, 'P1'), generic(2));
    takeAction(ctx, 'P1', foretellOf(ctx, objectId)!.payload as PriorityActionPayload);
    return ctx.state.exile.find((card) => card.cardId === cardId)!;
  }

  /** Move to P1's next turn, so foretold cards become castable. */
  function nextTurn(ctx: GameContext) {
    ctx.state.turnNumber += 4;
  }

  it('dream-devourer-pinned-oracle-supported — a foretell grant and a +2/+0 trigger on foretelling', () => {
    expect(devourer.sha256).toBe(
      'daf65f95778453b46ca292c449635ae2451bb6a70b5133f712dc759774a74fc0',
    );
    expect(devourer.card.oracleText).toBe(
      'Each nonland card in your hand without foretell has foretell. Its foretell cost is equal to its mana cost reduced by {2}. (During your turn, you may pay {2} and exile it from your hand face down. Cast it on a later turn for its foretell cost.)\nWhenever you foretell a card, this creature gets +2/+0 until end of turn.',
    );
    expectModeled(devourer.card);
    expect(getOverride(devourer.card.oracleId)).toBeUndefined();
    const def = interpretCard(devourer.card);
    expect(def.ruleStatics).toEqual([{ kind: 'grantForetell', reduction: 2 }]);
    expect(def.triggers).toEqual([
      expect.objectContaining({
        trigger: { when: 'foretells', player: 'you' },
        effects: [{ op: 'pumpEachUntilEot', selector: { kind: 'self' }, power: 2, toughness: 0 }],
      }),
    ]);
  });

  it('dream-devourer-foretell-offered — on your turn, each nonland hand card may be foretold for {2}', () => {
    const { ctx, bolt, land } = ready('devourer-offered');
    addMana(playerById(ctx, 'P1'), generic(2));
    const option = foretellOf(ctx, bolt.id);
    expect(option?.description).toBe('Foretell Devourer Lab Bolt ({2})');
    expect(option?.data?.['publicDescription']).toBe('Foretell a card ({2})');
    expect(foretellOf(ctx, land.id)).toBeUndefined();
    // Not on an opponent's turn.
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(foretellOf(ctx, bolt.id)).toBeUndefined();
  });

  it('dream-devourer-needs-devourer — without it, nothing has foretell', () => {
    const ctx = pod('devourer-none');
    const bolt = conjure(ctx, 'P1', BOLT, 'hand');
    addMana(playerById(ctx, 'P1'), generic(2));
    expect(foretellOf(ctx, bolt.id)).toBeUndefined();
  });

  it('dream-devourer-foretell-face-down — the card is exiled face down, hidden from others, and the Devourer gets +2/+0', () => {
    const { ctx, self, bolt } = ready('devourer-exile');
    const exiled = foretell(ctx, bolt.id, bolt.cardId);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    expect(exiled.foretold).toEqual({
      turn: ctx.state.turnNumber,
      cost: parseManaCost('{R}').cost,
    });
    // A special action: nothing on the stack except the Devourer's own trigger.
    expect(ctx.state.stack).toEqual([]);
    const opponentView = JSON.stringify(buildPlayerView(ctx, 'P2'));
    expect(opponentView).not.toContain('Devourer Lab Bolt');
    expect(opponentView).toContain('Face-down card');
    expect(JSON.stringify(buildPlayerView(ctx, 'P1'))).toContain('Devourer Lab Bolt');
    expect(
      ctx.state.eventLog.some((event) => JSON.stringify(event).includes('Devourer Lab Bolt')),
    ).toBe(false);
    settle(ctx);
    expect(effectivePT(ctx, self)).toEqual({ power: 2, toughness: 3 });
  });

  it('dream-devourer-cast-later-turn — a foretold card is cast only on a later turn, for its foretell cost', () => {
    const { ctx, bolt } = ready('devourer-cast');
    const exiled = foretell(ctx, bolt.id, bolt.cardId);
    settle(ctx);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }]);
    expect(castOptionsFor(ctx, 'P1', exiled.id)).toEqual([]);
    nextTurn(ctx);
    const options = castOptionsFor(ctx, 'P1', exiled.id);
    expect(options.map((option) => option.description)).toEqual([
      'Cast Devourer Lab Bolt ({R}) (foretold)',
    ]);
    takeAction(
      ctx,
      'P1',
      options[0]!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, 'P2']]),
    );
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    resolveTop(ctx);
    expect(playerById(ctx, 'P2').life).toBe(38);
    expect(ctx.state.exile.some((card) => card.cardId === bolt.cardId)).toBe(false);
  });

  it('dream-devourer-colored-cost-stays — the reduction takes only generic mana', () => {
    const { ctx } = ready('devourer-colored');
    const growth = conjure(ctx, 'P1', GREEN, 'hand');
    const exiled = foretell(ctx, growth.id, growth.cardId);
    expect(exiled.foretold?.cost).toEqual(parseManaCost('{G}{G}').cost);
    nextTurn(ctx);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }]);
    expect(castOptionsFor(ctx, 'P1', exiled.id)).toEqual([]);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }]);
    expect(castOptionsFor(ctx, 'P1', exiled.id).map((option) => option.description)).toEqual([
      'Cast Devourer Lab Growth ({G}{G}) (foretold)',
    ]);
  });

  it('dream-devourer-foretold-only-foretell-cost — a foretold card is not offered another alternative cost', () => {
    const { ctx } = ready('devourer-no-alternative');
    const free = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Devourer Free Bolt',
        typeLine: 'Instant',
        manaCost: '{2}{R}',
        colors: ['R'],
        oracleText:
          'Devourer Free Bolt deals 2 damage to any target.\nIf you control a commander, you may cast this spell without paying its mana cost.',
        power: null,
        toughness: null,
      }),
      'hand',
    );
    const exiled = foretell(ctx, free.id, free.cardId);
    settle(ctx);
    nextTurn(ctx);
    spawn(ctx, 'P1', oracle({ name: 'Devourer Commander', typeLine: 'Legendary Creature — Elf' }), {
      isCommander: true,
    });
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }]);
    const options = castOptionsFor(ctx, 'P1', exiled.id);
    expect(options.map((option) => option.description)).toEqual([
      'Cast Devourer Free Bolt ({R}) (foretold)',
    ]);
    takeAction(
      ctx,
      'P1',
      options[0]!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, 'P2']]),
    );
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
  });

  it('dream-devourer-cost-kept-without-it — the foretell cost stays after the Devourer leaves', () => {
    const { ctx, self, bolt } = ready('devourer-gone');
    const exiled = foretell(ctx, bolt.id, bolt.cardId);
    settle(ctx);
    pump(moveObject(ctx, self, { zone: 'graveyard' }));
    nextTurn(ctx);
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }]);
    expect(castOptionsFor(ctx, 'P1', exiled.id).map((option) => option.description)).toEqual([
      'Cast Devourer Lab Bolt ({R}) (foretold)',
    ]);
  });
});

describe('Killian, Ink Duelist', () => {
  const killian = pinned('Killian, Ink Duelist');
  const SHOCK = oracle({
    name: 'Killian Lab Shock',
    typeLine: 'Instant',
    manaCost: '{2}{R}',
    colors: ['R'],
    oracleText: 'Killian Lab Shock deals 2 damage to any target.',
    power: null,
    toughness: null,
  });
  const BEAR = oracle({
    name: 'Killian Lab Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{2}{G}',
  });

  function ready(seed: string) {
    const ctx = pod(seed);
    spawn(ctx, 'P1', killian.card);
    const ox = spawn(ctx, 'P2', oracle({ name: 'Killian Rival Ox', typeLine: 'Creature — Ox' }));
    return { ctx, ox };
  }

  const payloadOf = (option: { payload?: unknown }) =>
    option.payload as PriorityActionPayload & { targetReductionSlot?: number };

  it('killian-ink-duelist-pinned-oracle-supported — lifelink, menace, and a target-dependent reduction', () => {
    expect(killian.sha256).toBe('dc5a598c8b1bda5db8590ef9abe9f717f4d02dd5b97c0900aeec62a96e21e1e2');
    expect(killian.card.oracleText).toBe(
      "Lifelink\nMenace (This creature can't be blocked except by two or more creatures.)\nSpells you cast that target a creature cost {2} less to cast.",
    );
    expectModeled(killian.card);
    expect(getOverride(killian.card.oracleId)).toBeUndefined();
    const def = interpretCard(killian.card);
    expect(def.keywords).toEqual(expect.arrayContaining(['lifelink', 'menace']));
    expect(def.ruleStatics).toEqual([
      { kind: 'costReduction', amount: constant(2), targetFilter: ofType('Creature') },
    ]);
  });

  it('killian-ink-duelist-targeting-a-creature — a spell targeting a creature costs {2} less', () => {
    const { ctx, ox } = ready('killian-creature');
    const shock = conjure(ctx, 'P1', SHOCK, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }]);
    const options = castOptionsFor(ctx, 'P1', shock.id);
    // Only {R}: just the reduced option, and it can only target a creature.
    expect(options.map((option) => payloadOf(option).targetReductionSlot)).toEqual([0]);
    expect(options[0]?.description).toMatch(/\(\{R\}\)/);
    expect(options[0]?.targets?.[0]?.options).toEqual(expect.arrayContaining([ox.id]));
    expect(options[0]?.targets?.[0]?.options).not.toContain('P2');
    takeAction(
      ctx,
      'P1',
      options[0]!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, ox.id]]),
    );
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    resolveTop(ctx);
    expect(ox.damageMarked).toBe(2);
  });

  it('killian-ink-duelist-targeting-a-player — targeting a player pays full price', () => {
    const { ctx } = ready('killian-player');
    const shock = conjure(ctx, 'P1', SHOCK, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }, ...generic(2)]);
    const full = castOptionsFor(ctx, 'P1', shock.id).find(
      (option) => payloadOf(option).targetReductionSlot === -1,
    );
    expect(full?.description).toMatch(/\{2\}\{R\}/);
    expect(full?.targets?.[0]?.options).toContain('P2');
    expect(full?.targets?.[0]?.options.some((id) => id.startsWith('o-'))).toBe(false);
    takeAction(ctx, 'P1', full!.payload as PriorityActionPayload, undefined, new Map([[0, 'P2']]));
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    resolveTop(ctx);
    expect(playerById(ctx, 'P2').life).toBe(38);
  });

  it('killian-ink-duelist-untargeted-spells-full-price — a creature spell that targets nothing gets no reduction', () => {
    const { ctx } = ready('killian-bear');
    const bear = conjure(ctx, 'P1', BEAR, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'G' }]);
    expect(castOptionsFor(ctx, 'P1', bear.id)).toEqual([]);
    addMana(playerById(ctx, 'P1'), generic(2));
    expect(castOptionsFor(ctx, 'P1', bear.id).map((option) => option.description)).toEqual([
      expect.stringMatching(/\{2\}\{G\}/),
    ]);
  });

  it('killian-ink-duelist-modal-second-slot — a mode whose target is spec slot 1 is reduced and applies', () => {
    const { ctx, ox } = ready('killian-modal');
    const charm = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Killian Lab Charm',
        typeLine: 'Instant',
        manaCost: '{2}{B}',
        colors: ['B'],
        oracleText: 'Choose one —\n• Target player loses 1 life.\n• Destroy target creature.',
        power: null,
        toughness: null,
      }),
      'hand',
    );
    addMana(playerById(ctx, 'P1'), [{ symbol: 'B' }]);
    const options = castOptionsFor(ctx, 'P1', charm.id);
    expect(options).toHaveLength(1);
    const reduced = options[0]!;
    expect(reduced.description).toMatch(/\(\{B\}\).*Destroy target creature.*reduced/);
    // The slot is the spec slot the destroy mode uses, the one the cast validates against.
    expect(reduced.targets?.[0]?.slot).toBe(1);
    expect(payloadOf(reduced).targetReductionSlot).toBe(1);
    takeAction(
      ctx,
      'P1',
      reduced.payload as PriorityActionPayload,
      undefined,
      new Map([[1, ox.id]]),
    );
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.id === ox.id)).toBe(false);
  });

  it('killian-ink-duelist-flashback — a flashback cast targeting a creature is offered and charged {2} less', () => {
    const { ctx, ox } = ready('killian-flashback');
    const flash = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Killian Lab Flash',
        typeLine: 'Instant',
        manaCost: '{1}{R}',
        colors: ['R'],
        oracleText:
          'Killian Lab Flash deals 2 damage to target creature.\nFlashback {3}{R} (You may cast this card from your graveyard for its flashback cost. Then exile it.)',
        power: null,
        toughness: null,
      }),
      'graveyard',
    );
    // {1}{R} pays only the reduced flashback cost.
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }, ...generic(1)]);
    const options = castOptionsFor(ctx, 'P1', flash.id);
    expect(options.map((option) => option.description)).toEqual([
      expect.stringMatching(
        /\(\{1\}\{R\}\) \(alternate cost\) from your graveyard — reduced for its target/,
      ),
    ]);
    takeAction(
      ctx,
      'P1',
      options[0]!.payload as PriorityActionPayload,
      undefined,
      new Map([[0, ox.id]]),
    );
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    resolveTop(ctx);
    expect(ox.damageMarked).toBe(2);
  });

  it('killian-ink-duelist-only-yours — an opponent’s Killian does not reduce your spells', () => {
    const ctx = pod('killian-opponent');
    spawn(ctx, 'P2', killian.card);
    const ox = spawn(ctx, 'P2', oracle({ name: 'Killian Rival Ox', typeLine: 'Creature — Ox' }));
    const shock = conjure(ctx, 'P1', SHOCK, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }]);
    expect(castOptionsFor(ctx, 'P1', shock.id)).toEqual([]);
    expect(ox.damageMarked).toBe(0);
  });
});

describe('Dragonkin Berserker', () => {
  const berserker = pinned('Dragonkin Berserker');
  const BOAST = /Create a 5\/5 red Dragon/;
  const dragon = (name: string) =>
    oracle({ name, typeLine: 'Creature — Dragon', colors: ['R'], power: '4', toughness: '4' });

  function ready(seed: string, dragons = 0) {
    const ctx = pod(seed);
    const self = spawn(ctx, 'P1', berserker.card);
    for (let i = 1; i <= dragons; i++) spawn(ctx, 'P1', dragon(`Berserker Dragon ${i}`));
    return { ctx, self };
  }

  it('dragonkin-berserker-pinned-oracle-supported — first strike, a Boast ability, and a Boast reduction', () => {
    expect(berserker.sha256).toBe(
      '2ad5ad892794762553614df0cd73da106fe1c7e09c0aee7106dd925e95f1dab6',
    );
    expect(berserker.card.oracleText).toBe(
      'First strike\nBoast abilities you activate cost {1} less to activate for each Dragon you control.\nBoast — {4}{R}: Create a 5/5 red Dragon creature token with flying. (Activate only if this creature attacked this turn and only once each turn.)',
    );
    expectModeled(berserker.card);
    expect(getOverride(berserker.card.oracleId)).toBeUndefined();
    const def = interpretCard(berserker.card);
    expect(def.keywords).toContain('first strike');
    expect(def.activatedAbilities[0]).toMatchObject({
      requiresAttackedThisTurn: true,
      oncePerTurn: true,
      boast: true,
    });
    expect(def.ruleStatics).toEqual([
      expect.objectContaining({ kind: 'costReduction', appliesTo: 'activate', boastOnly: true }),
    ]);
  });

  it('dragonkin-berserker-boast-needs-attack — Boast is offered only after it attacked this turn', () => {
    const { ctx, self } = ready('berserker-attack');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }, ...generic(4)]);
    expect(activationMatching(ctx, 'P1', self, BOAST)).toBeUndefined();
    self.attackedThisTurn = true;
    expect(activationMatching(ctx, 'P1', self, BOAST)).toBeDefined();
  });

  it('dragonkin-berserker-boast-once-each-turn — a second Boast the same turn is not offered', () => {
    const { ctx, self } = ready('berserker-once');
    self.attackedThisTurn = true;
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }, { symbol: 'R' }, ...generic(8)]);
    takeAction(
      ctx,
      'P1',
      activationMatching(ctx, 'P1', self, BOAST)!.payload as PriorityActionPayload,
    );
    resolveTop(ctx);
    expect(ctx.state.battlefield.filter((perm) => perm.name === 'Dragon')).toHaveLength(1);
    expect(activationMatching(ctx, 'P1', self, BOAST)).toBeUndefined();
  });

  it('dragonkin-berserker-boast-reduction-per-dragon — two Dragons make its Boast cost {2}{R}', () => {
    const { ctx, self } = ready('berserker-reduce', 2);
    self.attackedThisTurn = true;
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }, ...generic(1)]);
    expect(activationMatching(ctx, 'P1', self, BOAST)).toBeUndefined();
    addMana(playerById(ctx, 'P1'), generic(1));
    const option = activationMatching(ctx, 'P1', self, BOAST);
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
  });

  it('dragonkin-berserker-only-boast-abilities — an "activate only if it attacked" ability that is not Boast is not reduced', () => {
    const { ctx } = ready('berserker-not-boast', 1);
    const raider = spawn(
      ctx,
      'P1',
      oracle({ name: 'Berserker Raider', typeLine: 'Creature — Warrior' }),
    );
    const notBoast: ActivatedAbility = {
      costs: [{ kind: 'mana', cost: parseManaCost('{2}').cost! }],
      timing: 'any',
      requiresAttackedThisTurn: true,
      ability: { kind: 'activated', targets: [], effects: [] },
    };
    expect(
      activationCostReductionFor(ctx, 'P1', raider.oracleId, raider.cardId, notBoast).generic,
    ).toBe(0);
    expect(
      activationCostReductionFor(ctx, 'P1', raider.oracleId, raider.cardId, {
        ...notBoast,
        boast: true,
      }).generic,
    ).toBe(1);
  });

  it('dragonkin-berserker-reduces-other-boasts-only — another creature’s Boast is reduced; non-Boast abilities are not', () => {
    const { ctx } = ready('berserker-other', 1);
    const boaster = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Berserker Other Boaster',
        typeLine: 'Creature — Warrior',
        oracleText: 'Boast — {2}: You gain 2 life.',
      }),
    );
    const altar = spawn(
      ctx,
      'P1',
      oracle({
        name: 'Berserker Plain Altar',
        typeLine: 'Artifact',
        oracleText: '{1}: You gain 1 life.',
        power: null,
        toughness: null,
      }),
    );
    boaster.attackedThisTurn = true;
    addMana(playerById(ctx, 'P1'), generic(1));
    // One Dragon: the other creature's {2} Boast costs {1}, and the plain {1} stays {1}.
    expect(activationMatching(ctx, 'P1', boaster, /gain 2 life/)).toBeDefined();
    expect(activationMatching(ctx, 'P1', altar, /gain 1 life/)).toBeDefined();
    takeAction(
      ctx,
      'P1',
      activationMatching(ctx, 'P1', boaster, /gain 2 life/)!.payload as PriorityActionPayload,
    );
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    expect(activationMatching(ctx, 'P1', altar, /gain 1 life/)).toBeUndefined();
  });
});

describe('Convergence of Dominion', () => {
  const convergence = pinned('Convergence of Dominion');
  const unearther = (name: string, cost: string) =>
    oracle({
      name,
      typeLine: 'Artifact Creature — Necron',
      manaCost: '{2}',
      oracleText: `Unearth ${cost}`,
    });
  const UNEARTH = /\(graveyard\): Unearth/;

  function ready(seed: string, withCommander: boolean) {
    const ctx = pod(seed);
    spawn(ctx, 'P1', convergence.card);
    if (withCommander) {
      spawn(
        ctx,
        'P1',
        oracle({ name: 'Convergence Commander', typeLine: 'Legendary Creature — Necron' }),
        {
          isCommander: true,
        },
      );
    }
    return ctx;
  }
  const unearthOption = (ctx: GameContext, playerId: string) =>
    priorityOptions(ctx, playerId).find((option) => UNEARTH.test(option.description));

  it('convergence-of-dominion-pinned-oracle-supported — a commander-gated graveyard reduction and a mill ability', () => {
    expect(convergence.sha256).toBe(
      'd6f51e80f201a57dad225bd9f055c7d41727a5a5e286652550d2825dd828acdc',
    );
    expectModeled(convergence.card);
    expect(getOverride(convergence.card.oracleId)).toBeUndefined();
    const def = interpretCard(convergence.card);
    expect(def.ruleStatics).toEqual([
      {
        kind: 'costReduction',
        appliesTo: 'activate',
        graveyardAbilities: true,
        amount: constant(2),
        minimumMana: 1,
        condition: { kind: 'controlsYourCommander' },
      },
    ]);
  });

  it('convergence-of-dominion-graveyard-reduction — with your commander out, Unearth {3} costs {1}', () => {
    const ctx = ready('convergence-reduce', true);
    conjure(ctx, 'P1', unearther('Convergence Warrior', '{3}'), 'graveyard');
    addMana(playerById(ctx, 'P1'), generic(1));
    const option = unearthOption(ctx, 'P1');
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.name === 'Convergence Warrior')).toBe(true);
  });

  it('convergence-of-dominion-needs-commander — without your commander there is no reduction', () => {
    const ctx = ready('convergence-no-commander', false);
    conjure(ctx, 'P1', unearther('Convergence Warrior', '{3}'), 'graveyard');
    addMana(playerById(ctx, 'P1'), generic(2));
    expect(unearthOption(ctx, 'P1')).toBeUndefined();
    addMana(playerById(ctx, 'P1'), generic(1));
    expect(unearthOption(ctx, 'P1')).toBeDefined();
  });

  it('convergence-of-dominion-one-mana-floor — a {2} ability still costs {1}, never {0}', () => {
    const ctx = ready('convergence-floor', true);
    conjure(ctx, 'P1', unearther('Convergence Scarab', '{2}'), 'graveyard');
    expect(unearthOption(ctx, 'P1')).toBeUndefined();
    addMana(playerById(ctx, 'P1'), generic(1));
    expect(unearthOption(ctx, 'P1')).toBeDefined();
  });

  it('convergence-of-dominion-only-yours — an opponent’s Convergence does not reduce your graveyard abilities', () => {
    const ctx = pod('convergence-opponent');
    spawn(ctx, 'P2', convergence.card);
    spawn(ctx, 'P2', oracle({ name: 'Rival Commander', typeLine: 'Legendary Creature — Necron' }), {
      isCommander: true,
    });
    conjure(ctx, 'P1', unearther('Convergence Warrior', '{3}'), 'graveyard');
    addMana(playerById(ctx, 'P1'), generic(1));
    expect(unearthOption(ctx, 'P1')).toBeUndefined();
  });

  it('convergence-of-dominion-mill — {3}, {T}: mill three cards', () => {
    const ctx = pod('convergence-mill');
    const source = spawn(ctx, 'P1', convergence.card);
    addMana(playerById(ctx, 'P1'), generic(3));
    const before = playerById(ctx, 'P1').library.length;
    takeAction(
      ctx,
      'P1',
      activationMatching(ctx, 'P1', source, /Mill three/)!.payload as PriorityActionPayload,
    );
    expect(source.tapped).toBe(true);
    resolveTop(ctx);
    expect(playerById(ctx, 'P1').library).toHaveLength(before - 3);
    expect(playerById(ctx, 'P1').graveyard).toHaveLength(3);
  });
});

describe('Kogla and Yidaro', () => {
  const kogla = pinned('Kogla and Yidaro');
  const TRAMPLE = /trample and haste/;
  const FIGHT = /fights target creature/;
  const relic = () =>
    oracle({ name: 'Kogla Rival Relic', typeLine: 'Artifact', power: null, toughness: null });

  /** Kogla enters; answer its mode choice with `mode` and any target with `target`. */
  function enter(ctx: GameContext, mode: RegExp, target?: string) {
    const self = enterFor(ctx, 'P1', kogla.card)!;
    const modesOffered: string[][] = [];
    settle(ctx, (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      if (slot !== undefined && target !== undefined) {
        return { index: 0, targets: new Map([[slot.slot, target]]) };
      }
      if (decision.options.some((option) => TRAMPLE.test(option.description))) {
        modesOffered.push(decision.options.map((option) => option.description));
        return optionMatching(decision, mode);
      }
      return { index: 0, targets: new Map() };
    });
    return { self, modesOffered };
  }

  it('kogla-and-yidaro-pinned-oracle-supported — a modal enters trigger and a discard ability from hand', () => {
    expect(kogla.sha256).toBe('2282eee96e7fab34d482770704f913a3f2e579f20336e7ce52bf0c79d1df9fce');
    expect(kogla.card.oracleText).toBe(
      "When Kogla and Yidaro enters, choose one —\n• It gains trample and haste until end of turn.\n• It fights target creature you don't control.\n{2}{R}{G}, Discard this card: Destroy up to one target artifact or enchantment. Shuffle this card into your library from your graveyard, then draw a card.",
    );
    expectModeled(kogla.card);
    const def = interpretCard(kogla.card);
    expect(def.triggers[0]?.modes?.options.map((option) => option.description)).toEqual([
      'It gains trample and haste until end of turn',
      "It fights target creature you don't control",
    ]);
    expect(def.activatedAbilities[0]).toMatchObject({ zone: 'hand' });
    expect(def.activatedAbilities[0]?.costs.map((cost) => cost.kind)).toEqual([
      'mana',
      'discardSelf',
    ]);
  });

  it('kogla-and-yidaro-trample-haste — the first mode gives it trample and haste until end of turn', () => {
    const ctx = pod('kogla-trample');
    spawn(ctx, 'P2', oracle({ name: 'Kogla Rival Bear', typeLine: 'Creature — Bear' }));
    const { self } = enter(ctx, TRAMPLE);
    const keywords = computeCharacteristics(ctx, self).keywords;
    expect(keywords).toEqual(expect.arrayContaining(['trample', 'haste']));
    endUntilEotEffects(ctx);
    expect(computeCharacteristics(ctx, self).keywords).not.toContain('haste');
  });

  it('kogla-and-yidaro-fight — the second mode fights a creature you don’t control', () => {
    const ctx = pod('kogla-fight');
    const bear = spawn(
      ctx,
      'P2',
      oracle({ name: 'Kogla Rival Bear', typeLine: 'Creature — Bear', power: '3', toughness: '3' }),
    );
    spawn(ctx, 'P1', oracle({ name: 'Kogla Own Bear', typeLine: 'Creature — Bear' }));
    const { self } = enter(ctx, FIGHT, bear.id);
    pump(priorityCheckpoint(ctx));
    expect(ctx.state.battlefield.some((perm) => perm.id === bear.id)).toBe(false);
    expect(self.damageMarked).toBe(3);
  });

  it('kogla-and-yidaro-fight-needs-a-target — with no opposing creature only the first mode is offered', () => {
    const ctx = pod('kogla-no-target');
    spawn(ctx, 'P1', oracle({ name: 'Kogla Own Bear', typeLine: 'Creature — Bear' }));
    const { self, modesOffered } = enter(ctx, TRAMPLE);
    expect(modesOffered.flat().some((text) => FIGHT.test(text))).toBe(false);
    expect(computeCharacteristics(ctx, self).keywords).toContain('haste');
  });

  it('kogla-and-yidaro-discard-ability — discard it for {2}{R}{G}: destroy an artifact, shuffle it in, draw', () => {
    const ctx = pod('kogla-channel');
    const target = spawn(ctx, 'P2', relic());
    const inHand = conjure(ctx, 'P1', kogla.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }, { symbol: 'G' }, ...generic(2)]);
    const option = priorityOptions(ctx, 'P1').find((entry) =>
      /Kogla and Yidaro \(hand\)/.test(entry.description),
    );
    expect(option).toBeDefined();
    const libraryBefore = playerById(ctx, 'P1').library.length;
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload, (decision) => {
      const slot = decision.options[0]?.targets?.[0];
      return slot === undefined
        ? { index: 0, targets: new Map() }
        : { index: 0, targets: new Map([[slot.slot, target.id]]) };
    });
    expect(playerById(ctx, 'P1').graveyard.map((card) => card.cardId)).toContain(inHand.cardId);
    resolveTop(ctx);
    expect(ctx.state.battlefield.some((perm) => perm.id === target.id)).toBe(false);
    const p1 = playerById(ctx, 'P1');
    expect(p1.graveyard.map((card) => card.cardId)).not.toContain(inHand.cardId);
    // Shuffled in (+1), then one card drawn (-1).
    expect(p1.library).toHaveLength(libraryBefore);
    expect(p1.hand).toHaveLength(1);
  });

  it('kogla-and-yidaro-up-to-one — with no artifact or enchantment it still shuffles in and draws', () => {
    const ctx = pod('kogla-no-relic');
    const inHand = conjure(ctx, 'P1', kogla.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }, { symbol: 'G' }, ...generic(2)]);
    const option = priorityOptions(ctx, 'P1').find((entry) =>
      /Kogla and Yidaro \(hand\)/.test(entry.description),
    );
    expect(option).toBeDefined();
    takeAction(ctx, 'P1', option!.payload as PriorityActionPayload);
    resolveTop(ctx);
    const p1 = playerById(ctx, 'P1');
    expect(p1.graveyard.map((card) => card.cardId)).not.toContain(inHand.cardId);
    expect(p1.hand).toHaveLength(1);
  });

  it('kogla-and-yidaro-left-graveyard — if the card left the graveyard, nothing is shuffled but you still draw', () => {
    const ctx = pod('kogla-left');
    const inHand = conjure(ctx, 'P1', kogla.card, 'hand');
    addMana(playerById(ctx, 'P1'), [{ symbol: 'R' }, { symbol: 'G' }, ...generic(2)]);
    takeAction(
      ctx,
      'P1',
      priorityOptions(ctx, 'P1').find((entry) =>
        /Kogla and Yidaro \(hand\)/.test(entry.description),
      )!.payload as PriorityActionPayload,
    );
    const discarded = playerById(ctx, 'P1').graveyard.find(
      (card) => card.cardId === inHand.cardId,
    )!;
    pump(moveObject(ctx, discarded, { zone: 'exile' }));
    const libraryBefore = playerById(ctx, 'P1').library.length;
    resolveTop(ctx);
    expect(ctx.state.exile.map((card) => card.cardId)).toContain(inHand.cardId);
    expect(playerById(ctx, 'P1').library).toHaveLength(libraryBefore - 1);
    expect(playerById(ctx, 'P1').hand).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// Restoration gate
// ---------------------------------------------------------------------------------------------

interface RestoredCard {
  name: string;
  sha256: string;
  clauseCount: number;
}

/** Cards restored in PR02. A card enters this table in the same commit that restores it. */
const RESTORED: RestoredCard[] = [
  {
    name: 'Dream Devourer',
    sha256: 'daf65f95778453b46ca292c449635ae2451bb6a70b5133f712dc759774a74fc0',
    clauseCount: 2,
  },
  {
    name: 'Grim Haruspex',
    sha256: 'a82c1aeef591b7eaeb584f94d66076ac45cfafde3a65de88cdb36f4ae14866ef',
    clauseCount: 2,
  },
  {
    name: 'Changing Loyalty',
    sha256: 'c57a249316e0f083aae223224957ca14c9fd90badb941b38c27ed6c6cab578d0',
    clauseCount: 3,
  },
  {
    name: 'Kogla and Yidaro',
    sha256: '2282eee96e7fab34d482770704f913a3f2e579f20336e7ce52bf0c79d1df9fce',
    clauseCount: 2,
  },
  {
    name: 'Convergence of Dominion',
    sha256: 'd6f51e80f201a57dad225bd9f055c7d41727a5a5e286652550d2825dd828acdc',
    clauseCount: 2,
  },
  {
    name: 'Dragonkin Berserker',
    sha256: '2ad5ad892794762553614df0cd73da106fe1c7e09c0aee7106dd925e95f1dab6',
    clauseCount: 3,
  },
  {
    name: 'Killian, Ink Duelist',
    sha256: 'dc5a598c8b1bda5db8590ef9abe9f717f4d02dd5b97c0900aeec62a96e21e1e2',
    clauseCount: 3,
  },
  {
    name: 'Hour of Reckoning',
    sha256: '5eb44a788bb619b66c8ba3006f639178af53b512c0aedf77cbbbcee0c0e8c135',
    clauseCount: 2,
  },
  {
    name: 'Conclave Tribunal',
    sha256: 'bead25eae71e919428001104ee03ad6fe6261144a909897511225298eb235fb9',
    clauseCount: 2,
  },
  {
    name: 'Toxic Deluge',
    sha256: '8d4c686fcd606a82ad2a0dbba2ab363d1b5ca67300bf21b0a3de199ec277cad9',
    clauseCount: 2,
  },
  {
    name: 'Anrakyr the Traveller',
    sha256: '1f11aa229db25bcdc8cb4b657fc98252b59975ad92a97811bae330033a79dcf9',
    clauseCount: 1,
  },
  {
    name: 'Their Number Is Legion',
    sha256: '41b6712d088b044a1c75a4ef825006b3774b32f673850f48bb207b10e00e24a6',
    clauseCount: 2,
  },
  {
    name: "Raffine's Guidance",
    sha256: '44bdca5ef478f6340f60ac4c911274747431dab346b34c92e2d3c2c092759823',
    clauseCount: 3,
  },
  {
    name: 'Dread Return',
    sha256: 'bda6e9277a015c56401c6b4f23fca3e7258d3aaeb53a6f234f3610f44b650553',
    clauseCount: 2,
  },
  {
    name: 'Blasphemous Edict',
    sha256: '6994bb591cb20faee9759d2070892083e2cea7b20e36ece110b5cc740790b4d3',
    clauseCount: 2,
  },
  {
    name: 'Flare of Malice',
    sha256: 'd358e361fe29eb5d7bb7a2b7150da42213f3ec722749868738013cf835d87ec0',
    clauseCount: 2,
  },
  {
    name: 'Flare of Denial',
    sha256: 'bf7016907d2dd85f89b718bc7cb81fa45db2423f52bfee50eff788eab5d3ac34',
    clauseCount: 2,
  },
  {
    name: 'Ghost Ark',
    sha256: 'bd5d0a53132a9b86c3ced3f9f31a6856b362023b2b014b354c27ffdf92d12ffc',
    clauseCount: 3,
  },
  {
    name: 'Soul-Guide Lantern',
    sha256: '93d00eeabc06f7b9cfb8d6d1ca01b8a6cce4ba7b83905a680d591c3aa5fb93ec',
    clauseCount: 3,
  },
  {
    name: 'Peema Trailblazer',
    sha256: 'ac39b4f00910602a5d4f2038f9ed5a9c13f09de367d4c89bc66eaa8efc823f51',
    clauseCount: 3,
  },
  {
    name: 'Illuminor Szeras',
    sha256: '7b83ca63d63f5b6abb39060bab1bc0dd086714872059ed3c0db58a8edb205486',
    clauseCount: 1,
  },
  {
    name: 'Sage of Fables',
    sha256: '1423e05e7e7fc5bf74c33c20c1f368ebd1f4224c9c5112df484d654181aeb382',
    clauseCount: 2,
  },
  {
    name: 'Nullmage Shepherd',
    sha256: '9778d0c0a47ec527656f5c9551f1708cfbf65ce71b0636143efe86c288b3ba1a',
    clauseCount: 1,
  },
  {
    name: 'Carrion Feeder',
    sha256: '7fb3a771052de7acaa2d3eaebe9c39509ae68522bd344b4bd2491f77e6a3e069',
    clauseCount: 2,
  },
  {
    name: 'Mistveil Plains',
    sha256: 'ba245c46e7ecea52425fded3beb73f5bba3666af9f1c85e8234df1a5a3430791',
    clauseCount: 3,
  },
  {
    name: 'Idol of Oblivion',
    sha256: '3baa23cd967df7e2c0549ab91ce4f57a51d53fd1282487e1236073936643962b',
    clauseCount: 2,
  },
  {
    name: 'Weathered Wayfarer',
    sha256: '42ef11f806b155602ccdd9ce54d2cd2e123a4df1d42d90c83dcedad110cfaafd',
    clauseCount: 1,
  },
  {
    name: 'Sceptre of Eternal Glory',
    sha256: '51ed0fa70d837b566989f2a57ef7b70bf50985d3c5c84b9d713f04a501aac2f5',
    clauseCount: 2,
  },
  {
    name: 'Endless Atlas',
    sha256: 'e1d31dc2c8118f97fe833d58fce9caf77240ad6f11bae0a80cb066638303a610',
    clauseCount: 1,
  },
  {
    name: 'Bespoke Battlewagon',
    sha256: '17244fc3e0a51b50c27c6b7583124bd9d6773c9a102cea36f4055792ea885d21',
    clauseCount: 5,
  },
  {
    name: 'Solar Transformer',
    sha256: '2a416da6016481cde18645f08b0a9c28b2da620d08fe234bb82abcf7ef8719a3',
    clauseCount: 4,
  },
  {
    name: 'Aether Hub',
    sha256: 'a6641d8a589b60feec25b6da189a097707da60158d6196778bc6365bcccf88ec',
    clauseCount: 3,
  },
  {
    name: 'Retrofitter Foundry',
    sha256: '39cf3707dcf66c91dc222d73e8ee28cb898c9969c597ae3c12a916d1b7537bc3',
    clauseCount: 4,
  },
];

interface ManifestClause {
  id?: string;
  oracleText: string;
  implementation: string[];
  engineTestIds: string[];
  viewerScenarioIds: string[];
}

interface Manifest {
  cards: Record<
    string,
    {
      name: string;
      oracleSha256: string;
      implementationStatus: string;
      clauses: ManifestClause[];
      gameplayAiScenarioIds: string[];
    }
  >;
}

const repoFile = (path: string): string =>
  readFileSync(resolve(import.meta.dirname, '../../..', path), 'utf8');

describe('PR02 restoration gate', () => {
  const manifest = JSON.parse(
    repoFile('packages/server/fixtures/card-verification-manifest.json'),
  ) as Manifest;
  const engineSource = readFileSync(import.meta.filename, 'utf8');
  const viewerSource = [
    repoFile('packages/server/src/cards/card-test-scenarios.ts'),
    repoFile('apps/web/e2e/card-test-lab.spec.ts'),
  ].join('\n');

  it.each(RESTORED.map((card) => [card.name, card] as const))(
    '%s is pinned and modeled under its real id and fixture alias',
    (name, expected) => {
      const entry = pinned(name);
      expect(entry.sha256).toBe(expected.sha256);
      expect(createHash('sha256').update(canonical(entry.card)).digest('hex')).toBe(
        expected.sha256,
      );
      expectModeled(entry.card);
    },
  );

  it('leaves no registration behind for cards the audit records as interpreter-restored', () => {
    const audit = JSON.parse(repoFile('docs/plans/card-catalog-audit.json')) as {
      interpreterRestored?: { oracleId: string; name: string; restoredIn: string }[];
    };
    const ours = (audit.interpreterRestored ?? []).filter(
      (entry) => entry.restoredIn === 'coverage-pr02',
    );
    expect(ours.length).toBeGreaterThan(0);
    for (const entry of ours) {
      expect(
        RESTORED.map((card) => card.name),
        entry.name,
      ).toContain(entry.name);
      expect(getOverride(entry.oracleId), entry.name).toBeUndefined();
      expect(getOverride(fixtureOracleId(entry.name)), `${entry.name} alias`).toBeUndefined();
      expect(interpretCard(pinned(entry.name).card).modeled, entry.name).toBe(true);
    }
  });

  it.each(RESTORED.map((card) => [card.name, card] as const))(
    '%s declares implemented-reviewed clauses mapped to engine and viewer evidence',
    (name, expected) => {
      const entry = pinned(name);
      const declared = manifest.cards[entry.card.oracleId];
      expect(declared?.name).toBe(name);
      expect(declared?.oracleSha256).toBe(expected.sha256);
      expect(declared?.implementationStatus).toBe('implemented-reviewed');
      expect(declared?.clauses).toHaveLength(expected.clauseCount);
      for (const clause of declared!.clauses) {
        expect(clause.id, `${name} clause id`).toBeTruthy();
        expect(entry.card.oracleText, `${name} clause text`).toContain(clause.oracleText);
        expect(clause.implementation, `${name} implementation`).not.toHaveLength(0);
        expect(clause.engineTestIds, `${name} engine tests`).not.toHaveLength(0);
        expect(clause.viewerScenarioIds, `${name} viewer scenarios`).not.toHaveLength(0);
        for (const id of clause.engineTestIds) expect(engineSource, id).toContain(`${id} —`);
        for (const id of clause.viewerScenarioIds) expect(viewerSource, id).toContain(id);
      }
    },
  );
});
