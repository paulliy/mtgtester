/**
 * Answers by name. The engine speaks in object ids that change between runs of nothing; a
 * reviewer, a judge and a case file speak in card names and seats. This module is the only place
 * that translates: an answer into words, an answer against a reviewed `AnswerSpec`, and an
 * `AnswerSpec` into the answer the engine accepts.
 */
import { scenarioAction, scenarioPattern, scenarioTargets } from '../../packages/engine/src';
import {
  ATTACKS_TARGET,
  NO_ATTACK_TARGET,
  NO_BLOCK_TARGET,
  type DecisionRequest,
  type DecisionResponse,
  type GameState,
  type LegalAction,
} from '../../packages/shared/src';
import type { AnswerSpec } from './case';

export type Names = ReadonlyMap<string, string>;

const HOLD = '-';
const ANY = '*';
const ACTS = '+';
const HOLD_SENTINELS: readonly string[] = [NO_ATTACK_TARGET, NO_BLOCK_TARGET];

/** Every object's name by id, across zones; a seat or a sentinel is its own name. */
export function namesOf(state: GameState): Names {
  const names = new Map<string, string>();
  for (const permanent of state.battlefield) names.set(permanent.id, permanent.name);
  for (const object of state.exile) names.set(object.id, object.name);
  for (const player of state.players)
    for (const zone of [player.hand, player.graveyard, player.library, player.commandZone])
      for (const object of zone) names.set(object.id, object.name);
  for (const item of state.stack) names.set(item.id, item.description);
  return names;
}

function nameOf(names: Names, id: string): string {
  if (id === NO_ATTACK_TARGET) return 'stays home';
  if (id === NO_BLOCK_TARGET) return 'does not block';
  if (id === ATTACKS_TARGET) return 'attacks';
  return names.get(id) ?? id;
}

function isDeclaration(action: LegalAction): boolean {
  return action.type === 'attackDeclaration' || action.type === 'blockDeclaration';
}

/** The creature each slot of a declaration is about, by slot index. */
function declarationSubjects(action: LegalAction): string[] {
  const subjects = action.data?.['subjects'];
  if (!Array.isArray(subjects)) return [];
  return subjects.map((subject) =>
    typeof subject === 'object' && subject !== null && 'subjectId' in subject
      ? String((subject as { subjectId: unknown }).subjectId)
      : '',
  );
}

/** The choice an answer makes for each slot, with a one-option slot filled in as the engine does. */
function chosenBySlot(action: LegalAction, response: DecisionResponse): Array<string | undefined> {
  return (action.targets ?? []).map((slot) => {
    const chosen = response.targets?.find((target) => target.slot === slot.slot)?.choice;
    if (chosen !== undefined) return chosen;
    return slot.options.length === 1 ? slot.options[0] : undefined;
  });
}

export interface DescribedAnswer {
  /** The answer in words, for a person. */
  text: string;
  /** The same answer without object ids, equal for two answers that mean the same thing. */
  key: string;
}

/** An answer in words. An answer that names no legal action is described as what was sent. */
export function describeAnswer(
  request: DecisionRequest,
  response: DecisionResponse,
  names: Names,
): DescribedAnswer {
  const action = request.legalActions.find((candidate) => candidate.id === response.actionId);
  if (action === undefined) {
    const text = `(illegal) actionId ${String(response.actionId)}`;
    return { text, key: text };
  }
  const chosen = chosenBySlot(action, response);

  if (isDeclaration(action)) {
    const subjects = declarationSubjects(action);
    const verb = action.type === 'attackDeclaration' ? 'Attack' : 'Block';
    const pairs = chosen.map((choice, index) => ({
      subject: nameOf(names, subjects[index] ?? `slot ${index}`),
      choice,
    }));
    const acting = pairs.filter(
      (pair) => pair.choice !== undefined && !HOLD_SENTINELS.includes(pair.choice),
    );
    const holding = pairs.filter(
      (pair) => pair.choice === undefined || HOLD_SENTINELS.includes(pair.choice),
    );
    const key = `${verb}: ${
      pairs
        .map(
          (pair) =>
            `${pair.subject}=${pair.choice === undefined ? '?' : nameOf(names, pair.choice)}`,
        )
        .sort()
        .join('; ') || 'nothing'
    }`;
    if (acting.length === 0)
      return { text: action.type === 'attackDeclaration' ? 'No attack' : 'No blocks', key };
    const text =
      `${verb}: ${acting.map((pair) => `${pair.subject} → ${nameOf(names, pair.choice!)}`).join(', ')}` +
      (holding.length === 0
        ? ''
        : ` (${holding.map((pair) => pair.subject).join(', ')} ${
            action.type === 'attackDeclaration'
              ? holding.length === 1
                ? 'stays home'
                : 'stay home'
              : holding.length === 1
                ? 'does not block'
                : 'do not block'
          })`);
    return { text, key };
  }

  let text = action.description;
  if (chosen.length > 0)
    text += ` → ${chosen.map((choice) => (choice === undefined ? '?' : nameOf(names, choice))).join(', ')}`;
  if (request.combatDamageSplit !== undefined && response.combatDamageSplit !== undefined)
    text = `Divide ${request.combatDamageSplit.amount} damage: ${Object.entries(
      response.combatDamageSplit,
    )
      .filter(([, amount]) => amount > 0)
      .map(([id, amount]) => `${amount} to ${nameOf(names, id)}`)
      .join(', ')}`;
  if (request.manaSplit !== undefined && response.manaSplit !== undefined)
    text += ` [${Object.entries(response.manaSplit)
      .map(([color, amount]) => `${amount}${color}`)
      .join(' ')}]`;
  return { text, key: text };
}

