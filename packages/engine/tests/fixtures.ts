/**
 * Test fixtures: oracle-card builders, deck builders, engine harnesses, and a generator
 * pump for exercising internal flow functions directly (brief §12 — fixture-based rules
 * scenarios are the bulk of engine coverage).
 */

import type { OracleCard, PlayerId } from '@mtg/shared';
import type { CardDefinition } from '../src/cards/definition';
import { interpretCard } from '../src/cards/interpret';
import type { DecisionOutcome, GameGen, PendingDecision } from '../src/decisions';
import { forcedOutcome, isForced } from '../src/decisions';
import { Engine } from '../src/engine';
import { makePermanent } from '../src/state/objects';
import type {
  EngineCardObject,
  EnginePermanent,
  EnginePlayerConfig,
  GameConfig,
  GameContext,
} from '../src/state/types';

let oracleCounter = 0;

/** Build an OracleCard with sensible defaults. Oracle id derives from the name. */
export function oracle(partial: Partial<OracleCard> & { name: string }): OracleCard {
  const typeLine = partial.typeLine ?? 'Creature — Test';
  return {
    oracleId:
      partial.oracleId ?? `oracle-${partial.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    scryfallId: `scry-${++oracleCounter}`,
    name: partial.name,
    manaCost: partial.manaCost !== undefined ? partial.manaCost : '{1}',
    cmc: partial.cmc ?? 1,
    colors: partial.colors ?? [],
    colorIdentity: partial.colorIdentity ?? [],
    typeLine,
    supertypes: partial.supertypes ?? (typeLine.startsWith('Legendary') ? ['Legendary'] : []),
    types:
      partial.types ??
      typeLine
        .replace(/^(Basic|Legendary|Snow)\s+/g, '')
        .split(' — ')[0]!
        .split(' '),
    subtypes:
      partial.subtypes ?? (typeLine.includes(' — ') ? typeLine.split(' — ')[1]!.split(' ') : []),
    oracleText: partial.oracleText ?? '',
    power: partial.power ?? (typeLine.includes('Creature') ? '2' : null),
    toughness: partial.toughness ?? (typeLine.includes('Creature') ? '2' : null),
    loyalty: partial.loyalty ?? null,
    defense: partial.defense ?? null,
    keywords: partial.keywords ?? [],
    layout: partial.layout ?? 'normal',
    commanderLegality: partial.commanderLegality ?? 'legal',
    isBasicLand: partial.isBasicLand ?? typeLine.startsWith('Basic Land'),
  };
}

// --- Standard fixture cards ---

export const forest = (): OracleCard =>
  oracle({
    name: 'Forest',
    typeLine: 'Basic Land — Forest',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
export const island = (): OracleCard =>
  oracle({
    name: 'Island',
    typeLine: 'Basic Land — Island',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
export const mountain = (): OracleCard =>
  oracle({
    name: 'Mountain',
    typeLine: 'Basic Land — Mountain',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
export const plains = (): OracleCard =>
  oracle({
    name: 'Plains',
    typeLine: 'Basic Land — Plains',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
export const swamp = (): OracleCard =>
  oracle({
    name: 'Swamp',
    typeLine: 'Basic Land — Swamp',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });

export const bear = (): OracleCard =>
  oracle({
    name: 'Test Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{1}{G}',
    power: '2',
    toughness: '2',
  });

export const giantGrowth = (): OracleCard =>
  oracle({
    name: 'Test Growth',
    typeLine: 'Instant',
    manaCost: '{G}',
    power: null,
    toughness: null,
    oracleText: 'Target creature gets +3/+3 until end of turn.',
  });

export const bolt = (): OracleCard =>
  oracle({
    name: 'Test Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    power: null,
    toughness: null,
    oracleText: 'Test Bolt deals 3 damage to any target.',
  });

export const doom = (): OracleCard =>
  oracle({
    name: 'Test Doom',
    typeLine: 'Instant',
    manaCost: '{B}',
    power: null,
    toughness: null,
    oracleText: 'Destroy target creature.',
  });

export const cancel = (): OracleCard =>
  oracle({
    name: 'Test Cancel',
    typeLine: 'Instant',
    manaCost: '{U}',
    power: null,
    toughness: null,
    oracleText: 'Counter target spell.',
  });

export const divination = (): OracleCard =>
  oracle({
    name: 'Test Divination',
    typeLine: 'Sorcery',
    manaCost: '{1}{U}',
    power: null,
    toughness: null,
    oracleText: 'Draw two cards.',
  });

/** A legendary creature commander in the given color. */
export function commanderFor(color: 'W' | 'U' | 'B' | 'R' | 'G', name: string): OracleCard {
  return oracle({
    name,
    typeLine: 'Legendary Creature — Test Captain',
    manaCost: `{1}{${color}}`,
    colors: [color],
    colorIdentity: [color],
    power: '3',
    toughness: '3',
  });
}

export function keywordCreature(
  name: string,
  keywords: string,
  manaCost = '{1}{W}',
  pt = '2/2',
): OracleCard {
  const [p, t] = pt.split('/') as [string, string];
  return oracle({
    name,
    typeLine: 'Creature — Test Soldier',
    manaCost,
    power: p,
    toughness: t,
    oracleText: keywords, // e.g. "First strike" / "Flying, vigilance"
  });
}

// --- Deck / game construction ---

export interface SeatSpec {
  id?: PlayerId;
  commander?: OracleCard;
  commanders?: OracleCard[];
  cards: OracleCard[];
  companion?: OracleCard | null;
}

export function seat(spec: SeatSpec, index: number): EnginePlayerConfig {
  const id = spec.id ?? `P${index + 1}`;
  const commanders = spec.commanders ?? [spec.commander ?? commanderFor('G', `Test General ${id}`)];
  const config: EnginePlayerConfig = { id, deckId: `deck-${id}`, commanders, cards: spec.cards };
  if (spec.companion !== undefined) config.companion = spec.companion;
  return config;
}

/** N copies of a card list, expanded. */
export function copies(n: number, card: () => OracleCard): OracleCard[] {
  return Array.from({ length: n }, card);
}

export function gameConfig(
  seats: SeatSpec[],
  overrides?: Partial<Omit<GameConfig, 'players'>>,
): GameConfig {
  return {
    gameId: overrides?.gameId ?? 'test-game',
    seed: overrides?.seed ?? 'test-seed',
    players: seats.map((s, i) => seat(s, i)),
    ...(overrides?.turnCap !== undefined ? { turnCap: overrides.turnCap } : {}),
    ...(overrides?.customDefinitions !== undefined
      ? { customDefinitions: overrides.customDefinitions }
      : {}),
  };
}

/** Four seats of `n` Forests each — the minimal do-nothing pod. */
export function forestsPod(n = 12): SeatSpec[] {
  return [0, 1, 2, 3].map(() => ({ cards: copies(n, forest) }));
}

export function makeEngine(
  seats: SeatSpec[],
  overrides?: Partial<Omit<GameConfig, 'players'>>,
): Engine {
  return new Engine(gameConfig(seats, overrides));
}

// --- Direct-generator harness (state surgery for SBA/zone tests) ---

let spawnCounter = 0;

/** Register (interpret) a card's definition in a live game context. */
export function registerDef(ctx: GameContext, card: OracleCard): CardDefinition {
  if (!ctx.defs.has(card.oracleId)) ctx.defs.set(card.oracleId, interpretCard(card));
  return ctx.defs.get(card.oracleId) as CardDefinition;
}

export function registerCustomDef(ctx: GameContext, def: CardDefinition): void {
  ctx.defs.set(def.oracleId, def);
}

/** Create a card object out of thin air, in the given zone container of its owner. */
export function conjure(
  ctx: GameContext,
  ownerId: PlayerId,
  card: OracleCard,
  zone: 'hand' | 'graveyard' | 'library' | 'exile' | 'command',
  opts?: { isCommander?: boolean },
): EngineCardObject {
  registerDef(ctx, card);
  const obj: EngineCardObject = {
    id: `test-o-${++spawnCounter}`,
    cardId: `test-c-${spawnCounter}`,
    oracleId: card.oracleId,
    ownerId,
    name: card.name,
    typeLine: card.typeLine,
    oracleText: card.oracleText,
    manaCost: card.manaCost,
    isToken: false,
    isCommander: opts?.isCommander ?? false,
    zone,
  };
  const player = ctx.state.players.find((p) => p.id === ownerId);
  if (player === undefined) throw new Error(`no player ${ownerId}`);
  if (zone === 'hand') player.hand.push(obj);
  else if (zone === 'graveyard') player.graveyard.push(obj);
  else if (zone === 'library') player.library.unshift(obj);
  else if (zone === 'command') player.commandZone.push(obj);
  else ctx.state.exile.push(obj);
  return obj;
}

/** Put a permanent straight onto the battlefield (not summoning sick by default). */
export function spawn(
  ctx: GameContext,
  controllerId: PlayerId,
  card: OracleCard,
  opts?: { tapped?: boolean; summoningSick?: boolean; isToken?: boolean; isCommander?: boolean },
): EnginePermanent {
  registerDef(ctx, card);
  const obj: EngineCardObject = {
    id: `test-o-${++spawnCounter}`,
    cardId: `test-c-${spawnCounter}`,
    oracleId: card.oracleId,
    ownerId: controllerId,
    name: card.name,
    typeLine: card.typeLine,
    oracleText: card.oracleText,
    manaCost: card.manaCost,
    isToken: opts?.isToken ?? false,
    isCommander: opts?.isCommander ?? false,
    zone: 'command',
  };
  const perm = makePermanent(ctx, obj, controllerId);
  perm.summoningSick = opts?.summoningSick ?? false;
  perm.tapped = opts?.tapped ?? false;
  ctx.state.battlefield.push(perm);
  return perm;
}

/**
 * Pump an internal generator to completion. `answer` maps surfaced decisions to
 * outcomes; forced decisions resolve automatically; the default picks option 0.
 */
export function pump<T>(
  gen: GameGen<T>,
  answer?: (decision: PendingDecision, count: number) => DecisionOutcome,
): { value: T; decisions: PendingDecision[] } {
  const decisions: PendingDecision[] = [];
  let outcome: DecisionOutcome | undefined;
  for (;;) {
    const step = outcome === undefined ? gen.next() : gen.next(outcome);
    if (step.done === true) return { value: step.value, decisions };
    const decision = step.value;
    if (isForced(decision)) {
      outcome = forcedOutcome(decision);
      continue;
    }
    decisions.push(decision);
    outcome =
      answer?.(decision, decisions.length) ?? ({ index: 0, targets: new Map() } as DecisionOutcome);
  }
}

// --- Rule-based provider for whole-game engine tests ---

export interface ProviderRule {
  when: (request: import('@mtg/shared').DecisionRequest) => boolean;
  then: (request: import('@mtg/shared').DecisionRequest) => import('@mtg/shared').DecisionResponse;
  /** Fire at most once. */
  once?: boolean;
}

/**
 * Answers decisions by the first matching rule; anything unmatched takes the first
 * option (pass / keep / don't attack / don't block — always the conservative default).
 */
export class RuleBasedProvider {
  readonly seen: import('@mtg/shared').DecisionRequest[] = [];
  private readonly used = new Set<ProviderRule>();

  constructor(private readonly rules: ProviderRule[]) {}

  decide(request: import('@mtg/shared').DecisionRequest): import('@mtg/shared').DecisionResponse {
    this.seen.push(request);
    for (const rule of this.rules) {
      if (this.used.has(rule)) continue;
      if (rule.when(request)) {
        if (rule.once === true) this.used.add(rule);
        return rule.then(request);
      }
    }
    const first = request.legalActions[0];
    if (first === undefined) throw new Error('decision with no legal actions');
    const targets = (first.targets ?? []).map((slot) => ({
      slot: slot.slot,
      choice: slot.options[0] as string,
    }));
    const response: import('@mtg/shared').DecisionResponse = {
      requestId: request.requestId,
      actionId: first.id,
    };
    if (targets.length > 0) response.targets = targets;
    return response;
  }
}

/**
 * Rule builder: fire when (optionally) the deciding player, prompt, and turn match AND an
 * action matching `option` is on the menu; choose that action. Targets default to the
 * first legal choice per slot; pass a function to pick targets from the request.
 */
export function whenChoose(spec: {
  player?: PlayerId;
  prompt?: RegExp | string;
  turn?: number;
  option: RegExp | string;
  targets?:
    | { slot: number; choice: string }[]
    | ((req: import('@mtg/shared').DecisionRequest) => { slot: number; choice: string }[]);
  once?: boolean;
}): ProviderRule {
  const matches = (text: string, pattern: RegExp | string): boolean =>
    typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
  return {
    once: spec.once ?? true,
    when: (req) =>
      (spec.player === undefined || req.decidingPlayer === spec.player) &&
      (spec.turn === undefined || req.turn === spec.turn) &&
      (spec.prompt === undefined || matches(req.prompt, spec.prompt)) &&
      req.legalActions.some((a) => matches(a.description, spec.option)),
    then: (req) => {
      const action = req.legalActions.find((a) => matches(a.description, spec.option));
      if (action === undefined) throw new Error('rule matched but action vanished');
      const chosen =
        typeof spec.targets === 'function'
          ? spec.targets(req)
          : (spec.targets ??
            (action.targets ?? []).map((slot) => ({
              slot: slot.slot,
              choice: slot.options[0] as string,
            })));
      const response: import('@mtg/shared').DecisionResponse = {
        requestId: req.requestId,
        actionId: action.id,
      };
      if (chosen.length > 0) response.targets = chosen;
      return response;
    },
  };
}

/** Drive an engine to completion with one provider answering every seat. */
export function drive(
  engine: Engine,
  provider: RuleBasedProvider,
): import('@mtg/shared').GameResult {
  for (let i = 0; i < 200_000; i++) {
    const step = engine.advance();
    if (step.kind === 'gameOver') return step.result;
    if (step.kind === 'continue') continue;
    engine.submit(provider.decide(step.request));
  }
  throw new Error('drive(): game did not finish within the decision budget');
}

/** Outcome helper: pick the option whose description matches. */
export function pick(decision: PendingDecision, pattern: RegExp | string): DecisionOutcome {
  const index = decision.options.findIndex((o) =>
    typeof pattern === 'string' ? o.description.includes(pattern) : pattern.test(o.description),
  );
  if (index < 0) {
    throw new Error(
      `no option matching ${String(pattern)} in: ${decision.options.map((o) => o.description).join(' | ')}`,
    );
  }
  return { index, targets: new Map() };
}
