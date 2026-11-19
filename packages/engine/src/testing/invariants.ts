import { EngineInvariantError } from '../errors';
import type { EngineCardObject, EnginePermanent, GameContext } from '../state/types';
import { buildPlayerView } from '../view/view';
import { knownHandOf } from '../state/objects';
import { installCheckpointHook, type CheckpointHook } from './checkpoint-hook';

/**
 * Whole-state invariants (ADR 0034 decision 8), checked after state-based actions at each priority
 * checkpoint of a game run with `strictInvariants`. Each returns a violation per broken rule, in
 * words a failing test can show. The checks read state and build views; they consume no RNG and
 * change nothing, so a game plays the same with them on or off.
 *
 * Test-only: tests and tools install it (`installStateInvariants`); production never imports it.
 */
export function checkStateInvariants(
  ctx: GameContext,
  options: { privacy?: boolean } = {},
): string[] {
  return [
    ...identityViolations(ctx),
    ...attachmentViolations(ctx),
    ...amountViolations(ctx),
    ...(options.privacy === false ? [] : privacyViolations(ctx)),
  ];
}

/**
 * The privacy check builds every seat's view, about 99% of the checker's time (a four-seat game
 * ran three times slower with it at every checkpoint), so the hook runs it at one checkpoint in
 * `PRIVACY_EVERY`, counted per game: deterministic, and drawing no randomness.
 */
const PRIVACY_EVERY = 8;
const CHECKPOINTS = new WeakMap<GameContext, number>();

/** Every object in a zone, phased out, or on the stack (a spell's card included), with where. */
function objectsByZone(
  ctx: GameContext,
): Array<{ where: string; object: EngineCardObject | EnginePermanent }> {
  const s = ctx.state;
  const found: Array<{ where: string; object: EngineCardObject | EnginePermanent }> = [];
  for (const player of s.players) {
    for (const zone of ['hand', 'library', 'graveyard', 'commandZone'] as const)
      for (const object of player[zone]) found.push({ where: `${player.id} ${zone}`, object });
    if (player.companion !== null)
      found.push({ where: `${player.id} companion`, object: player.companion });
  }
  for (const object of s.battlefield) found.push({ where: 'battlefield', object });
  for (const object of s.exile) found.push({ where: 'exile', object });
  for (const { permanent } of s.phasedOut ?? [])
    found.push({ where: 'phased out', object: permanent });
  for (const item of s.stack)
    if (item.card !== null) found.push({ where: 'stack', object: item.card });
  return found;
}

/**
 * Object ids are unique across every zone, phased-out permanents and the stack, and each card is
 * in exactly one place. Tokens and copies of cards (a spell copy, a card copy) have no card of
 * their own and are not counted for the card rule.
 */
function identityViolations(ctx: GameContext): string[] {
  const violations: string[] = [];
  const ids = new Map<string, string>();
  const cards = new Map<string, string>();
  const objects = objectsByZone(ctx);
  for (const item of ctx.state.stack) {
    const seen = ids.get(item.id);
    if (seen !== undefined) violations.push(`object ${item.id} is on the stack and in ${seen}`);
    ids.set(item.id, 'stack');
  }
  for (const { where, object } of objects) {
    const seen = ids.get(object.id);
    if (seen !== undefined && !(where === 'stack' && seen === 'stack'))
      violations.push(`object ${object.id} (${object.name}) is in ${where} and in ${seen}`);
    ids.set(object.id, where);
    if (object.isToken || object.isCardCopy === true) continue;
    const before = cards.get(object.cardId);
    if (before !== undefined)
      violations.push(`card ${object.cardId} (${object.name}) is in ${where} and in ${before}`);
    cards.set(object.cardId, where);
  }
  return violations;
}

/**
 * After state-based actions, each attached permanent's host exists: a permanent, a player, or a
 * graveyard card where the rules allow one (an Aura such as Animate Dead before its trigger
 * resolves, `sba.ts`'s Aura check).
 */