function choiceMatches(want: string, chosen: string | undefined, names: Names): boolean {
  if (want === ANY) return true;
  if (chosen === undefined) return false;
  if (want === HOLD) return HOLD_SENTINELS.includes(chosen);
  if (want === ACTS) return !HOLD_SENTINELS.includes(chosen);
  return chosen === want || names.get(chosen) === want;
}

/** Whether an answer is the one a reviewed spec names. */
export function matchesAnswer(
  spec: AnswerSpec,
  request: DecisionRequest,
  response: DecisionResponse,
  names: Names,
): boolean {
  const action = request.legalActions.find((candidate) => candidate.id === response.actionId);
  if (action === undefined || !scenarioPattern(spec.choose)(action.description)) return false;
  const chosen = chosenBySlot(action, response);
  if (spec.targets !== undefined) {
    if (spec.targets.length !== chosen.length) return false;
    if (!spec.targets.every((want, index) => choiceMatches(want, chosen[index], names)))
      return false;
  }
  if (spec.assign !== undefined) {
    const subjects = declarationSubjects(action).map((id) => names.get(id) ?? id);
    for (const [subject, want] of Object.entries(spec.assign)) {
      const slots = subjects.flatMap((name, index) => (name === subject ? [index] : []));
      if (slots.length === 0) return false;
      if (!slots.every((index) => choiceMatches(want, chosen[index], names))) return false;
    }
  }
  return true;
}

/**
 * The answer a spec names at this decision, or null when the spec is about some other decision.
 * Throws when the spec matches the decision but names a choice the engine does not offer.
 */
export function buildAnswer(
  spec: AnswerSpec,
  request: DecisionRequest,
  state: GameState,
  /** A table reply written before the tested seat moved: what no longer applies is held back. */
  lenient = false,
): DecisionResponse | null {
  if (spec.split !== undefined) {
    const offered = request.combatDamageSplit;
    const first = request.legalActions[0];
    if (offered === undefined || first === undefined) return null;
    const names = namesOf(state);
    const split: Record<string, number> = {};
    for (const [name, amount] of Object.entries(spec.split)) {
      const id = offered.targets.find((target) => target === name || names.get(target) === name);
      if (id === undefined) {
        if (lenient) return null;
        throw new Error(`damage split names ${name}, which this attacker cannot damage`);
      }
      split[id] = amount;
    }
    return { requestId: request.requestId, actionId: first.id, combatDamageSplit: split };
  }
  const step = {
    player: request.decidingPlayer as 'P1',
    choose: spec.choose,
    ...(spec.prompt !== undefined && { prompt: spec.prompt }),
    ...(spec.targets !== undefined && { targets: spec.targets }),
  };
  const action = scenarioAction(request, step);
  if (action === null) return null;
  const response: DecisionResponse = { requestId: request.requestId, actionId: action.id };
  const slots = action.targets ?? [];
  if (slots.length === 0) return response;

  if (isDeclaration(action) && spec.targets === undefined) {
    const names = namesOf(state);
    const subjects = declarationSubjects(action).map((id) => names.get(id) ?? id);
    const assign = spec.assign ?? {};
    for (const subject of Object.keys(assign))
      if (!lenient && !subjects.includes(subject))
        throw new Error(`"${spec.choose}" assigns ${subject}, which is not in this declaration`);
    response.targets = slots.map((slot, index) => {
      const subject = subjects[index] ?? '';
      const want = assign[subject] ?? HOLD;
      const hold = slot.options.find((candidate) => HOLD_SENTINELS.includes(candidate));
      const named =
        want === HOLD
          ? hold
          : slot.options.find((candidate) => candidate === want || names.get(candidate) === want);
      const option = named ?? (lenient ? (hold ?? slot.options[0]) : undefined);
      if (option === undefined)
        throw new Error(
          `"${spec.choose}": ${subject} cannot choose "${want}" (offered: ${slot.options
            .map((candidate) => names.get(candidate) ?? candidate)
            .join(', ')})`,
        );
      return { slot: slot.slot, choice: option };
    });
    return response;
  }

  const targets = scenarioTargets(state, request, action, step);
  if (targets !== undefined) response.targets = targets;
  return response;
}

/** Every distinct complete answer to a decision, up to `limit`; null when there are more. */
export function enumerateAnswers(
  request: DecisionRequest,
  limit: number,
): DecisionResponse[] | null {
  const answers: DecisionResponse[] = [];
  for (const action of request.legalActions) {
    const slots = action.targets ?? [];
    let combos: Array<Array<{ slot: number; choice: string }>> = [[]];
    for (const slot of slots) {
      const next: typeof combos = [];
      for (const combo of combos)
        for (const option of slot.options)
          next.push([...combo, { slot: slot.slot, choice: option }]);
      combos = next;
      if (combos.length + answers.length > limit) return null;
    }
    for (const combo of combos)
      answers.push({
        requestId: request.requestId,
        actionId: action.id,
        ...(combo.length > 0 && { targets: combo }),
      });
    if (answers.length > limit) return null;
  }
  return answers;
}
