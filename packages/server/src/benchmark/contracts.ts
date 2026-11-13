import type { DecisionRequest, DecisionResponse, PlayerId, PlayerView } from '@mtg/shared';
import type { AiConfig } from '../ai/config';
import type { RecentSeatDecision, TacticalGuidance } from '../ai/context';
import type { PublicMemorySnapshot } from '../ai/public-memory';
import type { StrategyProfile } from '../decks/strategy-profile';

export type BenchmarkRole = 'tactician' | 'strategist';
export type BenchmarkMode = 'raw' | 'production';
export type EngineAcceptance = 'accepted' | 'rejected' | 'not_checked';

export interface TacticalPattern {
  actionId: number;
  targets?: Array<{ slot: number; choice: string }>;
  manaSplit?: Record<string, number>;
  combatDamageSplit?: Record<string, number>;
}

export interface TacticalGold {
  labelVersion: string;
  acceptable: TacticalPattern[];
  exhaustive: boolean;
  tier: 'excellent' | 'acceptable' | 'critical';
  rationale: string;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
  reviewer: string;
  reviewedAt: string;
  engineSupport: 'supported' | 'partial' | 'unsupported';
}

export interface StrategicGold {
  labelVersion: string;
  acceptableTopThreats?: PlayerId[];
  criticalThreats?: PlayerId[];
  requiredObjectives?: string[];
  forbiddenObjectives?: string[];
  rationale: string;
  evidence: string[];
  confidence: 'high' | 'medium' | 'low';
  reviewer: string;
  reviewedAt: string;
  engineSupport: 'supported' | 'partial' | 'unsupported';
}

export interface CaseEnvelopeBase {
  schemaVersion: 1;
  caseId: string;
  contentHash: string;
  role: BenchmarkRole;
  categories: string[];
  sourceGroup: string;
  observerSeat: PlayerId;
  turn: number;
  phase: string;
  step: string | null;
  eventSequence: number;
  supportedEngineVersion: string;
  supportedCardDefinitionHash: string;
  replayReference?: string;
}

export interface TacticalBenchmarkCase extends CaseEnvelopeBase {
  role: 'tactician';
  input: {
    request: DecisionRequest;
    view: PlayerView;
    guidance: TacticalGuidance;
  };
  gold?: TacticalGold;
}

export interface StrategistBenchmarkCase extends CaseEnvelopeBase {
  role: 'strategist';
  input: {
    request: DecisionRequest;
    view: PlayerView;
    recentDecisions: RecentSeatDecision[];
    publicMemory?: PublicMemorySnapshot;
    profile?: StrategyProfile;
    deckArchetype?: string;
  };
  gold?: StrategicGold;
}

export type BenchmarkCase = TacticalBenchmarkCase | StrategistBenchmarkCase;

export interface BenchmarkVariant {
  variantId: string;
  role: BenchmarkRole;
  mode: BenchmarkMode;
  config: Omit<AiConfig, 'apiKey'>;
  versions: Record<string, string>;
  recovery: { correctiveRetry: boolean; heuristicFallback: boolean; responseCache: boolean };
}

export interface BenchmarkScore {
  labelStatus: 'scored' | 'unscored' | 'ambiguous';
  acceptable?: boolean;
  value?: number;
  metrics: Record<string, number | boolean | string>;
}

export interface BenchmarkResult {
  schemaVersion: 1;
  runId: string;
  variantId: string;
  caseId: string;
  trial: number;
  role: BenchmarkRole;
  mode: BenchmarkMode;
  source: 'model' | 'jev' | 'heuristic' | 'fallback' | 'error';
  rawJsonValidity: boolean;
  schemaValidity: boolean;
  recoverySuccess: boolean;
  menuValidation: boolean | 'not_applicable';
  engineAcceptance: EngineAcceptance;
  semanticDecision?: string;
  response?: DecisionResponse;
  score: BenchmarkScore;
  startedAt: string;
  endedAt: string;
  endToEndMs: number;
  promptTokens?: number;
  responseTokens?: number;
  costUsd?: number;
  costSource: 'reported' | 'estimated' | 'unknown' | 'not_applicable';
  failure?: string;
}

