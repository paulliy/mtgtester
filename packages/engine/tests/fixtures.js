/**
 * Test fixtures: oracle-card builders, deck builders, engine harnesses, and a generator
 * pump for exercising internal flow functions directly (brief §12 — fixture-based rules
 * scenarios are the bulk of engine coverage).
 */
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import { forcedOutcome, isForced } from '../src/decisions';
import { Engine } from '../src/engine';
import { makePermanent } from '../src/state/objects';
let oracleCounter = 0;
/** Build an OracleCard with sensible defaults. Oracle id derives from the name. */
export function oracle(partial) {
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
        .split(' — ')[0]
        .split(' '),
    subtypes:
      partial.subtypes ?? (typeLine.includes(' — ') ? typeLine.split(' — ')[1].split(' ') : []),
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
export const forest = () =>
  oracle({
    name: 'Forest',
    typeLine: 'Basic Land — Forest',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
export const island = () =>
  oracle({
    name: 'Island',
    typeLine: 'Basic Land — Island',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
export const mountain = () =>
  oracle({
    name: 'Mountain',
    typeLine: 'Basic Land — Mountain',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
export const plains = () =>
  oracle({
    name: 'Plains',
    typeLine: 'Basic Land — Plains',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
export const swamp = () =>
  oracle({
    name: 'Swamp',
    typeLine: 'Basic Land — Swamp',
    manaCost: null,
    cmc: 0,
    power: null,
    toughness: null,
  });
export const bear = () =>
  oracle({
    name: 'Test Bear',
    typeLine: 'Creature — Bear',
    manaCost: '{1}{G}',
    power: '2',
    toughness: '2',
  });
export const giantGrowth = () =>
  oracle({
    name: 'Test Growth',
    typeLine: 'Instant',
    manaCost: '{G}',
    power: null,
    toughness: null,
    oracleText: 'Target creature gets +3/+3 until end of turn.',
  });
export const bolt = () =>
  oracle({
    name: 'Test Bolt',
    typeLine: 'Instant',
    manaCost: '{R}',
    power: null,
    toughness: null,
    oracleText: 'Test Bolt deals 3 damage to any target.',
  });
export const doom = () =>
  oracle({
    name: 'Test Doom',
    typeLine: 'Instant',
    manaCost: '{B}',
    power: null,
    toughness: null,
    oracleText: 'Destroy target creature.',
  });
export const cancel = () =>
  oracle({
    name: 'Test Cancel',
    typeLine: 'Instant',
    manaCost: '{U}',
    power: null,
    toughness: null,
    oracleText: 'Counter target spell.',
  });
export const divination = () =>
  oracle({
    name: 'Test Divination',
    typeLine: 'Sorcery',
    manaCost: '{1}{U}',
    power: null,
    toughness: null,
    oracleText: 'Draw two cards.',
  });
/** A legendary creature commander in the given color. */
export function commanderFor(color, name) {
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
export function keywordCreature(name, keywords, manaCost = '{1}{W}', pt = '2/2') {
  const [p, t] = pt.split('/');
  return oracle({
    name,
    typeLine: 'Creature — Test Soldier',
    manaCost,
    power: p,
    toughness: t,
    oracleText: keywords, // e.g. "First strike" / "Flying, vigilance"
  });
}
export function seat(spec, index) {
  const id = spec.id ?? `P${index + 1}`;
  const commanders = spec.commanders ?? [spec.commander ?? commanderFor('G', `Test General ${id}`)];
  const config = { id, deckId: `deck-${id}`, commanders, cards: spec.cards };
  if (spec.companion !== undefined) config.companion = spec.companion;
  return config;
}
/** N copies of a card list, expanded. */
export function copies(n, card) {
  return Array.from({ length: n }, card);
}
export function gameConfig(seats, overrides) {
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
export function forestsPod(n = 12) {
  return [0, 1, 2, 3].map(() => ({ cards: copies(n, forest) }));
}
export function makeEngine(seats, overrides) {
  return new Engine(gameConfig(seats, overrides));
}
// --- Direct-generator harness (state surgery for SBA/zone tests) ---
let spawnCounter = 0;
/** Register (interpret) a card's definition in a live game context. */
export function registerDef(ctx, card) {
  if (!ctx.defs.has(card.oracleId)) ctx.defs.set(card.oracleId, interpretCard(card));
  return ctx.defs.get(card.oracleId);
}
export function registerCustomDef(ctx, def) {
  ctx.defs.set(def.oracleId, def);
}
/** Create a card object out of thin air, in the given zone container of its owner. */
export function conjure(ctx, ownerId, card, zone, opts) {
  registerDef(ctx, card);
  const obj = {
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
export function spawn(ctx, controllerId, card, opts) {
  registerDef(ctx, card);
  const obj = {
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
export function pump(gen, answer) {
  const decisions = [];
  let outcome;
  for (;;) {
    const step = outcome === undefined ? gen.next() : gen.next(outcome);
    if (step.done === true) return { value: step.value, decisions };
    const decision = step.value;
    if (isForced(decision)) {
      outcome = forcedOutcome(decision);
      continue;
    }
    decisions.push(decision);
    outcome = answer?.(decision, decisions.length) ?? { index: 0, targets: new Map() };
  }
}
/**
 * Answers decisions by the first matching rule; anything unmatched takes the first
 * option (pass / keep / don't attack / don't block — always the conservative default).
 */
export class RuleBasedProvider {
  rules;
  seen = [];
  used = new Set();
  constructor(rules) {
    this.rules = rules;
  }
  decide(request) {
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
      choice: slot.options[0],
    }));
    const response = {
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
export function whenChoose(spec) {
  const matches = (text, pattern) =>
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
              choice: slot.options[0],
            })));
      const response = {
        requestId: req.requestId,
        actionId: action.id,
      };
      if (chosen.length > 0) response.targets = chosen;
      return response;
    },
  };
}
/** Drive an engine to completion with one provider answering every seat. */
export function drive(engine, provider) {
  for (let i = 0; i < 200_000; i++) {
    const step = engine.advance();
    if (step.kind === 'gameOver') return step.result;
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
export function declareAttacks(decision, chooseDefender) {
  const subjects = decision.presentationAttackDeclaration?.subjects;
  if (subjects === undefined) {
    throw new Error(
      `declareAttacks called on a decision with no attack declaration: ${decision.prompt}`,
    );
  }
  const targets = new Map();
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
export function declareNoAttacks(decision) {
  return declareAttacks(decision, () => null);
}
/**
 * Outcome helper for the batched `declareBlockers` decision (ADR 0023 Phase 4) — the
 * blocker-side mirror of `declareAttacks`: call `chooseAttacker(subjectId, subject)` for every
 * eligible blocker and build the resulting per-slot targets in one outcome. Returning `null`
 * declines that blocker — throws instead of silently no-op'ing if it can't legally decline
 * (`subject.mustBlock`).
 */
export function declareBlocks(decision, chooseAttacker) {
  const subjects = decision.presentationBlockDeclaration?.subjects;
  if (subjects === undefined) {
    throw new Error(
      `declareBlocks called on a decision with no block declaration: ${decision.prompt}`,
    );
  }
  const targets = new Map();
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
export function declareNoBlocks(decision) {
  return declareBlocks(decision, () => null);
}
/** Outcome helper for the batched `assignCombatDamage` decision (ADR 0023 Phase 4, CR 510.1c-d):
 * supply the exact division as `{ targetId: amount }`. */
export function splitDamage(split) {
  return { index: 0, targets: new Map(), combatDamageSplit: split };
}
/** Outcome helper: pick the option whose description matches. */
export function pick(decision, pattern) {
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
//# sourceMappingURL=fixtures.js.map
