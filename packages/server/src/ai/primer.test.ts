import { describe, expect, it } from 'vitest';
import {
  BOT_STRATEGIST_PRIMER,
  RULES_PRIMER,
  STRATEGIST_PRIMER,
  TACTICIAN_COMMON_PRIMER,
  primerCatalog,
  tacticianPrimerFor,
  tacticianPrimerSectionIds,
} from './primer';
import type { DecisionRequest } from '@mtg/shared';

function request(decisionType: DecisionRequest['decisionType']): DecisionRequest {
  return {
    requestId: 'r1',
    gameId: 'g1',
    turn: 1,
    activePlayer: 'P1',
    decidingPlayer: 'P1',
    phase: 'precombatMain',
    step: null,
    decisionType,
    prompt: 'Choose',
    legalActions: [
      { id: 0, type: 'pass', description: 'Pass' },
      { id: 1, type: 'castSpell', description: 'Cast a spell' },
    ],
  };
}

describe('Rules Primer', () => {
  it('is a non-empty string', () => {
    expect(typeof RULES_PRIMER).toBe('string');
    expect(RULES_PRIMER.length).toBeGreaterThan(100);
  });

  it('respects token budget (estimated <= 2,000 tokens)', () => {
    const wordCount = RULES_PRIMER.split(/\s+/).length;
    const estimatedTokens = Math.ceil(wordCount / 0.75);
    expect(estimatedTokens).toBeLessThanOrEqual(2000);
  });

  it('includes key domain terms and concepts', () => {
    const terms = [
      'Commander',
      '40',
      '21',
      'command zone',
      'commander tax',
      'LIFO',
      'APNAP',
      'actionId',
      'requestId',
      'JSON',
      'passAndYieldTurn',
      'yield',
      'turn plan',
    ];
    for (const term of terms) {
      expect(RULES_PRIMER).toContain(term);
    }
  });

  it('does NOT reference the Comprehensive Rules file', () => {
    expect(RULES_PRIMER).not.toContain('Comprehensive Rules');
    expect(RULES_PRIMER).not.toContain('comprehensive-rules.txt');
  });

  it('keeps an ordinary priority primer smaller than the strategist primer', () => {
    const primer = tacticianPrimerFor(request('priority'));
    expect(primer.length).toBeLessThan(STRATEGIST_PRIMER.length);
    expect(primer).not.toContain('attack declaration');
    expect(primer).not.toContain('block declaration');
    expect(primer).not.toContain('combatDamageSplit');
  });

  it('adds only the combat fragment required by the current decision', () => {
    const attackers = tacticianPrimerFor(request('declareAttackers'));
    expect(attackers).toContain('attack declaration');
    expect(attackers).not.toContain('block declaration');

    const blockers = tacticianPrimerFor(request('declareBlockers'));
    expect(blockers).toContain('block declaration');
    expect(blockers).not.toContain('attack declaration');
  });

  it('explains choosing another player’s attackers or blocks only when the decision is that', () => {
    const plain = tacticianPrimerFor(request('declareAttackers'));
    expect(plain).not.toContain('__attacks__');
    expect(plain).not.toContain('belong to the player named');
    const choosing = request('declareAttackers');
    choosing.legalActions = [
      {
        id: 0,
        type: 'attackDeclaration',
        description: 'Choose attackers (2 eligible creatures)',
        data: { chooseAttackers: true },
      },
    ];
    expect(tacticianPrimerFor(choosing)).toContain('"__attacks__"');
    const blocking = request('declareBlockers');
    blocking.legalActions = [
      {
        id: 0,
        type: 'blockDeclaration',
        description: 'Declare blockers (1 eligible creature)',
        data: { blockingPlayer: 'P3' },
      },
    ];
    expect(tacticianPrimerFor(blocking)).toContain('belong to the player named');
    expect(tacticianPrimerFor(blocking)).not.toContain('__attacks__');
  });

  it('exposes a catalog with unique ids and both strategist primers', () => {
    const catalog = primerCatalog();
    const ids = catalog.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const section of catalog) {
      expect(section.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(section.text.length).toBeGreaterThan(20);
      expect(section.appliesWhen.length).toBeGreaterThan(0);
      expect(section.text).not.toContain('```');
    }
    expect(
      catalog.filter((section) => section.role === 'strategist').map((section) => section.id),
    ).toEqual(['strategist', 'strategist-bot-led']);
    expect(catalog.find((section) => section.id === 'strategist')?.text).toBe(STRATEGIST_PRIMER);
    expect(catalog.find((section) => section.id === 'strategist-bot-led')?.text).toBe(
      BOT_STRATEGIST_PRIMER,
    );
    expect(catalog.find((section) => section.id === 'tactician-common')?.text).toBe(
      TACTICIAN_COMMON_PRIMER,
    );
  });

  it('assembles tacticianPrimerFor from the joined catalog sections', () => {
    const catalog = new Map(primerCatalog().map((section) => [section.id, section.text]));
    const split = request('assignCombatDamage');
    split.combatDamageSplit = { amount: 3, targets: ['b1', 'b2'] };
    const targeted = request('priority');
    targeted.legalActions = [
      { id: 0, type: 'playLand', description: 'Play land' },
      {
        id: 1,
        type: 'castSpell',
        description: 'Cast',
        targets: [{ slot: 0, options: ['x'], description: 'target' }],
      },
    ] as DecisionRequest['legalActions'];
    const cases = [
      request('priority'),
      request('declareAttackers'),
      request('declareBlockers'),
      split,
      targeted,
    ];
    for (const req of cases) {
      const ids = tacticianPrimerSectionIds(req);
      expect(ids[0]).toBe('tactician-common');
      expect(tacticianPrimerFor(req)).toBe(ids.map((id) => catalog.get(id)).join('\n\n'));
    }
    expect(tacticianPrimerSectionIds(request('priority'))).toEqual(['tactician-common']);
    expect(tacticianPrimerSectionIds(request('declareAttackers'))).toEqual([
      'tactician-common',
      'tactician-attack',
    ]);
    expect(tacticianPrimerSectionIds(split)).toContain('tactician-combat-damage');
    expect(tacticianPrimerSectionIds(targeted)).toEqual([
      'tactician-common',
      'tactician-land-mana',
      'tactician-targeting',
    ]);
  });

  it('keeps the frozen legacy primer intact', () => {
    expect(RULES_PRIMER).toContain('Declaring attackers');
    expect(RULES_PRIMER).toContain('Dividing combat damage');
    expect(RULES_PRIMER).toContain('REQUIRED JSON OUTPUT FORMAT');
    expect(RULES_PRIMER.length).toBe(6338);
    expect(primerCatalog().some((section) => section.text === RULES_PRIMER)).toBe(false);
  });

  it('keeps the common primer short and the combat guidance specific', () => {
    expect(Math.ceil(TACTICIAN_COMMON_PRIMER.length / 4)).toBeLessThanOrEqual(230);
    expect(TACTICIAN_COMMON_PRIMER).toContain('lethal');
    expect(TACTICIAN_COMMON_PRIMER).toContain('"note"');
    expect(tacticianPrimerFor(request('declareAttackers'))).toContain('bigger untapped blocker');
    expect(tacticianPrimerFor(request('declareBlockers'))).toContain('Chump only');
  });
});
