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
import { fixtureOracleId, getOverride, registerOverride } from '../src/cards/overrides';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { computeCharacteristics } from '../src/effects/continuous';
import { addMana } from '../src/mana/pool';
import { resolveTopOfStack } from '../src/stack/stack';
import { runPrioritySequence } from '../src/turn/priority';
import { createGame } from '../src/state/game';
import { playerById } from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

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

  it('extend-card-leaves-unlisted-fields-alone — fields the override omits stay interpreted', () => {
    const card = twoLines('Lab Untouched Rock');
    registerOverride({
      oracleId: card.oracleId,
      name: card.name,
      handledLines: ['Frobnicate the widget.'],
      def: { activatedAbilities: [] },
      compose: 'append',
    });
    const def = interpretCard(card);
    expect(def.manaAbilities).toEqual([{ units: [['C']] }]);
    expect(def.activatedAbilities).toEqual([]);
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
