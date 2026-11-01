import { describe, expect, it } from 'vitest';
import { RuleBasedProvider, drive, forestsPod, makeEngine, whenChoose } from './fixtures';

describe('RuleBasedProvider fails loud (ADR 0034 decision 9)', () => {
  it('throws on a decision no rule matches, naming the prompt and the options', () => {
    const engine = makeEngine(forestsPod(8), { seed: 'rbp-unmatched' });
    const step = engine.advance();
    if (step.kind !== 'decision') throw new Error('expected a decision');
    const provider = new RuleBasedProvider([whenChoose({ option: /^no such option$/ })]);

    let message = '';
    try {
      provider.decide(step.request);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('no rule matched');
    expect(message).toContain(step.request.prompt);
    for (const action of step.request.legalActions) {
      expect(message).toContain(action.description);
    }
  });

  it('drive() surfaces an unmatched decision as a failure', () => {
    const engine = makeEngine(forestsPod(8), { seed: 'rbp-unmatched-drive' });
    expect(() => drive(engine, new RuleBasedProvider([]))).toThrow(/no rule matched/);
  });

  it("answers the first option when built with { fallback: 'first' }", () => {
    const engine = makeEngine(forestsPod(8), { seed: 'rbp-fallback' });
    const step = engine.advance();
    if (step.kind !== 'decision') throw new Error('expected a decision');
    const provider = new RuleBasedProvider([], { fallback: 'first' });
    expect(provider.decide(step.request).actionId).toBe(step.request.legalActions[0]?.id);
  });

  it('drive() fails when a once-rule never fired, naming the rule', () => {
    const engine = makeEngine(forestsPod(8), { seed: 'rbp-unfired' });
    const provider = new RuleBasedProvider([whenChoose({ option: /^Cast Nonexistent Card$/ })], {
      fallback: 'first',
    });
    expect(() => drive(engine, provider)).toThrow(
      /1 once-rule\(s\) never fired: whenChoose\(option \/\^Cast Nonexistent Card\$\/\)/,
    );
  });

  it('drive() reports an explicit label and lists every unfired rule', () => {
    const engine = makeEngine(forestsPod(8), { seed: 'rbp-unfired-labels' });
    const provider = new RuleBasedProvider(
      [
        whenChoose({ option: /^Cast Nonexistent Card$/, label: 'cast the missing card' }),
        whenChoose({ option: 'Activate nothing', turn: 3 }),
      ],
      { fallback: 'first' },
    );
    expect(() => drive(engine, provider)).toThrow(
      /2 once-rule\(s\) never fired: cast the missing card; whenChoose\(turn 3, option "Activate nothing"\)/,
    );
  });

  it('drive() accepts an unfired rule marked once: false, and a once-rule that fired', () => {
    const defensive = makeEngine(forestsPod(8), { seed: 'rbp-defensive' });
    const defensiveProvider = new RuleBasedProvider(
      [whenChoose({ option: /^Cast Nonexistent Card$/, once: false })],
      { fallback: 'first' },
    );
    expect(drive(defensive, defensiveProvider).halted).toBe(false);
    expect(defensiveProvider.unfiredOnceRules()).toEqual([]);

    const firing = makeEngine(forestsPod(8), { seed: 'rbp-fired' });
    const firingProvider = new RuleBasedProvider([whenChoose({ option: /^Play / })], {
      fallback: 'first',
    });
    expect(drive(firing, firingProvider).halted).toBe(false);
    expect(firingProvider.unfiredOnceRules()).toEqual([]);
  });
});
