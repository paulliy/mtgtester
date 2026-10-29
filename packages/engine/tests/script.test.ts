import { describe, expect, it } from 'vitest';
import type { GameGen, PendingDecision } from '../src/decisions';
import { pump, pumpStrict } from './fixtures';
import { script } from './script';

const decision = (prompt: string, ...options: string[]): PendingDecision => ({
  decisionType: 'general',
  player: 'P1',
  prompt,
  options: options.map((description) => ({ type: 'choice', description }) as never),
});

/** Asks two questions and returns the descriptions of what was chosen. */
function* twoQuestions(): GameGen<string[]> {
  const first = decision('Choose a mode', 'Draw a card', 'Gain 3 life');
  const a = yield first;
  const second = decision('Sacrifice a creature?', 'Sacrifice Lab Bear', "Don't sacrifice");
  const b = yield second;
  return [first.options[a.index]!.description, second.options[b.index]!.description];
}

function* noQuestions(): GameGen<number> {
  return 7;
  yield decision('never asked'); // keeps this a generator of the right type
}

describe('decision scripts', () => {
  it('answers each expected decision by naming its option', () => {
    const { value } = pump(
      twoQuestions(),
      script([
        { prompt: 'Choose a mode', choose: 'Gain 3 life' },
        { prompt: /Sacrifice/, choose: "Don't" },
      ]),
    );
    expect(value).toEqual(['Gain 3 life', "Don't sacrifice"]);
  });

  it('fails on a decision it did not expect, printing the prompt and options', () => {
    expect(() => pump(twoQuestions(), script([{ prompt: 'Sacrifice', choose: "Don't" }]))).toThrow(
      /expected a different decision:\n.*"Choose a mode"\n.*\[0\] Draw a card/s,
    );
    expect(() =>
      pump(twoQuestions(), script([{ prompt: 'Choose a mode', choose: 'Draw' }])),
    ).toThrow(/no step for this decision/);
  });

  it('fails when an option is named ambiguously or not at all', () => {
    expect(() => pump(twoQuestions(), script([{ prompt: 'Choose a mode', choose: 'a' }]))).toThrow(
      /matches 2 options/,
    );
    expect(() =>
      pump(twoQuestions(), script([{ prompt: 'Choose a mode', choose: 'Mill' }])),
    ).toThrow(/matches 0 options/);
  });

  it('fails on a step left unused when the generator ends', () => {
    expect(() =>
      pump(
        twoQuestions(),
        script([
          { prompt: 'Choose a mode', choose: 'Draw' },
          { prompt: 'Sacrifice', choose: 'Lab Bear' },
          { prompt: 'Scry', choose: 'top', label: 'the scry' },
        ]),
      ),
    ).toThrow(/1 unused step\(s\): the scry/);
  });

  it('strict pumping throws on an unforced decision nothing answers', () => {
    expect(() => pump(twoQuestions(), () => undefined, { strict: true })).toThrow(
      /nothing answers:\n.*"Choose a mode"/s,
    );
    expect(() => pumpStrict(twoQuestions())).toThrow(/nothing answers/);
    expect(pumpStrict(noQuestions()).value).toBe(7);
    // Without `strict` the old behaviour stands: the first option.
    expect(pump(twoQuestions()).value).toEqual(['Draw a card', 'Sacrifice Lab Bear']);
  });
});
