/**
 * Patches with known answers, mixed unmarked into every trial's meaning check.
 *
 * The meaning check is two model calls (back-translate, then judge). A worker that calls every
 * patch "same" produces a chunk that looks excellent, and nothing else in the pipeline would
 * notice. So each trial carries a few calibration cases: patches a person already judged. A case
 * is a card that is not among the trial's own targets, entered at the back-translation stage with
 * an ordinary prompt file, so the worker cannot tell it from a real card.
 *
 * - `same` cases are patches a hand audit found correct (trial 01's and trial 02's audits).
 * - `different` cases are the two patches those audits found wrong, and one deliberately broken
 *   variant of each correct patch, made with the IR mutation operators
 *   (`packages/engine/tests/mutation/operators.ts`): a flipped "you may", a widened target, a
 *   dropped condition or effect, a number off by one. A variant is kept only when it still
 *   validates and its behavior differs from the correct patch.
 *
 * A trial whose check calls a `different` case "same" has a meaning check that cannot be
 * trusted: `report` says so and `queue` refuses the trial until it is judged again.
 *
 *   bun run scripts/card-compiler/calibration.ts          # rebuild calibration.json
 *   bun run scripts/card-compiler/calibration.ts --check  # fail when it is out of date
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { CardDefinition } from '../../packages/engine/src/cards/definition';
import { cardMutants, mutate } from '../../packages/engine/tests/mutation/operators';
import { runPrettier } from '../cards/prettier';
import {
  applyPatch,
  canonicalBehavior,
  compileTarget,
  pinnedPool,
  type CompileTarget,
} from './lib';

export const CALIBRATION_PATH = 'scripts/card-compiler/calibration.json';

export interface CalibrationCase {
  /** `<card slug>` for an audited patch, `<card slug>~<operator>` for a broken variant. */
  id: string;
  /** The card's name: the case travels through a trial under it. */
  name: string;
  /** What a sound meaning check must conclude. */
  expected: 'same' | 'different';
  /** Why the answer is known. */
  origin: string;
  def: Partial<CardDefinition>;
}

const TRIAL_01 = 'docs/reviews/card-compiler-trial-01';
const TRIAL_02 = 'docs/reviews/card-compiler-trial-02';

/** Trial 01: every valid patch was audited by hand. These two were wrong. */
const KNOWN_WRONG: Record<string, string> = {
  'charmbreaker-devils':
    'trial 01 audit: the random graveyard card is made a target; the real card does not target',
  'thran-turbine':
    'trial 01 audit: the mana is restricted to activating abilities; the real card only forbids casting spells',
};

/**
 * Campaign chunks: wrong patches the full audit or the pull request review found, where the error
 * is in what the data says, so a meaning check can see it. Wrong patches whose data reads right
 * and only the engine executes differently (Urza's Mine, Banner of Kinship, Angrath's Marauders)
 * are not here: a back-translation cannot show them, and they belong to the validator. Urza's
 * Power Plant was here and was taken out after chunk 004: its patch reads "a permanent named
 * Urza's Mine", which only differs from the card's "an Urza's Mine" to a reader who knows Urza's
 * Mine is a land type, and two judges in a row read both as names. Voldaren Estate was taken out
 * after chunk 006: its back-translation says "create a Blood artifact token" and nothing more,
 * and three judges in a row called that the card's "create a Blood token", the last one with the
 * token's reminder text in front of it. Telling them apart needs the judge to notice an ability
 * that is absent, which the back-translator is told not to remark on.
 */
const CAMPAIGN_WRONG: { slug: string; trial: string; origin: string }[] = [
  {
    slug: 'lotus-field',
    trial: 'docs/reviews/card-compiler-trial-chunk-001',
    origin:
      'PR #72 review: sacrifices one land, then another, where the card sacrifices two at once',
  },
  {
    slug: 'satyr-wayfinder',
    trial: 'docs/reviews/card-compiler-trial-chunk-002',
    origin: 'chunk 002 audit: reveals only the chosen card; the card reveals all four',
  },
  {
    slug: 'minas-morgul-dark-fortress',
    trial: 'docs/reviews/card-compiler-trial-chunk-002',
    origin: 'chunk 002 audit: the Wraith type is a static of the land, not of the resolved ability',
  },
  {
    slug: 'artifact-mutation',
    trial: 'docs/reviews/card-compiler-trial-chunk-003',
    origin: 'PR #72 review: creates the tokens before destroying the artifact',
  },
  {
    slug: 'planar-engineering',
    trial: 'docs/reviews/card-compiler-trial-chunk-003',
    origin:
      'PR #72 review: sacrifices one land, then another, where the card sacrifices two at once',
  },
];