function attachmentViolations(ctx: GameContext): string[] {
  const s = ctx.state;
  const hosts = new Set<string>([
    ...s.battlefield.map((permanent) => permanent.id),
    ...s.players.map((player) => player.id),
    ...s.players.flatMap((player) => player.graveyard.flatMap((card) => [card.id, card.cardId])),
  ]);
  return s.battlefield
    .filter((permanent) => permanent.attachedTo !== null && !hosts.has(permanent.attachedTo))
    .map(
      (permanent) =>
        `${permanent.name} (${permanent.id}) is attached to ${permanent.attachedTo}, which is not a permanent, a player or a graveyard card`,
    );
}

const amountProblem = (value: unknown, nonnegative: boolean): string | null => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    return `is ${String(value)}, not a safe integer`;
  if (nonnegative && value < 0) return `is ${value}, below zero`;
  return null;
};

/** Life totals are safe integers; counters and energy are nonnegative safe integers. */
function amountViolations(ctx: GameContext): string[] {
  const violations: string[] = [];
  const check = (label: string, value: unknown, nonnegative: boolean) => {
    const problem = amountProblem(value, nonnegative);
    if (problem !== null) violations.push(`${label} ${problem}`);
  };
  for (const player of ctx.state.players) {
    check(`${player.id}'s life`, player.life, false);
    check(`${player.id}'s energy`, player.energy, true);
    for (const [counter, count] of Object.entries(player.counters))
      check(`${player.id}'s ${counter} counters`, count, true);
  }
  for (const permanent of ctx.state.battlefield)
    for (const [counter, count] of Object.entries(permanent.counters))
      check(`${permanent.name} (${permanent.id})'s ${counter} counters`, count, true);
  return violations;
}

/** Every string anywhere in a value. */
function strings(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === 'string') into.add(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, into);
  else if (typeof value === 'object' && value !== null)
    for (const item of Object.values(value)) strings(item, into);
  return into;
}

/**
 * No seat's view holds the object id of a card in another player's hand or in any library, except
 * the library cards revealed to that seat. Object ids, not oracle ids: a basic land in a hand
 * shares its oracle id with public ones.
 */
function privacyViolations(ctx: GameContext): string[] {
  const violations: string[] = [];
  for (const seat of ctx.state.players) {
    const view = buildPlayerView(ctx, seat.id);
    const revealed = strings(view.revealedLibraryTops ?? [], new Set());
    const known = strings(
      view.opponents.map((opponent) => opponent.knownHand ?? []),
      new Set(),
    );
    const shown = strings(view, new Set());
    const viewer = ctx.state.players.find((player) => player.id === seat.id)!;
    for (const opponent of view.opponents) {
      const owner = ctx.state.players.find((player) => player.id === opponent.seat)!;
      const live = new Set(knownHandOf(ctx, viewer, owner).map((card) => card.id));
      for (const card of opponent.knownHand ?? [])
        if (!live.has(card.id))
          violations.push(`${seat.id}'s view claims to know ${card.id} in ${owner.id}'s hand`);
    }
    for (const player of ctx.state.players) {
      const hidden = [
        ...(player.id === seat.id ? [] : player.hand.map((card) => ({ card, zone: 'hand' }))),
        ...player.library.map((card) => ({ card, zone: 'library' })),
      ];
      for (const { card, zone } of hidden)
        if (
          shown.has(card.id) &&
          !revealed.has(card.id) &&
          !(zone === 'hand' && known.has(card.id))
        )
          violations.push(`${seat.id}'s view shows ${card.id}, a card in ${player.id}'s ${zone}`);
    }
  }
  return violations;
}

/**
 * Install the checker as the checkpoint hook: a game with `strictInvariants` throws an
 * `EngineInvariantError` naming every violation. Returns a function that restores the previous
 * hook.
 */
export function installStateInvariants(): () => void {
  const hook: CheckpointHook = (ctx) => {
    if (ctx.strictInvariants !== true) return;
    const checkpoint = (CHECKPOINTS.get(ctx) ?? 0) + 1;
    CHECKPOINTS.set(ctx, checkpoint);
    const violations = checkStateInvariants(ctx, { privacy: checkpoint % PRIVACY_EVERY === 0 });
    if (violations.length > 0) throw new EngineInvariantError('state', violations.join('; '));
  };
  const previous = installCheckpointHook(hook);
  return () => {
    installCheckpointHook(previous);
  };
}
