import type { IgnoredPlayerAbility } from '@mtg/shared';
import type { LegalAction } from './protocol';

/**
 * Which separately yieldable choices a source's actions hold, matching the server's
 * `playerYieldKey` (`packages/server/src/match/player-yield.ts`): a spell is one choice, and each
 * activated ability is one choice whatever its modes or X values. Actions the server cannot yield
 * are left out.
 */
export function yieldChoiceKeys(actions: readonly LegalAction[]): Set<string> {
  const keys = new Set<string>();
  for (const action of actions) {
    const source = action.interaction;
    if (source?.kind !== 'source') continue;
    if (action.type === 'castSpell') keys.add(`spell:${source.sourceId}`);
    else if (
      action.type === 'activateAbility' &&
      source.sourceCardId !== undefined &&
      source.abilityIndex !== undefined
    )
      keys.add(`${source.sourceCardId}:${source.abilityIndex}`);
  }
  return keys;
}

/**
 * Whether a "Playable now" row may offer its one-click yield. That link yields a single choice,
 * so it is offered only when the source has exactly one: on a card with several (Liliana's +1 and
 * −3) it read as yielding the card and silently hid only the first ability.
 */
export function rowYieldIsUnambiguous(actions: readonly LegalAction[]): boolean {
  return yieldChoiceKeys(actions).size === 1;
}

/**
 * How many of a permanent's activated abilities the player has yielded, so its row can say so
 * rather than an ability quietly missing. Keyed by the card, as the server keys the preference.
 */
export function yieldedAbilityCount(
  actions: readonly LegalAction[],
  ignored: readonly IgnoredPlayerAbility[],
): number {
  const cardIds = new Set<string>();
  for (const action of actions) {
    const source = action.interaction;
    if (source?.kind === 'source' && source.sourceCardId !== undefined)
      cardIds.add(source.sourceCardId);
  }
  return ignored.filter((entry) => {
    const separator = entry.key.lastIndexOf(':');
    return separator > 0 && cardIds.has(entry.key.slice(0, separator));
  }).length;
}