/** Trial 02: the ten checked patches audited by hand, all correct. */
const TRIAL_02_AUDITED = [
  'scale-the-heights',
  'the-gold-saucer',
  'dogged-detective',
  'bramble-wurm',
  'astral-cornucopia',
  'death-baron',
  'might-of-old-krosa',
  'guardian-of-faith',
  'exsanguinator-cavalry',
  'the-fifth-doctor',
];

interface PatchFile {
  name: string;
  def: Partial<CardDefinition>;
}

const TRIAL_01_PATCHES = [
  'archon-of-the-wild-rose',
  'bloodforged-battle-axe',
  'charmbreaker-devils',
  'cloudpost',
  'damning-verdict',
  'descend-upon-the-sinful',
  'diary-of-dreams',
  'dualcaster-mage',
  'goblin-chainwhirler',
  'hard-hitting-question',
  'horobi-death-s-wail',
  'horrific-assault',
  'on-thin-ice',
  'pulse-of-murasa',
  'samut-vizier-of-naktamun',
  'thran-turbine',
  'thundering-raiju',
  'treeguard-duo',
  'wurmwall-sweeper',
  'yavimaya-hollow',
];

/** A mutant's operator with its numbers taken out: `const 2 + 1` and `const 3 + 1` are one class. */
const operatorClass = (label: string): string =>
  label
    .slice(label.lastIndexOf(': ') + 2)
    .replace(/-?\d+/g, 'N')
    .replace(/\s+/g, ' ');

/**
 * One broken variant of a correct patch: the first mutant, in the operators' fixed order, that
 * still validates and changes behavior, preferring the operator class used least so far.
 */
function brokenVariant(
  target: CompileTarget,
  def: Partial<CardDefinition>,
  used: Map<string, number>,
): { operator: string; label: string; def: Partial<CardDefinition> } | null {
  const original = applyPatch(target, def);
  if (!original.ok || original.definition === null) return null;
  const before = canonicalBehavior(original.definition);
  const whole = def as CardDefinition;
  const candidates = cardMutants(whole).flatMap((mutant, index) => {
    const mutated = mutate(whole, index) as Partial<CardDefinition>;
    const applied = applyPatch(target, mutated);
    if (!applied.ok || applied.definition === null) return [];
    if (canonicalBehavior(applied.definition) === before) return [];
    return [{ operator: operatorClass(mutant.label), label: mutant.label, def: mutated }];
  });
  if (candidates.length === 0) return null;
  const fewest = Math.min(...candidates.map((candidate) => used.get(candidate.operator) ?? 0));
  const chosen = candidates.find((candidate) => (used.get(candidate.operator) ?? 0) === fewest)!;
  used.set(chosen.operator, fewest + 1);
  return chosen;
}

/** The calibration set, built from the audited trial patches as they are on disk. */
export function buildCalibrationSet(): CalibrationCase[] {
  const byName = new Map(pinnedPool().map((row) => [row.card.name, row]));
  const cases: CalibrationCase[] = [];
  const used = new Map<string, number>();
  const sources = [
    ...TRIAL_01_PATCHES.map((slug) => ({ slug, trial: TRIAL_01, audit: 'trial 01 audit' })),
    ...TRIAL_02_AUDITED.map((slug) => ({ slug, trial: TRIAL_02, audit: 'trial 02 audit' })),
    ...CAMPAIGN_WRONG.map(({ slug, trial }) => ({ slug, trial, audit: 'campaign audit' })),
  ];
  const campaignWrong = new Map(CAMPAIGN_WRONG.map((entry) => [entry.slug, entry.origin]));
  for (const { slug, trial, audit } of sources) {
    const patch = JSON.parse(readFileSync(`${trial}/patches/${slug}.json`, 'utf8')) as PatchFile;
    const row = byName.get(patch.name);
    const target = row === undefined ? null : compileTarget(row);
    // A card the interpreter has since learned to read cannot carry a patch any more.
    if (target === null) continue;
    const wrong = KNOWN_WRONG[slug] ?? campaignWrong.get(slug);
    if (wrong !== undefined) {
      cases.push({
        id: slug,
        name: patch.name,
        expected: 'different',
        origin: wrong,
        def: patch.def,
      });
      continue;
    }
    cases.push({
      id: slug,
      name: patch.name,
      expected: 'same',
      origin: `${audit}: correct`,
      def: patch.def,
    });
    const variant = brokenVariant(target, patch.def, used);
    if (variant !== null)
      cases.push({
        id: `${slug}~${variant.operator.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        name: patch.name,
        expected: 'different',
        origin: `broken variant of the ${audit}'s correct patch: ${variant.label}`,
        def: variant.def,
      });
  }
  return cases;
}