export interface BenchmarkSuite {
  schemaVersion: 1;
  suiteId: string;
  description: string;
  caseFiles: string[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactObject(
  value: unknown,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!record(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown ${label} key: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`${label} is missing ${key}`);
  }
  return value;
}

function stringField(value: Record<string, unknown>, key: string, label: string): void {
  if (typeof value[key] !== 'string') throw new Error(`${label}.${key} must be a string`);
}

function numberField(value: Record<string, unknown>, key: string, label: string): void {
  if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
    throw new Error(`${label}.${key} must be a finite number`);
  }
}

function nonNegativeNumberField(value: Record<string, unknown>, key: string, label: string): void {
  numberField(value, key, label);
  if ((value[key] as number) < 0) throw new Error(`${label}.${key} must be non-negative`);
}

function nonNegativeIntegerField(value: Record<string, unknown>, key: string, label: string): void {
  nonNegativeNumberField(value, key, label);
  if (!Number.isInteger(value[key]))
    throw new Error(`${label}.${key} must be a non-negative integer`);
}

function stringArrayField(value: Record<string, unknown>, key: string, label: string): void {
  if (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === 'string')) {
    throw new Error(`${label}.${key} must be an array of strings`);
  }
}

function validateCard(value: unknown, label: string, narrowed = false): void {
  const required = ['id', 'name'];
  const optional = narrowed ? [] : ['manaCost', 'typeLine', 'oracleText', 'power', 'toughness'];
  const card = exactObject(value, label, required, optional);
  stringField(card, 'id', label);
  stringField(card, 'name', label);
  for (const key of ['manaCost', 'typeLine', 'oracleText'] as const) {
    if (card[key] !== undefined && typeof card[key] !== 'string') {
      throw new Error(`${label}.${key} must be a string`);
    }
  }
  for (const key of ['power', 'toughness'] as const) {
    if (
      card[key] !== undefined &&
      card[key] !== null &&
      (typeof card[key] !== 'number' || !Number.isFinite(card[key]))
    ) {
      throw new Error(`${label}.${key} must be a number or null`);
    }
  }
}

function validateCommander(value: unknown, label: string): void {
  const commander = exactObject(
    value,
    label,
    ['name', 'zone', 'castCount'],
    ['manaCost', 'typeLine', 'oracleText'],
  );
  stringField(commander, 'name', label);
  stringField(commander, 'zone', label);
  nonNegativeIntegerField(commander, 'castCount', label);
  for (const key of ['manaCost', 'typeLine', 'oracleText'] as const) {
    if (commander[key] !== undefined && typeof commander[key] !== 'string') {
      throw new Error(`${label}.${key} must be a string`);
    }
  }
}

function validateCards(value: unknown, label: string, narrowed = false): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((card, index) => validateCard(card, `${label}[${index}]`, narrowed));
}

function validateCommanders(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  value.forEach((commander, index) => validateCommander(commander, `${label}[${index}]`));
}

const PLAYER_VIEW_KEYS = new Set([
  'seat',
  'life',
  'hand',
  'deck',
  'graveyard',
  'commanders',
  'availableMana',
  'energy',
  'manaSources',
  'opponents',
  'revealedLibraryTops',
  'battlefield',
  'exile',
  'stack',
  'recentLog',
]);
const OPPONENT_VIEW_KEYS = new Set([
  'seat',
  'life',
  'handSize',
  'librarySize',
  'graveyard',
  'commanders',
  'poisonCounters',
  'commanderDamageDealtToYou',
]);

