/**
 * The promotion path for compiled cards (`scripts/card-compiler/promote.ts`): which queue entries
 * may enter the engine, and the check that a promotion added cards and changed nothing else.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '@mtg/engine';
import { pinnedPool, type PinnedRow } from '../../../../scripts/card-compiler/lib';
import {
  additiveViolations,
  renderBatchModule,
  renderIndexModule,
  selectForPromotion,
  strandedReading,
  type PromotionContext,
  type VerifiedTexts,
} from '../../../../scripts/card-compiler/promote';
import type { QueueEntry } from '../../../../scripts/card-compiler/run';

const root = resolve(import.meta.dirname, '../../../..');
const PATCH = 'docs/reviews/card-compiler-trial-01/patches/yavimaya-hollow.json';
const patchBytes = readFileSync(resolve(root, PATCH));
const pinned = new Map(pinnedPool().map((row) => [row.card.name, row]));
const hollow = pinned.get('Yavimaya Hollow')!;

/** Yavimaya Hollow's real queue entry, accepted. Its patch was hand-audited in trial 01. */
const accepted = (over: Partial<QueueEntry> = {}): QueueEntry => ({
  name: 'Yavimaya Hollow',
  oracleId: hollow.card.oracleId,
  source: 'compiler@haiku-worker',
  status: 'compiled-checked',
  handledLines: ['{G}, {T}: Regenerate target creature.'],
  patch: PATCH,
  patchSha256: 'a637eae16db68d9a6a8fab4d67a6a472076d8d9338043183790f192f4a9c48ad',
  trial: 'docs/reviews/card-compiler-trial-01',
  smokeExercised: true,
  review: { verdict: 'accepted', by: 'test' },
  ...over,
});

const context = (over: Partial<PromotionContext> = {}): PromotionContext => ({
  promoted: new Set(),
  hasAuthoredOverride: () => false,
  pinned: (name) => pinned.get(name),
  readPatch: () => patchBytes,
  ...over,
});

const reasons = (entries: QueueEntry[], over: Partial<PromotionContext> = {}): string[] => {
  const { cards, refused } = selectForPromotion(entries, context(over));
  expect(cards).toEqual([]);
  return refused.map((refusal) => refusal.reason);
};

describe('promoting compiled cards', () => {
  it('promotes an accepted, checked, exercised patch with its provenance', () => {
    const { cards, refused } = selectForPromotion([accepted()], context());
    expect(refused).toEqual([]);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card).toMatchObject({
      name: 'Yavimaya Hollow',
      oracleId: hollow.card.oracleId,
      handledLines: ['{G}, {T}: Regenerate target creature.'],
      source: 'compiler@haiku-worker',
      trial: 'docs/reviews/card-compiler-trial-01',
      patchSha256: 'a637eae16db68d9a6a8fab4d67a6a472076d8d9338043183790f192f4a9c48ad',
      acceptedBy: 'test',
    });
    expect(card.def.activatedAbilities).toHaveLength(1);
    expect(card.behaviorSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves a card alone until it is accepted', () => {
    for (const review of [null, { verdict: 'rejected', by: 'test' } as const]) {
      const { cards, refused } = selectForPromotion([accepted({ review })], context());
      expect(cards).toEqual([]);
      expect(refused).toEqual([]);
    }
  });

  it('skips a card that is already promoted, and keeps to the trial asked for', () => {
    const already = selectForPromotion(
      [accepted()],
      context({ promoted: new Set([hollow.card.oracleId]) }),
    );
    expect(already).toEqual({ cards: [], refused: [] });
    const otherTrial = selectForPromotion([accepted()], context(), { trial: 'some/other-trial' });
    expect(otherTrial).toEqual({ cards: [], refused: [] });
  });

  it('refuses a patch whose checks failed, even when it is accepted', () => {
    expect(reasons([accepted({ status: 'smoke-failed' })])).toEqual([
      'its checks ended as smoke-failed',
    ]);
    expect(reasons([accepted({ status: 'invalid' })])).toEqual(['its checks ended as invalid']);
  });

  it('takes a flagged patch the reviewer accepted', () => {
    const { cards } = selectForPromotion([accepted({ status: 'meaning-differs' })], context());
    expect(cards).toHaveLength(1);
  });

  it('refuses a patch whose own ability no smoke game resolved', () => {
    const expected = ['no smoke game resolved its ability or spell'];
    expect(reasons([accepted({ smokeExercised: false })])).toEqual(expected);
    const { smokeExercised: _dropped, ...unknown } = accepted();
    expect(reasons([unknown])).toEqual(expected);
  });

  it('refuses a patch file that changed after review, or is gone', () => {
    expect(
      reasons([accepted()], { readPatch: () => Buffer.from(`${patchBytes.toString()} `) }),
    ).toEqual(['the patch file changed after it was reviewed']);
    expect(reasons([accepted()], { readPatch: () => null })).toEqual([
      `the patch file ${PATCH} is missing`,
    ]);
  });

  it('refuses a card with an authored override, and a card two accepted patches claim', () => {
    expect(reasons([accepted()], { hasAuthoredOverride: () => true })).toEqual([
      'the card already has an authored override',
    ]);
    const both = reasons([accepted(), accepted({ source: 'xmage@31ede542' })]);
    expect(both).toEqual([
      'more than one accepted patch claims this card; reject all but one',
      'more than one accepted patch claims this card; reject all but one',
    ]);
  });

  it('refuses a card the interpreter models without the patch', () => {
    const solRing = pinned.get('Sol Ring')!;
    expect(interpretCard(solRing.card).modeled).toBe(true);
    expect(reasons([accepted({ name: 'Sol Ring', oracleId: solRing.card.oracleId })])).toEqual([
      'the interpreter now models the card without the patch',
    ]);
  });

  it('refuses a patch written for lines the card no longer leaves unparsed', () => {
    // The patch is Yavimaya Hollow's; any other unmodeled card's unparsed line is a different one.
    const other = [...pinned.values()].find(
      (row) => row.card.name !== 'Yavimaya Hollow' && !interpretCard(row.card).modeled,
    )!;
    const moved = Buffer.from(
      JSON.stringify({ ...JSON.parse(patchBytes.toString()), oracleId: other.card.oracleId }),
    );
    expect(
      reasons(
        [
          accepted({
            name: other.card.name,
            oracleId: other.card.oracleId,
            patchSha256: createHash('sha256').update(moved).digest('hex'),
          }),
        ],
        { readPatch: () => moved },
      ),
    ).toEqual(['the lines the patch was written for are no longer the unparsed lines of the card']);
  });
});