export function loadCalibrationSet(): CalibrationCase[] {
  if (!existsSync(CALIBRATION_PATH)) return [];
  return (JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8')) as { cases: CalibrationCase[] }).cases;
}

/**
 * `count` cases for a trial, the same ones every time for the same seed: one case per card, no
 * card the trial compiles itself, and three wrong cases for every two right ones, since a missed
 * wrong patch is the failure this exists to catch.
 */
export function pickCases(
  cases: readonly CalibrationCase[],
  seed: string,
  count: number,
  exclude: ReadonlySet<string>,
): CalibrationCase[] {
  const rank = (item: CalibrationCase): string =>
    createHash('sha256').update(`${seed}|${item.id}`).digest('hex');
  const ordered = cases
    .filter((item) => !exclude.has(item.name))
    .sort((a, b) => rank(a).localeCompare(rank(b)));
  const wrongWanted = Math.ceil((count * 3) / 5);
  const picked: CalibrationCase[] = [];
  const taken = new Set<string>();
  const take = (expected: CalibrationCase['expected'], limit: number): void => {
    for (const item of ordered) {
      if (picked.filter((other) => other.expected === expected).length >= limit) return;
      if (item.expected !== expected || taken.has(item.name)) continue;
      taken.add(item.name);
      picked.push(item);
    }
  };
  take('different', wrongWanted);
  take('same', count - picked.length);
  return picked.sort((a, b) => a.name.localeCompare(b.name));
}

export interface CalibrationScore {
  cases: number;
  /** Cases the check has not finished. */
  pending: string[];
  /** Wrong patches the check called "same": the check cannot be trusted. */
  missed: string[];
  /** Correct patches the check flagged: a review each, not a wrong card. */
  falseAlarms: string[];
}

export function scoreCalibration(
  states: Iterable<{
    name: string;
    stage: string;
    verdict?: 'same' | 'different';
    calibration?: { id: string; expected: 'same' | 'different' };
  }>,
): CalibrationScore {
  const score: CalibrationScore = { cases: 0, pending: [], missed: [], falseAlarms: [] };
  for (const state of states) {
    if (state.calibration === undefined) continue;
    score.cases++;
    if (state.stage !== 'done' || state.verdict === undefined)
      score.pending.push(state.calibration.id);
    else if (state.calibration.expected === 'different' && state.verdict === 'same')
      score.missed.push(state.calibration.id);
    else if (state.calibration.expected === 'same' && state.verdict === 'different')
      score.falseAlarms.push(state.calibration.id);
  }
  return score;
}

function render(cases: readonly CalibrationCase[]): string {
  return `${JSON.stringify({ schemaVersion: 1, cases }, null, 2)}\n`;
}

if (import.meta.main) {
  const cases = buildCalibrationSet();
  const text = render(cases);
  if (process.argv.includes('--check')) {
    const committed = existsSync(CALIBRATION_PATH)
      ? JSON.stringify(JSON.parse(readFileSync(CALIBRATION_PATH, 'utf8')))
      : '';
    if (committed !== JSON.stringify(JSON.parse(text))) {
      console.error(`${CALIBRATION_PATH} is out of date; run scripts/card-compiler/calibration.ts`);
      process.exit(1);
    }
    console.log(`calibration set is up to date (${cases.length} cases)`);
  } else {
    writeFileSync(CALIBRATION_PATH, text);
    runPrettier([CALIBRATION_PATH]);
    const wrong = cases.filter((item) => item.expected === 'different').length;
    console.log(
      `wrote ${cases.length} cases to ${CALIBRATION_PATH}: ${cases.length - wrong} correct, ${wrong} wrong`,
    );
  }
}
