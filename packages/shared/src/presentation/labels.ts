import type { LegalAction } from '../engine';

function data(action: LegalAction, key: string): unknown {
  return action.data?.[key];
}

/** The mana symbols a manual mana activation adds: `["G"]`, `["R", "R"]`. */
export function manaSymbols(action: LegalAction): string[] {
  const value = data(action, 'symbols');
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

/** "Tap for {G}": what a by-hand mana activation does. */
export function manaAbilityLabel(action: LegalAction): string {
  const symbols = manaSymbols(action).map((symbol) => `{${symbol}}`);
  return `Tap for ${symbols.length === 0 ? 'mana' : symbols.join('')}`;
}

function sentenceCase(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

/** How a land enters ("enters tapped"), from the engine's own entry flags; null when untapped. */
function landEntryNote(action: LegalAction): string | null {
  const payLife = data(action, 'payLifeToUntap');
  if (typeof payLife === 'number') return `enters tapped unless you pay ${payLife} life`;
  if (data(action, 'entersTappedConditional') === true) return 'may enter tapped';
  if (data(action, 'entersTapped') === true) return 'enters tapped';
  return null;
}

/**
 * The entry note the label of a land-face play carries. Only the double-faced-land variant has
 * one: an ordinary land play's button has never said how the land enters.
 */
export function entryNote(action: LegalAction): string | null {
  return data(action, 'castVariant') === 'mdfc' ? landEntryNote(action) : null;
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
      return `Play ${name ?? 'land face'}`;
    case 'commanderFree':
      return 'Cast free (you control a commander)';
    case 'nonMana':
      return 'Cast for alternative cost';
    case 'dash':
      return 'Cast with dash';
    case 'energy': {
      const energy = data(action, 'energyCost');
      return typeof energy === 'number' ? `Cast for ${energy} energy` : 'Cast for energy';
    }
    case 'overload':
      return 'Cast with overload';
    case 'bestow':
      return 'Cast with bestow';
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
  if (action.type === 'activateManaAbility') return manaAbilityLabel(action);
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

/** "reduced for target slot 2": the cost of this option depends on its target. */
export function targetHint(action: LegalAction): string | null {
  const slot = data(action, 'targetReductionSlot');
  return action.type === 'castSpell' && typeof slot === 'number' && slot >= 0
    ? `reduced for target slot ${slot + 1}`
    : null;
}

/**
 * The button text split into what it names and the notes beside it. The note and the hint are
 * separate facts so a client can style them; `actionLabel` joins them back.
 */
export function actionLabelParts(action: LegalAction): {
  label: string;
  entryNote: string | null;
  targetHint: string | null;
} {
  return {
    label: primaryActionLabel(action),
    entryNote: entryNote(action),
    targetHint: targetHint(action),
  };
}

export function actionLabel(action: LegalAction): string {
  const parts = actionLabelParts(action);
  const note = parts.entryNote === null ? '' : ` (${parts.entryNote})`;
  const hint = parts.targetHint === null ? '' : ` — ${parts.targetHint}`;
  return `${parts.label}${note}${hint}`;
}
