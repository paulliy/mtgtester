import { createHash } from 'node:crypto';
import type { OracleCard } from '@mtg/shared';
import {
  detectCardRoles,
  identityName,
  inferArchetype,
  type ArchetypeInput,
  type CardRole,
} from './archetype';

export const STRATEGY_PROFILE_VERSION = 'strategy-profile-v1';
export type ClaimConfidence = 'high' | 'medium' | 'low';

export interface ProfileClaim<T> {
  value: T;
  confidence: ClaimConfidence;
  evidence: string[];
}

export interface CommanderProfile {
  name: string;
  roles: CardRole[];
  wants: string[];
  risks: string[];
  evidence: string[];
}

export interface StrategyProfile {
  profileVersion: typeof STRATEGY_PROFILE_VERSION;
  sourceDefinitionHash: string;
  identity: string;
  strategy: ProfileClaim<string>;
  theme: ProfileClaim<string | null>;
  curve: { averageNonlandManaValue: number; lands: number; nonlands: number };
  resources: {
    ramp: number;
    cardDraw: number;
    tutors: number;
    spotRemoval: number;
    boardWipes: number;
    counterspells: number;
    recursion: number;
    sacrificeOutlets: number;
  };
  commanders: CommanderProfile[];
  objectives: { early: string[]; mid: string[]; late: string[] };
  supportedWinConditions: Array<ProfileClaim<string>>;
  importantResources: string[];
  interactionPolicy: string[];
  recoveryPlan: string[];
  classifierVersion: string;
}

function definitionsHash(input: ArchetypeInput): string {
  const cards = [
    ...input.commanders.map((card) => ({ card, quantity: 1 })),
    ...(input.companion === null || input.companion === undefined
      ? []
      : [{ card: input.companion, quantity: 1 }]),
    ...input.cards,
  ].sort((a, b) => a.card.oracleId.localeCompare(b.card.oracleId));
  const canonical = cards.map(({ card, quantity }) => ({
    oracleId: card.oracleId,
    quantity,
    name: card.name,
    manaCost: card.manaCost,
    typeLine: card.typeLine,
    oracleText: card.oracleText,
    keywords: [...card.keywords].sort(),
  }));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function commanderProfile(card: OracleCard): CommanderProfile {
  const roles = detectCardRoles(card);
  const text = card.oracleText.toLowerCase();
  const wants: string[] = [];
  if (text.includes('whenever') || text.includes('at the beginning'))
    wants.push('enable repeatable triggers');
  if (text.includes('combat damage') || card.keywords.includes('Double strike'))
    wants.push('connect in combat');
  if (text.includes('sacrifice')) wants.push('maintain expendable permanents');
  if (text.includes('graveyard')) wants.push('preserve graveyard access');
  if (text.includes('counter')) wants.push('develop relevant counters');
  const risks = [
    'commander tax increases after each command-zone cast',
    ...(text.includes('combat') || text.includes('attacks')
      ? ['combat exposure can disrupt the engine']
      : []),
  ];
  return {
    name: card.name,
    roles,
    wants,
    risks,
    evidence: [card.typeLine, ...roles.map((role) => `${card.name}: ${role}`)],
  };
}

/** Offline, deterministic profile generation. It never calls a model and never uses opponents. */
export function buildStrategyProfile(
  input: ArchetypeInput,
  sourceDefinitionHash = definitionsHash(input),
): StrategyProfile {
  const archetype = inferArchetype(input);
  const f = archetype.features;
  const nonlands = Math.max(0, f.totalCards - f.lands);
  const objectives = {
    early: [
      'make land drops',
      ...(f.ramp > 0 ? ['deploy efficient ramp'] : []),
      'establish the deck engine',
    ],
    mid: [
      archetype.theme === null
        ? 'develop synergistic board presence'
        : `advance the ${archetype.theme} plan`,
      'hold interaction for public must-answer threats',
    ],
    late: ['convert accumulated resources into a supported win', 'protect the decisive turn'],
  };
  const supportedWinConditions: Array<ProfileClaim<string>> = [];
  if (f.creatures >= 20) {
    supportedWinConditions.push({
      value: 'combat damage',
      confidence: 'high',
      evidence: [`${f.creatures} creatures`, `${f.aggressiveKeywords} aggressive-keyword cards`],
    });
  }
  if (archetype.theme === 'voltron') {
    supportedWinConditions.push({
      value: 'commander combat damage',
      confidence: 'medium',
      evidence: ['voltron theme signal'],
    });
  }
  if (archetype.strategy === 'combo') {
    supportedWinConditions.push({
      value: 'assembled synergy/combo finish (exact line unverified)',
      confidence: 'low',
      evidence: [`${f.tutors} tutors`, `${f.cardDraw} draw effects`],
    });
  }

  const resourcePairs: Array<[string, number]> = [
    ['mana acceleration', f.ramp],
    ['card draw', f.cardDraw],
    ['tutors', f.tutors],
    ['recursion', f.recursion],
    ['sacrifice outlets', f.sacOutlets],
  ];

  return {
    profileVersion: STRATEGY_PROFILE_VERSION,
    sourceDefinitionHash,
    identity: identityName(input.colorIdentity),
    strategy: {
      value: archetype.strategy,
      confidence: archetype.strategy === 'midrange' ? 'medium' : 'high',
      evidence: [`classifier output: ${archetype.tag}`],
    },
    theme: {
      value: archetype.theme,
      confidence: archetype.theme === null ? 'low' : 'medium',
      evidence: Object.entries(f.themeScores)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 3)
        .map(([theme, score]) => `${theme}:${score}`),
    },
    curve: { averageNonlandManaValue: f.averageManaValue, lands: f.lands, nonlands },
    resources: {
      ramp: f.ramp,
      cardDraw: f.cardDraw,
      tutors: f.tutors,
      spotRemoval: f.spotRemoval,
      boardWipes: f.boardWipes,
      counterspells: f.counterspells,
      recursion: f.recursion,
      sacrificeOutlets: f.sacOutlets,
    },
    commanders: input.commanders.map(commanderProfile),
    objectives,
    supportedWinConditions,
    importantResources: resourcePairs
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 4)
      .map(([name]) => name),
    interactionPolicy: [
      `reserve targeted interaction when possible (${f.spotRemoval + f.counterspells} identified pieces)`,
      `use board wipes selectively (${f.boardWipes} identified)`,
      'prioritize public imminent wins over generic value engines',
    ],
    recoveryPlan: [
      ...(f.recursion > 0 ? ['rebuild through identified recursion'] : []),
      ...(f.cardDraw > 0 ? ['recover cards through identified draw effects'] : []),
      'recast commanders only when their role justifies the increased tax',
    ],
    classifierVersion: 'archetype-v1',
  };
}