describe('a stranded compiled card', () => {
  const card = selectForPromotion([accepted()], context()).cards[0]!;
  const alone = interpretCard(hollow.card);

  it('is unmodeled while the interpreter still cannot read the line', () => {
    expect(alone.modeled).toBe(false);
    expect(strandedReading(hollow, card, () => alone)).toBe('unmodeled');
  });

  it('agrees when the interpreter reads the same behavior, in any ability order', () => {
    // The interpreter's own reading, had it parsed the line: the patch's ability first.
    const reading = (ability: unknown) => (_row: PinnedRow) => ({
      ...alone,
      modeled: true,
      unmodeledReasons: [],
      activatedAbilities: [ability, ...alone.activatedAbilities] as typeof alone.activatedAbilities,
    });
    const ability = card.def.activatedAbilities![0]!;
    expect(strandedReading(hollow, card, reading(ability))).toBe('agrees');
    // Regenerating only a creature you control is a different card.
    const narrowed = JSON.parse(JSON.stringify(ability)) as typeof ability;
    (narrowed.ability.targets[0] as { controller?: string }).controller = 'you';
    expect(strandedReading(hollow, card, reading(narrowed))).toBe('differs');
  });
});

describe('the generated modules', () => {
  it('render an empty registry and a batch in name order', () => {
    expect(renderIndexModule([])).toContain('COMPILED_BATCHES: readonly CompiledBatch[] = [];');
    const index = renderIndexModule(['chunk-02', 'chunk-01']);
    expect(index.indexOf('chunk-01')).toBeLessThan(index.indexOf('chunk-02'));
    expect(index).toContain("import { BATCH_CHUNK_01 } from './batch-chunk-01';");
    const card = selectForPromotion([accepted()], context()).cards[0]!;
    const batch = renderBatchModule('chunk-01', [{ ...card, name: 'Zebra' }, card]);
    expect(batch.indexOf('Yavimaya Hollow')).toBeLessThan(batch.indexOf('Zebra'));
    expect(() => renderBatchModule('Chunk 01', [])).toThrow(/batch id/);
  });
});

