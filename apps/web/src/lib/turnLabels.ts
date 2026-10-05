import { PHASES, STEPS, type Phase, type Step } from '@mtg/shared';

const PHASE_LABELS: Record<Phase, string> = {
  beginning: 'Beginning',
  precombatMain: 'Main phase 1',
  combat: 'Combat',
  postcombatMain: 'Main phase 2',
  ending: 'Ending',
};

const STEP_LABELS: Record<Step, string> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  beginCombat: 'Beginning of combat',
  declareAttackers: 'Declare attackers',
  declareBlockers: 'Declare blockers',
  firstStrikeCombatDamage: 'First-strike damage',
  combatDamage: 'Combat damage',
  endCombat: 'End of combat',
  end: 'End step',
  cleanup: 'Cleanup',
};

/** Where the turn is, in player terms: "Main phase 1", "Combat · Declare blockers". */
export function turnPositionLabel(phase: Phase, step: Step | null): string {
  const phaseLabel = PHASE_LABELS[phase];
  return step === null ? phaseLabel : `${phaseLabel} · ${STEP_LABELS[step]}`;
}

const isPhase = (value: string): value is Phase => (PHASES as readonly string[]).includes(value);
const isStep = (value: string): value is Step => (STEPS as readonly string[]).includes(value);

/**
 * The engine's priority prompt names the turn position with its internal identifiers
 * ("You have priority (precombatMain)."). Rewrite only a parenthetical made of real phase/step
 * names, so any other prompt text passes through untouched.
 */
export function playerFacingPrompt(prompt: string): string {
  return prompt.replace(/\((\w+)(?:, (\w+))?\)/g, (match, phase: string, step?: string) => {
    if (!isPhase(phase)) return match;
    if (step === undefined) return `(${turnPositionLabel(phase, null)})`;
    return isStep(step) ? `(${turnPositionLabel(phase, step)})` : match;
  });
}
