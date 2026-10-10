import type { LegalAction } from '@mtg/shared';

function data(action: LegalAction, key: string): unknown {
  return action.data?.[key];
}

function sentenceCase(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

/** "(enters tapped)" and friends for a land play, from the engine's own entry flags. */
function landEntryNote(action: LegalAction): string {
  const payLife = data(action, 'payLifeToUntap');
  if (typeof payLife === 'number') return ` (enters tapped unless you pay ${payLife} life)`;
  if (data(action, 'entersTappedConditional') === true) return ' (may enter tapped)';
  if (data(action, 'entersTapped') === true) return ' (enters tapped)';
  return '';
}

/**
 * A player-facing label for an alternative way to cast or play a card. The engine's
 * `castVariant` values (`mdfc`, `commanderFree`, `nonMana`, …) are identifiers, never labels:
 * the browser trial showed a double-faced land's only button reading "Mdfc".
 */
function variantLabel(action: LegalAction, variant: string): string {
  const source = data(action, 'sourceName');
  const name = typeof source === 'string' ? source : null;
  switch (variant) {
    case 'mdfc':
      return `Play ${name ?? 'land face'}${landEntryNote(action)}`;
    case 'commanderFree':
      return 'Cast free (you control a commander)';
    case 'nonMana':
      return 'Cast for alternative cost';
    case 'energy': {
      const energy = data(action, 'energyCost');
      return typeof energy === 'number' ? `Cast for ${energy} energy` : 'Cast for energy';
    }
    case 'overload':
      return 'Cast with overload';
    case 'adventure':
      return name === null ? 'Cast adventure' : `Cast ${name} (adventure)`;
    case 'omen':
      return name === null ? 'Cast omen' : `Cast ${name} (omen)`;
    default:
      return action.description;
  }
}

/** The text on an action's button in the source panel. */
function primaryActionLabel(action: LegalAction): string {
  const mode = data(action, 'modeLabel');
  const variant = data(action, 'castVariant');
  const ability = data(action, 'abilityDescription');
  // Mode labels come straight from Oracle bullets, often lowercased by the parser.
  if (typeof mode === 'string') return sentenceCase(mode);
  if (typeof variant === 'string') return variantLabel(action, variant);
  if (typeof ability === 'string') return ability;
  if (action.type === 'playLand') return 'Play land';
  if (action.type === 'castSpell') {
    // Replicate, squad and kicker counts are separate cast options with the same verb.
    const count = data(action, 'optionalCostCount');
    const mechanic = data(action, 'optionalMechanic');
    if (typeof count === 'number' && count > 0 && typeof mechanic === 'string') {
      return `Cast with ${mechanic} ${count}`;
    }
    return 'Cast';
  }
  // Combat actions (attack/block) land here: falling back to `action.type` renders every
  // option in a source's button list as the same bare word ("attack", "block", …), which is
  // indistinguishable when a creature can attack three different opponents. `description` is
  // already the full sentence the engine generated ("Grizzly Bears attacks P2 (40 life)").
  return action.description;
}

export function actionLabel(action: LegalAction): string {
  const label = primaryActionLabel(action);
  const slot = data(action, 'targetReductionSlot');
  return action.type === 'castSpell' && typeof slot === 'number' && slot >= 0
    ? `${label} — reduced for target slot ${slot + 1}`
    : label;
}
