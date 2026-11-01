/**
 * Test fixtures: oracle-card builders, deck builders, engine harnesses, and a generator
 * pump for exercising internal flow functions directly (brief §12 — fixture-based rules
 * scenarios are the bulk of engine coverage).
 */

import { describeDecision, isScript } from './script';
import type {
  AttackDeclarationSubject,
  BlockDeclarationSubject,
  OracleCard,
  PlayerId,
} from '@mtg/shared';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
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
    supertypes:
      partial.supertypes ??
      (typeLine.split('—')[0] ?? '')
        .trim()
        .split(/\s+/)
        .filter((w) => ['Basic', 'Legendary', 'Snow', 'World'].includes(w)),
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
    ...(partial.backFace !== undefined ? { backFace: partial.backFace } : {}),
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
  // Every other field passes through, so a new GameConfig option cannot be silently dropped.
  const { gameId, seed, ...rest } = overrides ?? {};
  return {
    gameId: gameId ?? 'test-game',
    seed: seed ?? 'test-seed',
    players: seats.map((s, i) => seat(s, i)),
    ...rest,
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
  // Spawned permanents stand in for ones already in play; they entered from no zone.
  delete perm.enteredFromZone;
  perm.summoningSick = opts?.summoningSick ?? false;
  perm.tapped = opts?.tapped ?? false;
  ctx.state.battlefield.push(perm);
  return perm;
}

/**
 * Pump an internal generator to completion. `answer` maps surfaced decisions to outcomes; forced
 * decisions resolve automatically. Without `strict`, an unanswered decision picks option 0; with
 * `{ strict: true }`, or with a `script()` answer, an unforced decision the answer does not handle
 * throws with its prompt and options (ADR 0034 decision 9), and a script with unused steps fails
 * when the generator ends.
 */
export function pump<T>(
  gen: GameGen<T>,
  answer?: (decision: PendingDecision, count: number) => DecisionOutcome | undefined,
  options: { strict?: boolean } = {},
): { value: T; decisions: PendingDecision[] } {
  const strict = options.strict === true || isScript(answer);
  const decisions: PendingDecision[] = [];
  let outcome: DecisionOutcome | undefined;
  for (;;) {
    const step = outcome === undefined ? gen.next() : gen.next(outcome);
    if (step.done === true) {
      if (isScript(answer)) answer.assertDone();
      return { value: step.value, decisions };
    }
    const decision = step.value;
    if (isForced(decision)) {
      outcome = forcedOutcome(decision);
      continue;
    }
    decisions.push(decision);
    const answered = answer?.(decision, decisions.length);
    if (answered === undefined && strict)
      throw new Error(`An unforced decision nothing answers:\n${describeDecision(decision)}`);
    outcome = answered ?? ({ index: 0, targets: new Map() } as DecisionOutcome);
  }
}

/** Pump a generator that should raise no unforced decision; one that does throws. */
export function pumpStrict<T>(gen: GameGen<T>): { value: T; decisions: PendingDecision[] } {
  return pump(gen, undefined, { strict: true });
}

// --- Rule-based provider for whole-game engine tests ---

export interface ProviderRule {
  when: (request: import('@mtg/shared').DecisionRequest) => boolean;
  then: (request: import('@mtg/shared').DecisionRequest) => import('@mtg/shared').DecisionResponse;
  /** Fire at most once; `drive()` fails if a `once` rule never fired. */
  once?: boolean;
  /** Names the rule in failures; `whenChoose` derives one from its matcher. */
  label?: string;
}

export interface RuleBasedProviderOptions {
  /**
   * Answer a decision no rule matches with the first legal action (pass / keep / don't attack /
   * don't block). Without it an unmatched decision throws (ADR 0034 decision 9).
   */
  fallback?: 'first';
}

/**
 * Answers decisions by the first matching rule. An unmatched decision throws unless the provider
 * was built with `{ fallback: 'first' }`.
 */
export class RuleBasedProvider {
  readonly seen: import('@mtg/shared').DecisionRequest[] = [];
  private readonly used = new Set<ProviderRule>();

  constructor(
    private readonly rules: ProviderRule[],
    private readonly options: RuleBasedProviderOptions = {},
  ) {}

