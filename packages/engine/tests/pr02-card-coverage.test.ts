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
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { ofType } from '../src/cards/selector';
import { fixtureOracleId, getOverride, registerOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { endUntilEotEffects } from '../src/effects/resolve';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { runCombatAndExtraCombats } from '../src/turn/turn';
import { createGame } from '../src/state/game';
import { prepareScenario } from '../src/testing/prepared-scenario';
import { playerById } from '../src/state/objects';
import { manaSourcesFor, selfMayTap } from '../src/state/queries';
import { buildPlayerView } from '../src/view/view';
import type { EnginePermanent, GameContext } from '../src/state/types';
import {
  conjure,
  copies,
  declareAttacks,
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

const PINNED_FILES = ['fixtures/marchesa-batch1-oracle.json'];
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