function validateViewPrivacy(view: Record<string, unknown>, observerSeat: unknown): void {
  const required = [
    'seat',
    'life',
    'hand',
    'deck',
    'graveyard',
    'commanders',
    'availableMana',
    'manaSources',
    'opponents',
    'battlefield',
    'exile',
    'stack',
    'recentLog',
  ];
  for (const key of required)
    if (!Object.prototype.hasOwnProperty.call(view, key)) throw new Error(`view is missing ${key}`);
  if (view['seat'] !== observerSeat) throw new Error('view.seat must match observerSeat');
  for (const key of Object.keys(view)) {
    if (!PLAYER_VIEW_KEYS.has(key)) throw new Error(`unknown PlayerView key: ${key}`);
  }
  if (view['opponents'] !== undefined) {
    if (!Array.isArray(view['opponents'])) throw new Error('view.opponents must be an array');
    for (const [index, value] of view['opponents'].entries()) {
      const label = `opponent[${index}]`;
      const opponent = exactObject(value, label, [...OPPONENT_VIEW_KEYS]);
      for (const key of ['seat'] as const) stringField(opponent, key, label);
      numberField(opponent, 'life', label);
      for (const key of [
        'handSize',
        'librarySize',
        'poisonCounters',
        'commanderDamageDealtToYou',
      ] as const)
        nonNegativeIntegerField(opponent, key, label);
      validateCards(opponent['graveyard'], `${label}.graveyard`, true);
      validateCommanders(opponent['commanders'], `${label}.commanders`);
    }
  }
  for (const zone of ['hand', 'deck', 'graveyard', 'exile'] as const) {
    validateCards(view[zone], `view.${zone}`);
  }
  validateCommanders(view['commanders'], 'view.commanders');
  numberField(view, 'life', 'view');
  if (!Array.isArray(view['opponents'])) throw new Error('view.opponents must be an array');
  if (view['battlefield'] !== undefined) {
    if (!Array.isArray(view['battlefield'])) throw new Error('view.battlefield must be an array');
    view['battlefield'].forEach((item, index) => {
      const label = `view.battlefield[${index}]`;
      const permanent = exactObject(
        item,
        label,
        ['id', 'controller', 'name', 'tapped', 'status'],
        [
          'typeLine',
          'oracleText',
          'power',
          'toughness',
          'keywords',
          'blockedBy',
          'attacking',
          'attackingPlaneswalker',
        ],
      );
      for (const key of ['id', 'controller', 'name'] as const) stringField(permanent, key, label);
      if (typeof permanent['tapped'] !== 'boolean')
        throw new Error(`${label}.tapped must be boolean`);
      stringArrayField(permanent, 'status', label);
      for (const key of ['typeLine', 'oracleText', 'attacking', 'attackingPlaneswalker'] as const) {
        if (permanent[key] !== undefined && typeof permanent[key] !== 'string')
          throw new Error(`${label}.${key} must be a string`);
      }
      for (const key of ['power', 'toughness'] as const) {
        if (
          permanent[key] !== undefined &&
          permanent[key] !== null &&
          (typeof permanent[key] !== 'number' || !Number.isFinite(permanent[key]))
        )
          throw new Error(`${label}.${key} must be a number or null`);
      }
      for (const key of ['keywords', 'blockedBy'] as const) {
        if (
          permanent[key] !== undefined &&
          (!Array.isArray(permanent[key]) || !permanent[key].every((v) => typeof v === 'string'))
        )
          throw new Error(`${label}.${key} must be an array of strings`);
      }
    });
  }
  if (view['stack'] !== undefined) {
    if (!Array.isArray(view['stack'])) throw new Error('view.stack must be an array');
    view['stack'].forEach((item, index) => {
      const label = `view.stack[${index}]`;
      const stackObject = exactObject(item, label, ['id', 'controller', 'description', 'targets']);
      for (const key of ['id', 'controller', 'description'] as const)
        stringField(stackObject, key, label);
      stringArrayField(stackObject, 'targets', label);
    });
  }
  if (view['revealedLibraryTops'] !== undefined) {
    if (!Array.isArray(view['revealedLibraryTops']))
      throw new Error('view.revealedLibraryTops must be an array');
    view['revealedLibraryTops'].forEach((item, index) => {
      const label = `view.revealedLibraryTops[${index}]`;
      const reveal = exactObject(item, label, ['player', 'card']);
      stringField(reveal, 'player', label);
      validateCard(reveal['card'], `${label}.card`);
    });
  }
  for (const key of ['availableMana'] as const) {
    {
      if (
        !record(view[key]) ||
        !Object.values(view[key]).every(
          (v) => typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0,
        )
      )
        throw new Error(`view.${key} must map symbols to numbers`);
    }
  }
  if (view['energy'] !== undefined) {
    if (
      typeof view['energy'] !== 'number' ||
      !Number.isFinite(view['energy']) ||
      !Number.isInteger(view['energy']) ||
      view['energy'] < 0
    )
      throw new Error('view.energy must be a non-negative integer');
  }
  if (view['manaSources'] !== undefined) {
    if (!Array.isArray(view['manaSources'])) throw new Error('view.manaSources must be an array');
    view['manaSources'].forEach((item, index) => {
      const label = `view.manaSources[${index}]`;
      const source = exactObject(item, label, ['name', 'symbols', 'count']);
      stringField(source, 'name', label);
      stringArrayField(source, 'symbols', label);
      nonNegativeIntegerField(source, 'count', label);
    });
  }
  if (view['recentLog'] !== undefined) stringArrayField(view, 'recentLog', 'view');
}

