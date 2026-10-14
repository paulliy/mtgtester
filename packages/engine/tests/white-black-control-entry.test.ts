import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import type { Ability, TriggerHead } from '../src/cards/ability';
import { interpretCard } from '../src/cards/interpret';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { registerWhiteBlackControlEntryOverrides } from '../src/cards/overrides/white-black-control-entry';
import { computeCharacteristics } from '../src/effects/continuous';
import { createGame } from '../src/state/game';
import { addMana } from '../src/mana/pool';
import { createTokens, moveObject, movePermanentsToGraveyard } from '../src/state/objects';
import { resolveTopOfStack } from '../src/stack/stack';
import type { GameContext, EnginePermanent } from '../src/state/types';
import { runPrioritySequence } from '../src/turn/priority';
import { anyOf, ofType } from '../src/cards/selector';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedCard {
  sha256: string;
  card: OracleCard;
}
const pinned = JSON.parse(
  readFileSync(new URL('./fixtures/white-black-control-oracle.json', import.meta.url), 'utf8'),
) as { cards: PinnedCard[] };
const names = [
  'Authority of the Consuls',
  'Archon of Emeria',
  'Doorkeeper Thrull',
  'Karn, Argent Defender',
  'Hushbringer',
] as const;
const cards = new Map<string, OracleCard>();
for (const name of names) {
  const entry = pinned.cards.find((candidate) => candidate.card.name === name);
  if (entry === undefined) throw new Error(`Missing pinned Oracle card: ${name}`);
  cards.set(name, entry.card);
}

beforeAll(() => registerWhiteBlackControlEntryOverrides());

function card(name: (typeof names)[number]): OracleCard {
  const found = cards.get(name);
  if (found === undefined) throw new Error(`Missing pinned card ${name}`);
  return found;
}

function context(seed = 'white-black-control-entry'): GameContext {
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
  return ctx;
}

function player(ctx: GameContext, id: string) {
  const found = ctx.state.players.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`Missing player ${id}`);
  return found;
}