  /** Labels of `once` rules that never fired. */
  unfiredOnceRules(): string[] {
    return this.rules
      .map((rule, i) => ({ rule, i }))
      .filter(({ rule }) => rule.once === true && !this.used.has(rule))
      .map(({ rule, i }) => rule.label ?? `rule #${i}`);
  }

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
    if (this.options.fallback !== 'first') {
      throw new Error(
        `RuleBasedProvider: no rule matched the decision "${request.prompt}"; options: ` +
          request.legalActions.map((a) => `[${a.id}] ${a.description}`).join(' | ') +
          ` (pass { fallback: 'first' } to opt in to answering the first option)`,
      );
    }
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
  /** Names the rule when `drive()` reports it unfired; defaults to a description of the matcher. */
  label?: string;
}): ProviderRule {
  const matches = (text: string, pattern: RegExp | string): boolean =>
    typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text);
  const describePattern = (pattern: RegExp | string): string =>
    typeof pattern === 'string' ? JSON.stringify(pattern) : String(pattern);
  const label =
    spec.label ??
    `whenChoose(${[
      spec.player === undefined ? null : `player ${spec.player}`,
      spec.turn === undefined ? null : `turn ${spec.turn}`,
      spec.prompt === undefined ? null : `prompt ${describePattern(spec.prompt)}`,
      `option ${describePattern(spec.option)}`,
    ]
      .filter((part) => part !== null)
      .join(', ')})`;
  return {
    once: spec.once ?? true,
    label,
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

/**
 * Drive an engine to completion with one provider answering every seat. A halted result fails
 * the test (ADR 0034) unless the test is about halting and passes `allowHalt`; so does a `once`
 * rule that never fired.
 */
export function drive(
  engine: Engine,
  provider: RuleBasedProvider,
  { allowHalt = false }: { allowHalt?: boolean } = {},
): import('@mtg/shared').GameResult {
  // Whole-state invariants at every checkpoint (ADR 0034 decision 8). A test that expects a halt
  // keeps the halting behavior: strictInvariants would rethrow an invariant failure instead.
  if (!allowHalt) engine.enableStrictInvariants();
  for (let i = 0; i < 200_000; i++) {
    const step = engine.advance();
    if (step.kind === 'gameOver') {
      if (step.result.halted && !allowHalt) {
        throw new Error(`drive(): the game halted: ${step.result.haltReason ?? 'no reason'}`);
      }
      const unfired = provider.unfiredOnceRules();
      if (unfired.length > 0) {
        throw new Error(
          `drive(): ${unfired.length} once-rule(s) never fired: ${unfired.join('; ')} ` +
            `(set once: false if the rule is defensive)`,
        );
      }
      return step.result;
    }
    if (step.kind === 'continue') continue;
    engine.submit(provider.decide(step.request));
  }
  throw new Error('drive(): game did not finish within the decision budget');
}

/**
 * Outcome helper for the batched `declareAttackers` decision (ADR 0023 items 13/14): call
 * `chooseDefender(subjectId, subject)` for every eligible creature and build the resulting
 * per-slot targets in one outcome, the way a real proposer would. Returning `null` declines that
 * creature — which throws instead of silently no-op'ing if the creature can't legally decline
 * (`subject.mustAttack`), since a test that gets this wrong should fail loudly, not produce a
 * declaration the engine would have rejected.
 */
export function declareAttacks(
  decision: PendingDecision,
  chooseDefender: (subjectId: string, subject: AttackDeclarationSubject) => string | null,
): DecisionOutcome {
  const subjects = decision.presentationAttackDeclaration?.subjects;
  if (subjects === undefined) {
    throw new Error(
      `declareAttacks called on a decision with no attack declaration: ${decision.prompt}`,
    );
  }
  const targets = new Map<number, string>();
  subjects.forEach((subject, i) => {
    const choice = chooseDefender(subject.subjectId, subject);
    if (choice === null) {
      if (subject.mustAttack) {
        throw new Error(
          `${subject.subjectId} must attack (goaded) but chooseDefender returned null`,
        );
      }
      targets.set(i, NO_ATTACK_TARGET);
    } else {
      targets.set(i, choice);
    }
  });
  return { index: 0, targets };
}

/** `declareAttacks` shorthand: nobody attacks. */
export function declareNoAttacks(decision: PendingDecision): DecisionOutcome {
  return declareAttacks(decision, () => null);
}

/**
 * Outcome helper for the batched `declareBlockers` decision (ADR 0023 Phase 4) — the
 * blocker-side mirror of `declareAttacks`: call `chooseAttacker(subjectId, subject)` for every
 * eligible blocker and build the resulting per-slot targets in one outcome. Returning `null`
 * declines that blocker — throws instead of silently no-op'ing if it can't legally decline
 * (`subject.mustBlock`).
 */
export function declareBlocks(
  decision: PendingDecision,
  chooseAttacker: (subjectId: string, subject: BlockDeclarationSubject) => string | null,
): DecisionOutcome {
  const subjects = decision.presentationBlockDeclaration?.subjects;
  if (subjects === undefined) {
    throw new Error(
      `declareBlocks called on a decision with no block declaration: ${decision.prompt}`,
    );
  }
  const targets = new Map<number, string>();
  subjects.forEach((subject, i) => {
    const choice = chooseAttacker(subject.subjectId, subject);
    if (choice === null) {
      if (subject.mustBlock) {
        throw new Error(`${subject.subjectId} must block but chooseAttacker returned null`);
      }
      targets.set(i, NO_BLOCK_TARGET);
    } else {
      targets.set(i, choice);
    }
  });
  return { index: 0, targets };
}

/** `declareBlocks` shorthand: nobody blocks. */
export function declareNoBlocks(decision: PendingDecision): DecisionOutcome {
  return declareBlocks(decision, () => null);
}

/** Outcome helper for the batched `assignCombatDamage` decision (ADR 0023 Phase 4, CR 510.1c-d):
 * supply the exact division as `{ targetId: amount }`. */
export function splitDamage(split: Record<string, number>): DecisionOutcome {
  return { index: 0, targets: new Map(), combatDamageSplit: split };
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