/** Runtime boundary for committed or captured fixtures; never trust a type assertion from JSON. */
export function parseBenchmarkCase(value: unknown): BenchmarkCase {
  if (!record(value)) throw new Error('benchmark case must be an object');
  exactObject(
    value,
    'benchmark case',
    [
      'schemaVersion',
      'caseId',
      'contentHash',
      'role',
      'categories',
      'sourceGroup',
      'observerSeat',
      'turn',
      'phase',
      'step',
      'eventSequence',
      'supportedEngineVersion',
      'supportedCardDefinitionHash',
      'input',
    ],
    ['replayReference', 'gold'],
  );
  if (value['schemaVersion'] !== 1) throw new Error('unsupported benchmark case schemaVersion');
  if (value['role'] !== 'tactician' && value['role'] !== 'strategist') {
    throw new Error('benchmark case role must be tactician or strategist');
  }
  for (const key of ['caseId', 'contentHash', 'sourceGroup', 'observerSeat']) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new Error(`benchmark case ${key} must be a non-empty string`);
    }
  }
  for (const key of ['phase', 'supportedEngineVersion', 'supportedCardDefinitionHash'])
    stringField(value, key, 'benchmark case');
  if (typeof value['turn'] !== 'number' || !Number.isFinite(value['turn']))
    throw new Error('benchmark case turn must be finite');
  if (value['step'] !== null && typeof value['step'] !== 'string')
    throw new Error('benchmark case step must be a string or null');
  if (typeof value['eventSequence'] !== 'number' || !Number.isFinite(value['eventSequence']))
    throw new Error('benchmark case eventSequence must be finite');
  if (value['replayReference'] !== undefined && typeof value['replayReference'] !== 'string')
    throw new Error('benchmark case replayReference must be a string');
  if (
    !Array.isArray(value['categories']) ||
    !value['categories'].every((v) => typeof v === 'string')
  ) {
    throw new Error('benchmark case categories must be strings');
  }
  const input = value['input'];
  if (!record(input) || !record(input['request']) || !record(input['view'])) {
    throw new Error('benchmark case input must contain request and view objects');
  }
  if (input['request']['decidingPlayer'] !== value['observerSeat']) {
    throw new Error('observerSeat must match request.decidingPlayer');
  }
  validateViewPrivacy(input['view'], value['observerSeat']);
  if (value['role'] === 'tactician' && !record(input['guidance'])) {
    throw new Error('tactician case requires frozen guidance');
  }
  if (value['role'] === 'strategist' && !Array.isArray(input['recentDecisions'])) {
    throw new Error('strategist case requires recentDecisions');
  }
  return value as unknown as BenchmarkCase;
}
