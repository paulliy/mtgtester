import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IMPLEMENTED_KEYWORDS } from '@mtg/engine';
import {
  COMPREHENSIVE_RULES_PATH,
  PHRASE_RULES,
  buildScreen,
  candidateRules,
  compilerTrials,
  crKeywords,
  loadRuleEvidence,
  loadScreen,
  loadScreenEvidence,
  loadTrialCards,
  matchEvidence,
  normalizeLine,
  replayScreen,
  screenLines,
  type ScreenRule,
} from './compiler-screen';

const crText = readFileSync(COMPREHENSIVE_RULES_PATH, 'utf8');
const TRIAL_02 = 'docs/reviews/card-compiler-trial-02';

const ruleById = (id: string): ScreenRule => {
  const rule = candidateRules(crText).find((candidate) => candidate.id === id);
  if (rule === undefined) throw new Error(`no candidate rule ${id}`);
  return rule;
};

/**
 * The gain this screen was built for (hill-climb S1). Trial 02 made 305 compile calls; 191 cards
 * were refused. If one of these fails, a change cost the screen catches or, worse, made it decline
 * a card that compiles. Update the floors only when the screen legitimately gets better.
 */
describe('compiler screen: replay of the committed trials', () => {
  it('declines at least 31 of trial 02’s refusals and no card that compiled', () => {
    const replay = replayScreen(loadTrialCards(TRIAL_02), loadRuleEvidence());
    expect(replay.refused).toBe(191);
    expect(replay.acceptedLost).toEqual([]);
    expect(replay.caught).toBeGreaterThanOrEqual(31);
  });

  it('still loses no compiled card when each card is judged by a screen that never saw it', () => {
    for (const trial of compilerTrials()) {
      const replay = replayScreen(loadTrialCards(trial), loadRuleEvidence(), { leaveOneOut: true });
      expect(replay.acceptedLost, trial).toEqual([]);
    }
    const unseen = replayScreen(loadTrialCards(TRIAL_02), loadRuleEvidence(), {
      leaveOneOut: true,
    });
    expect(unseen.caught).toBeGreaterThanOrEqual(11);
  });

  it('declines no line of any modeled card or validated patch', () => {
    const evidence = loadScreenEvidence();
    const { active } = loadScreen();
    for (const { card, line } of [...evidence.modeledLines, ...evidence.acceptedLines]) {
      const hit = screenLines([line], active);
      expect(hit, `${card}: ${line}`).toBeNull();
    }
  });

  it('keeps every confirmed rule tied to a refusal whose reason names the gap', () => {
    const screen = loadScreen();
    for (const rule of screen.active)
      expect(screen.confirmedBy[rule.id]?.length ?? 0, rule.id).toBeGreaterThan(0);
  });
});

describe('compiler screen: rules', () => {
  it('reads keyword actions and abilities from the Comprehensive Rules', () => {
    const { actions, abilities } = crKeywords(crText);
    expect(actions).toContain('exert');
    expect(actions).toContain('the ring tempts you');
    expect(abilities).toContain('evoke');
    expect(abilities).toContain('landwalk');
    expect(abilities.length).toBeGreaterThan(150);
    // 701.1 and 702.1 are general rules, not keywords.
    expect(actions.some((name) => name.includes('keyword'))).toBe(false);
  });

  it('never makes a rule for a keyword the engine implements', () => {
    const ids = new Set(candidateRules(crText).map((rule) => rule.id));
    for (const keyword of IMPLEMENTED_KEYWORDS) expect(ids.has(`ability:${keyword}`)).toBe(false);
  });

  it('gives every rule a unique id', () => {
    const ids = candidateRules(crText).map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PHRASE_RULES.every((rule) => rule.id.startsWith('phrase:'))).toBe(true);
  });

  it('matches keyword abilities as keyword lines or grants, not as stray words', () => {
    const evoke = ruleById('ability:evoke');
    expect(evoke.pattern.test(normalizeLine('Evoke {2}{U}'))).toBe(true);
    expect(evoke.pattern.test(normalizeLine('Flying, evoke {1}{W}'))).toBe(true);
    const landwalk = ruleById('ability:landwalk');
    expect(
      landwalk.pattern.test(normalizeLine('Other Elf creatures get +1/+1 and have forestwalk.')),
    ).toBe(true);
    expect(landwalk.pattern.test(normalizeLine('Islandwalk'))).toBe(true);
    expect(landwalk.pattern.test(normalizeLine('Create a 1/1 token with islandwalk.'))).toBe(true);
    expect(landwalk.pattern.test(normalizeLine('Draw a card. Then walk away.'))).toBe(false);
  });

  it('matches keyword actions in any tense, and ignores reminder text and the card’s name', () => {
    const exert = ruleById('action:exert');
    expect(exert.pattern.test(normalizeLine('{R}, {T}, Exert this land: Add {R}{R}.'))).toBe(true);
    expect(
      exert.pattern.test(normalizeLine('If this creature is exerted, it gains trample.')),
    ).toBe(true);
    const venture = ruleById('action:venture into the dungeon');
    expect(venture.pattern.test(normalizeLine('Venture into the dungeon.'))).toBe(true);
    expect(
      venture.pattern.test(normalizeLine('When it dies, its owner ventures into the dungeon.')),
    ).toBe(true);
    expect(
      exert.pattern.test(normalizeLine('Flying (An exerted creature won’t untap.)', 'Exert Bird')),
    ).toBe(false);
    expect(normalizeLine('When Exert Bird enters, draw a card.', 'Exert Bird')).toBe(
      'when ~ enters, draw a card.',
    );
  });
});

