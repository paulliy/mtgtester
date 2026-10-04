import type { DecisionRequest, PlayerView } from '@mtg/shared';

export interface ManaSourceFeature {
  name: string;
  sourceCount: number;
  alternatives: string[];
}

export interface StateFeatures {
  version: 'state-features-v1';
  exact: {
    legalActionCount: number;
    legalActionTypes: Record<string, number>;
    castableActionIds: number[];
    ownHandSize: number;
    ownBattlefieldCount: number;
    opponentBattlefieldCounts: Record<string, number>;
    stackDepth: number;
    manaPool: Record<string, number>;
    manaSources: ManaSourceFeature[];
  };
  estimates: {
    interactionDensity: { value: number; reasons: string[] };
  };
  lethal: {
    status: 'proven' | 'possible' | 'not_found_within_bound' | 'unknown';
    scope: string;
    assumptions: string[];
  };
}

const CAST_TYPES = new Set(['castSpell', 'playLand', 'activateAbility']);

/** Observation-only features. Legal action generation remains the sole castability authority. */
export function extractStateFeatures(request: DecisionRequest, view: PlayerView): StateFeatures {
  const legalActionTypes: Record<string, number> = {};
  for (const action of request.legalActions) {
    legalActionTypes[action.type] = (legalActionTypes[action.type] ?? 0) + 1;
  }
  const opponentBattlefieldCounts: Record<string, number> = {};
  for (const permanent of view.battlefield) {
    if (permanent.controller === view.seat) continue;
    opponentBattlefieldCounts[permanent.controller] =
      (opponentBattlefieldCounts[permanent.controller] ?? 0) + 1;
  }
  const interactionReasons: string[] = [];
  if (view.stack.length > 0) interactionReasons.push(`${view.stack.length} object(s) on the stack`);
  const targeted = request.legalActions.filter(
    (action) => (action.targets?.length ?? 0) > 0,
  ).length;
  if (targeted > 0) interactionReasons.push(`${targeted} legal action(s) require targets`);
  const responseTypes = request.legalActions.filter((action) =>
    ['castSpell', 'activateAbility', 'chooseTargets'].includes(action.type),
  ).length;
  if (responseTypes > 0) interactionReasons.push(`${responseTypes} interaction-capable option(s)`);

  return {
    version: 'state-features-v1',
    exact: {
      legalActionCount: request.legalActions.length,
      legalActionTypes,
      castableActionIds: request.legalActions
        .filter((action) => CAST_TYPES.has(action.type))
        .map((action) => action.id),
      ownHandSize: view.hand.length,
      ownBattlefieldCount: view.battlefield.filter((p) => p.controller === view.seat).length,
      opponentBattlefieldCounts,
      stackDepth: view.stack.length,
      manaPool: { ...view.availableMana },
      // Alternatives stay grouped per source: never sum W and U from one flexible land twice.
      manaSources: view.manaSources.map((source) => ({
        name: source.name,
        sourceCount: source.count,
        alternatives: [...source.symbols],
      })),
    },
    estimates: {
      interactionDensity: { value: interactionReasons.length, reasons: interactionReasons },
    },
    lethal: {
      status: 'unknown',
      scope: 'no exact lethal solver was run for this snapshot',
      assumptions: [],
    },
  };
}