describe('a promotion may only add cards', () => {
  const entry = (oracleId: string, name: string, body = 'a') => ({ oracleId, name, body });
  const ratchet = (modeled: string[], fingerprints: Record<string, string>) =>
    JSON.stringify({ fixtureSha256: 'f', modeled, fingerprints });
  const base: VerifiedTexts = {
    overrideDefs: JSON.stringify([entry('o-old', 'Old Override')]),
    interpretDefs: JSON.stringify([entry('i-one', 'One')]),
    interpretDefsPinned: JSON.stringify([entry('i-one', 'One'), entry('o-new', 'New Card')]),
    corpusOutcomes: 'line\tparsed\n',
    modeled: ratchet(['One'], { One: 'aaaa' }),
  };
  const compiled = [{ oracleId: 'o-new', name: 'New Card' }];
  /** The base plus exactly the promotion of New Card. */
  const head: VerifiedTexts = {
    ...base,
    // A promoted card registers under its real id and its name-derived fixture id.
    overrideDefs: JSON.stringify([
      entry('o-old', 'Old Override'),
      entry('o-new', 'New Card'),
      entry('oracle-new-card', 'New Card'),
    ]),
    interpretDefsPinned: JSON.stringify([entry('i-one', 'One'), entry('o-new', 'New Card', 'b')]),
    modeled: ratchet(['One', 'New Card'], { One: 'aaaa', 'New Card': 'bbbb' }),
  };
  const sources = ['packages/engine/src/cards/overrides/compiled/batch-chunk-01.ts'];
  const check = (over: Partial<VerifiedTexts>, changedEngineSources = sources) =>
    additiveViolations({ base, head: { ...head, ...over }, changedEngineSources, compiled })
      .violations;

  it('passes a change that adds the promoted card to each net', () => {
    const result = additiveViolations({ base, head, changedEngineSources: sources, compiled });
    expect(result).toEqual({ promoted: ['New Card'], violations: [] });
  });

  it('fails when engine source outside the generated modules changed', () => {
    expect(check({}, [...sources, 'packages/engine/src/cards/interpret.ts'])).toEqual([
      'engine source changed outside the generated compiled modules: packages/engine/src/cards/interpret.ts',
    ]);
    expect(check({}, ['packages/engine/src/cards/overrides/compiled/register.ts'])).toHaveLength(1);
  });

  it('fails when an existing override changed, vanished, or an unpromoted one appeared', () => {
    expect(
      check({
        overrideDefs: JSON.stringify([entry('o-old', 'Old Override', 'b'), entry('o-new', 'N')]),
      }),
    ).toEqual(['override snapshot entry changed: o-old']);
    expect(check({ overrideDefs: JSON.stringify([entry('o-new', 'New Card')]) })).toEqual([
      'override snapshot lost o-old',
    ]);
    expect(
      check({
        overrideDefs: JSON.stringify([
          entry('o-old', 'Old Override'),
          entry('o-new', 'New Card'),
          entry('o-hand', 'Hand Written'),
        ]),
      }),
    ).toEqual(['override snapshot gained o-hand, which is not a promoted compiled card']);
  });

  it('fails on a stale override snapshot or ratchet', () => {
    expect(check({ overrideDefs: base.overrideDefs })).toEqual([
      'override snapshot is stale: New Card is promoted but not in it',
    ]);
    expect(check({ modeled: base.modeled })).toEqual([
      'the modeled ratchet is stale or New Card does not model: it is promoted but not recorded',
    ]);
  });

  it('fails when another card’s definition changed in any net', () => {
    expect(
      check({
        interpretDefsPinned: JSON.stringify([
          entry('i-one', 'One', 'b'),
          entry('o-new', 'New Card', 'b'),
        ]),
      }),
    ).toEqual([
      'packages/engine/tests/fixtures/interpret-defs-pinned.json changed for i-one, which was not promoted',
    ]);
    expect(check({ corpusOutcomes: 'line\tunparsed\n' })).toEqual([
      'packages/engine/tests/fixtures/one-line-outcomes.tsv changed',
    ]);
    expect(
      check({ modeled: ratchet(['One', 'New Card'], { One: 'cccc', 'New Card': 'bbbb' }) }),
    ).toEqual(['One still models, with a different definition']);
  });

  it('fails when a card regressed, or one outside the promotion newly models', () => {
    expect(check({ modeled: ratchet(['New Card'], { 'New Card': 'bbbb' }) })).toEqual([
      'One no longer models',
    ]);
    expect(
      check({
        modeled: ratchet(['One', 'New Card', 'Stray'], {
          One: 'aaaa',
          'New Card': 'bbbb',
          Stray: 'dddd',
        }),
      }),
    ).toEqual(['Stray newly models, and is not a promoted compiled card']);
  });

  it('fails without fingerprints to compare', () => {
    expect(
      check({ modeled: JSON.stringify({ fixtureSha256: 'f', modeled: ['One', 'New Card'] }) }),
    ).toEqual(['the modeled ratchet has no definition fingerprints to compare']);
  });
});