describe('compiler screen: evidence', () => {
  const evoke = (): ScreenRule => ruleById('ability:evoke');
  const refusal = {
    card: 'Mulldrifter',
    line: 'evoke {2}{u}',
    reason: 'evoke’s sacrifice has no op.',
  };

  it('screens only once a refusal whose reason names the keyword confirms it', () => {
    const none = buildScreen(
      matchEvidence([evoke()], { modeledLines: [], acceptedLines: [], refusedLines: [] }),
    );
    expect(none.active).toEqual([]);
    expect(none.unconfirmed.map((rule) => rule.id)).toEqual(['ability:evoke']);

    const otherReason = buildScreen(
      matchEvidence([evoke()], {
        modeledLines: [],
        acceptedLines: [],
        refusedLines: [{ ...refusal, reason: 'no value reads the sacrificed mana value.' }],
      }),
    );
    expect(otherReason.active).toEqual([]);

    const confirmed = buildScreen(
      matchEvidence([evoke()], { modeledLines: [], acceptedLines: [], refusedLines: [refusal] }),
    );
    expect(confirmed.active.map((rule) => rule.id)).toEqual(['ability:evoke']);
    expect(confirmed.confirmedBy['ability:evoke']).toEqual(['Mulldrifter']);
  });

  it('retires a rule as soon as a modeled card or a validated patch uses the wording', () => {
    const modeled = buildScreen(
      matchEvidence([evoke()], {
        modeledLines: [{ card: 'Solitude', line: 'evoke—exile a white card from your hand.' }],
        acceptedLines: [],
        refusedLines: [refusal],
      }),
    );
    expect(modeled.active).toEqual([]);
    expect(modeled.retired[0]!.evidence).toContain('Solitude');

    const accepted = buildScreen(
      matchEvidence([evoke()], {
        modeledLines: [],
        acceptedLines: [{ card: 'Shriekmaw', line: 'evoke {1}{b}' }],
        refusedLines: [refusal],
      }),
    );
    expect(accepted.active).toEqual([]);
    expect(accepted.retired[0]!.evidence).toContain('Shriekmaw');
  });

  it('leaves a card’s own outcome out when asked, so it cannot confirm or retire its own rule', () => {
    const matches = matchEvidence([evoke()], {
      modeledLines: [],
      acceptedLines: [{ card: 'Shriekmaw', line: 'evoke {1}{b}' }],
      refusedLines: [refusal],
    });
    expect(buildScreen(matches, 'Shriekmaw').active.map((rule) => rule.id)).toEqual([
      'ability:evoke',
    ]);
    const onlyMulldrifter = matchEvidence([evoke()], {
      modeledLines: [],
      acceptedLines: [],
      refusedLines: [refusal],
    });
    expect(buildScreen(onlyMulldrifter, 'Mulldrifter').active).toEqual([]);
  });
});