function castPermanent(ctx: GameContext, printed: OracleCard): EnginePermanent {
  const active = player(ctx, 'P1');
  const inHand = conjure(ctx, 'P1', printed, 'hand');
  addMana(active, [
    { symbol: 'W' },
    { symbol: 'C' },
    { symbol: 'C' },
    { symbol: 'C' },
    { symbol: 'C' },
  ]);
  const option = computePriorityOptions(ctx, active).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === inHand.id;
  });
  if (option === undefined) throw new Error(`No normal cast option for ${printed.name}`);
  pump(
    applyPriorityAction(ctx, active, option.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  pump(resolveTopOfStack(ctx));
  const permanent = ctx.state.battlefield.find((candidate) => candidate.cardId === inHand.cardId);
  if (permanent === undefined) throw new Error(`${printed.name} did not enter the battlefield`);
  return permanent;
}

function entrant(
  ctx: GameContext,
  name: string,
  typeLine: string,
  triggers: TriggerHead[] = [{ when: 'enters', subject: { kind: 'self' } }],
  entersWithCounters?: Record<string, number>,
): OracleCard {
  const isCreature = typeLine.includes('Creature');
  const printed = oracle({
    name,
    typeLine,
    manaCost: null,
    power: isCreature ? '2' : null,
    toughness: isCreature ? '2' : null,
  });
  const def = interpretCard(printed);
  def.triggers = triggers.map((trigger): Ability => ({
    kind: 'triggered',
    trigger,
    targets: [],
    effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
  }));
  if (entersWithCounters !== undefined) def.entersWithCounters = entersWithCounters;
  ctx.defs.set(def.oracleId, def);
  return printed;
}

function observer(
  ctx: GameContext,
  filter: ReturnType<typeof anyOf>,
  when: 'enters' | 'dies' = 'enters',
) {
  const printed = oracle({
    name: `Observer ${when}`,
    typeLine: 'Enchantment',
    manaCost: null,
    power: null,
    toughness: null,
  });
  const def = interpretCard(printed);
  def.triggers = [
    {
      kind: 'triggered',
      trigger: { when, subject: { kind: 'permanent', selector: filter } },
      targets: [],
      effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
    },
  ];
  ctx.defs.set(def.oracleId, def);
  return spawn(ctx, 'P1', printed);
}

function enter(ctx: GameContext, ownerId: string, printed: OracleCard): EnginePermanent {
  const inHand = conjure(ctx, ownerId, printed, 'hand');
  const result = pump(
    moveObject(ctx, inHand, { zone: 'battlefield', controllerId: ownerId }),
  ).value;
  if (result === null || result.zone !== 'battlefield')
    throw new Error(`${printed.name} did not enter`);
  return result as EnginePermanent;
}

function castZeroInstant(ctx: GameContext, playerId: string, name: string): void {
  const printed = oracle({
    name,
    typeLine: 'Instant',
    manaCost: '{0}',
    oracleText: 'You gain 1 life.',
    power: null,
    toughness: null,
  });
  const inHand = conjure(ctx, playerId, printed, 'hand');
  const active = player(ctx, playerId);
  const option = computePriorityOptions(ctx, active).find((candidate) => {
    const payload = candidate.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === inHand.id;
  });
  if (option === undefined) throw new Error(`No legal cast option for ${name}`);
  pump(
    applyPriorityAction(ctx, active, option.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  pump(resolveTopOfStack(ctx));
}

describe('white-black-control entry and trigger suppression cards', () => {
  it('Authority of the Consuls normally casts, taps opposing creature and token entries, and keeps its life trigger', () => {
    const ctx = context();
    const authority = castPermanent(ctx, card('Authority of the Consuls'));
    expect(authority.tapped).toBe(false);

    const ownCreature = enter(ctx, 'P1', entrant(ctx, 'Own Creature', 'Creature — Bear', []));
    const opponentArtifact = enter(ctx, 'P2', entrant(ctx, 'Opponent Artifact', 'Artifact', []));
    expect(ownCreature.tapped).toBe(false);
    expect(opponentArtifact.tapped).toBe(false);
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    const initialLife = player(ctx, 'P1').life;
    const opponentCreature = enter(
      ctx,
      'P2',
      entrant(ctx, 'Opponent Creature', 'Creature — Bear', []),
    );
    expect(opponentCreature.tapped).toBe(true);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));
    expect(player(ctx, 'P1').life).toBe(initialLife + 1);

    const soldier = createTokens(
      ctx,
      {
        name: 'Soldier',
        typeLine: 'Token Creature — Soldier',
        types: ['Creature'],
        subtypes: ['Soldier'],
        colors: ['W'],
        power: 1,
        toughness: 1,
      },
      1,
      'P2',
    )[0]!;
    expect(soldier.tapped).toBe(true);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(runPrioritySequence(ctx));
    expect(player(ctx, 'P1').life).toBe(initialLife + 2);
  });

  it('Archon of Emeria normally casts, preserves flying, limits each player, and taps only opponents’ nonbasic lands', () => {
    const ctx = context();
    const archon = castPermanent(ctx, card('Archon of Emeria'));
    expect(computeCharacteristics(ctx, archon).keywords).toContain('flying');
    expect(player(ctx, 'P1').spellsCastThisTurn).toBe(1);

    const opposingNonbasic = enter(ctx, 'P2', entrant(ctx, 'Opponent Desert', 'Land — Desert', []));
    const opposingBasic = enter(
      ctx,
      'P2',
      entrant(ctx, 'Opponent Island', 'Basic Land — Island', []),
    );
    const ownNonbasic = enter(ctx, 'P1', entrant(ctx, 'Own Desert', 'Land — Desert', []));
    expect(opposingNonbasic.tapped).toBe(true);
    expect(opposingBasic.tapped).toBe(false);
    expect(ownNonbasic.tapped).toBe(false);

    castZeroInstant(ctx, 'P2', 'P2 First Spell');
    expect(player(ctx, 'P2').spellsCastThisTurn).toBe(1);
    expect(() => castZeroInstant(ctx, 'P2', 'P2 Blocked Spell')).toThrow(/No legal cast option/);
    expect(() => castZeroInstant(ctx, 'P1', 'P1 Blocked Spell')).toThrow(/No legal cast option/);
  });

  it('Doorkeeper Thrull suppresses own and watcher enters triggers for artifacts and creatures, not lands', () => {
    const ctx = context();
    const door = castPermanent(ctx, card('Doorkeeper Thrull'));
    expect(computeCharacteristics(ctx, door).keywords).toEqual(
      expect.arrayContaining(['flash', 'flying']),
    );
    observer(ctx, anyOf(ofType('Artifact'), ofType('Creature'), ofType('Land')));

    enter(ctx, 'P2', entrant(ctx, 'Suppressed Artifact', 'Artifact'));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    enter(ctx, 'P2', entrant(ctx, 'Suppressed Creature', 'Creature — Bear'));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    enter(ctx, 'P2', entrant(ctx, 'Unsuppressed Land', 'Land — Island'));
    expect(ctx.state.pendingTriggers).toHaveLength(2); // the land’s own ability and the other permanent’s watcher
    ctx.state.pendingTriggers = [];

    pump(moveObject(ctx, door, { zone: 'exile' }));
    enter(ctx, 'P2', entrant(ctx, 'After Thrull Leaves', 'Artifact Creature — Golem'));
    expect(ctx.state.pendingTriggers).toHaveLength(2);
    ctx.state.pendingTriggers = [];

    const returningDoor = castPermanent(ctx, card('Doorkeeper Thrull'));
    const muteCard = oracle({
      name: 'Thrull Silencer',
      typeLine: 'Enchantment',
      manaCost: null,
      power: null,
      toughness: null,
    });
    const muteDef = interpretCard(muteCard);
    muteDef.staticEffects = [
      { affects: { kind: 'subtype', value: 'Thrull' }, op: { layer: 6, loseAllAbilities: true } },
    ];
    ctx.defs.set(muteDef.oracleId, muteDef);
    spawn(ctx, 'P1', muteCard);
    expect(computeCharacteristics(ctx, returningDoor).loseAbilities).toBe(true);
    enter(ctx, 'P2', entrant(ctx, 'After Thrull Loses Abilities', 'Artifact Creature — Golem'));
    expect(ctx.state.pendingTriggers).toHaveLength(2);
  });

  it('Karn, Argent Defender normally casts and applies the same artifact-or-creature enters filter', () => {
    const ctx = context();
    const karn = castPermanent(ctx, card('Karn, Argent Defender'));
    expect(computeCharacteristics(ctx, karn).types).toEqual(
      expect.arrayContaining(['Artifact', 'Creature']),
    );
    observer(ctx, anyOf(ofType('Artifact'), ofType('Creature'), ofType('Land')));

    enter(ctx, 'P2', entrant(ctx, 'Karn Suppresses Artifact', 'Artifact'));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    enter(ctx, 'P2', entrant(ctx, 'Karn Suppresses Creature', 'Creature — Bear'));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    enter(ctx, 'P2', entrant(ctx, 'Karn Leaves Land Alone', 'Land — Island'));
    expect(ctx.state.pendingTriggers).toHaveLength(2);
  });

  it('Hushbringer suppresses creature enters/dies, preserves enter-counter triggers, and its simultaneous death still suppresses', () => {
    const ctx = context();
    const hush = castPermanent(ctx, card('Hushbringer'));
    expect(computeCharacteristics(ctx, hush).keywords).toEqual(
      expect.arrayContaining(['flying', 'lifelink']),
    );
    observer(ctx, ofType('Creature'), 'enters');
    observer(ctx, ofType('Creature'), 'dies');

    const counterWitness = enter(
      ctx,
      'P2',
      entrant(
        ctx,
        'Counter Witness',
        'Creature — Bear',
        [
          { when: 'enters', subject: { kind: 'self' } },
          { when: 'dies', subject: { kind: 'self' } },
          { when: 'countersPut', subject: { kind: 'self' }, counter: '+1/+1' },
        ],
        { '+1/+1': 1 },
      ),
    );
    expect(counterWitness.counters['+1/+1']).toBe(1);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    expect(ctx.state.pendingTriggers[0]?.ability.trigger?.when).toBe('countersPut');
    pump(runPrioritySequence(ctx));

    pump(movePermanentsToGraveyard(ctx, [hush, counterWitness]));
    expect(ctx.state.pendingTriggers).toHaveLength(0);

    enter(ctx, 'P2', entrant(ctx, 'After Hush Leaves', 'Creature — Bear'));
    expect(ctx.state.pendingTriggers).toHaveLength(2); // own enter trigger plus observer
  });

  it('Hushbringer loses suppression with its abilities and the suppressed enter abilities resume', () => {
    const ctx = context();
    const hush = castPermanent(ctx, card('Hushbringer'));
    observer(ctx, ofType('Creature'));
    const muteCard = oracle({
      name: 'Faerie Silencer',
      typeLine: 'Enchantment',
      manaCost: null,
      power: null,
      toughness: null,
    });
    const muteDef = interpretCard(muteCard);
    muteDef.staticEffects = [
      { affects: { kind: 'subtype', value: 'Faerie' }, op: { layer: 6, loseAllAbilities: true } },
    ];
    ctx.defs.set(muteDef.oracleId, muteDef);

    enter(ctx, 'P2', entrant(ctx, 'Still Suppressed', 'Creature — Bear'));
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    spawn(ctx, 'P1', muteCard);
    expect(computeCharacteristics(ctx, hush).loseAbilities).toBe(true);
    enter(ctx, 'P2', entrant(ctx, 'Suppression Gone', 'Creature — Bear'));
    expect(ctx.state.pendingTriggers).toHaveLength(2);
  });

  it('structural validation rejects malformed rule-static events, filters, and spell limits', () => {
    const printed = oracle({
      name: 'Malformed Rule Static',
      typeLine: 'Enchantment',
      manaCost: null,
      power: null,
      toughness: null,
    });
    const invalidIssues = (staticValue: unknown) => {
      const def = interpretCard(printed);
      def.ruleStatics = [staticValue as never];
      return validateCardDefinition(def);
    };

    expect(
      invalidIssues({
        kind: 'suppressObjectTriggers',
        events: ['enters', 'castsSpell'],
        filter: ofType('Creature'),
      }).some((issue) => issue.path.includes('ruleStatics') && /event|events/i.test(issue.message)),
    ).toBe(true);
    expect(
      invalidIssues({ kind: 'suppressObjectTriggers', events: ['enters'] }).some(
        (issue) =>
          issue.path.includes('ruleStatics') &&
          issue.path.endsWith('.filter') &&
          /selector|required/i.test(issue.message),
      ),
    ).toBe(true);
    expect(
      invalidIssues({
        kind: 'suppressObjectTriggers',
        events: ['enters', 'dies', 'leavesBattlefield'],
        filter: ofType('Creature'),
      }).some((issue) => issue.path.includes('ruleStatics') && /event|events/i.test(issue.message)),
    ).toBe(true);
    expect(
      invalidIssues({ kind: 'otherPermanentsEnterTapped' }).some(
        (issue) =>
          issue.path.includes('ruleStatics') &&
          issue.path.endsWith('.filter') &&
          /selector|required/i.test(issue.message),
      ),
    ).toBe(true);
    expect(
      invalidIssues({ kind: 'spellCastLimit', category: 'everything', limit: 1 }).some((issue) =>
        issue.path.endsWith('.category'),
      ),
    ).toBe(true);
    expect(
      invalidIssues({ kind: 'spellCastLimit', category: 'any', limit: -1 }).some((issue) =>
        issue.path.endsWith('.limit'),
      ),
    ).toBe(true);
  });
});
