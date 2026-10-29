import type { Phase, Step } from './enums';

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

/**
 * Where the turn is, in player terms: "Main phase 1", "Combat · Declare blockers". The one copy
 * of the names: the browser labels its top bar with it and the server rewrites the engine's
 * priority prompt with it.
 */
export function turnPositionLabel(phase: Phase, step: Step | null): string {
  const phaseLabel = PHASE_LABELS[phase];
  return step === null ? phaseLabel : `${phaseLabel} · ${STEP_LABELS[step]}`;
}
