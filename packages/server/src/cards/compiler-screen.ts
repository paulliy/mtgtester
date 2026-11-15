/**
 * The card compiler's pre-call screen (hill-climb suggestion S1).
 *
 * Most compile calls in trial 02 (191 of 300) ended with the model answering `inexpressible`,
 * because the line needs an engine primitive the IR does not have. Many of those primitives can be
 * named from the text alone: an unimplemented keyword ability (evoke, devour, forestwalk), an
 * unimplemented keyword action (exert, vote, the Ring tempts you), or a phrase whose primitive is
 * known to be missing (triple damage, "at random"). The screen finds those lines before a model
 * is called, so the card is declined for free with the same kind of reason.
 *
 * The screen must never cost an accepted card, so every rule retires itself on evidence:
 *
 * - A keyword in the engine's `IMPLEMENTED_KEYWORDS` is never screened.
 * - A rule that matches any line of a modeled card in the pinned EDHREC pool is retired, since the
 *   interpreter already reads that wording somewhere.
 * - A rule that matches any line of a patch the compiler or a translator got through validation
 *   (the review queue) is retired, since the IR could say it.
 *
 * So when the engine gains a primitive and the first card using it is modeled, its rule drops out
 * on its own. Keyword rules come from the Comprehensive Rules (701 and 702), not from trial data.
 * Only `PHRASE_RULES` were written by hand, from the refusal reasons of trials 01 and 02.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { IMPLEMENTED_KEYWORDS } from '@mtg/engine';
import { MODELED_RATCHET_PATH, PINNED_ORACLE_PATH, type PinnedCard } from './edhrec-pins';

export const COMPREHENSIVE_RULES_PATH = 'docs/rules/comprehensive-rules.txt';
export const REVIEW_QUEUE_PATH = 'docs/reviews/compiled-card-queue.json';
const REVIEWS_DIR = 'docs/reviews';

export interface ScreenRule {
  /** `action:exert`, `ability:evoke`, or `phrase:<slug>`. */
  id: string;
  kind: 'keyword-action' | 'keyword-ability' | 'phrase';
  /** What the engine is missing, worded as a compiler refusal reason. */
  missing: string;
  pattern: RegExp;
  /**
   * What a refusal reason must say for a refused line to confirm this rule, so a line refused
   * for some other gap does not confirm it.
   */
  confirm: RegExp;
}

export interface RetiredRule {
  rule: ScreenRule;
  /** Why the rule is off: an implemented keyword, or the first line that shows support. */
  evidence: string;
}

export interface ScreenHit {
  rule: ScreenRule;
  line: string;
}

/**
 * Rules for missing primitives that are not keywords. Each was named by at least one compiler
 * refusal in trials 01 and 02, and each is still retired automatically by the same evidence.
 */
export const PHRASE_RULES: readonly Omit<ScreenRule, 'kind'>[] = [
  {
    id: 'phrase:triple-damage',
    missing: 'Damage can be doubled or halved, but not tripled.',
    pattern: /\btriple that damage\b/,
    confirm: /\btripl/,
  },
  {
    id: 'phrase:random-choice',
    missing: 'No effect chooses a permanent, player or card at random.',
    pattern: /\bat random\b/,
    confirm: /\brandom/,
  },
  {
    id: 'phrase:dice',
    missing: 'No effect rolls a die.',
    pattern: /\broll (?:a|two|three|\w+) (?:d\d+|dice|die)\b/,
    confirm: /\b(?:die|dice)\b/,
  },
  {
    id: 'phrase:win-or-lose-game',
    missing: 'No effect or static makes a player win the game or unable to lose it.',
    pattern: /\b(?:you|that player) wins? the game\b|\bcan't (?:lose|win) the game\b/,
    confirm: /\b(?:win|lose) the game\b/,
  },
  {
    id: 'phrase:rounded',
    missing: 'No value divides a number (half, rounded up or down).',
    pattern: /\brounded (?:up|down)\b/,
    confirm: /\b(?:half|round|divi)/,
  },
  {
    id: 'phrase:hand-size-reduced',
    missing: 'No static changes a player’s maximum hand size by a number.',
    pattern: /\bmaximum hand size is (?:reduced|increased)\b/,
    confirm: /\bhand size\b/,
  },
  {
    id: 'phrase:piles',
    missing: 'No effect separates cards into piles for a player to choose between.',
    pattern: /\b(?:face-down pile|into two piles|separates? .* into two piles)\b/,
    confirm: /\bpiles?\b/,
  },
  {
    id: 'phrase:seat-direction',
    missing: 'No reference to the player to your left or right.',
    pattern: /\bplayer to your (?:left|right)\b/,
    confirm: /\bto your (?:left|right)\b/,
  },
  {
    id: 'phrase:same-name-as-target',
    missing: 'No selector matches permanents with the same name as a chosen target.',
    pattern: /\ball other permanents with the same name as that permanent\b/,
    confirm: /\bsame name\b/,
  },
  {
    id: 'phrase:announced-x-target-count',
    missing: 'Target counts are fixed numbers and cannot be the announced X.',
    pattern: /\b(?:untap|tap|destroy|exile|gain control of|return) x target\b/,
    confirm: /\bannounced x\b|\bx target|\bnumber of target/,
  },
  {
    id: 'phrase:excess-damage',
    missing: 'No value reads the excess damage an effect dealt.',
    pattern: /\bexcess damage\b/,
    confirm: /\bexcess\b/,
  },
];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The keyword names in CR 701 (actions) and 702 (abilities), lowercased. */
export function crKeywords(crText: string): { actions: string[]; abilities: string[] } {
  const actions: string[] = [];
  const abilities: string[] = [];
  for (const match of crText.matchAll(/^70([12])\.(\d+)\. ([^\r\n]+?)\s*$/gm)) {
    const [, section, number, title] = match;
    // 701.1 and 702.1 are general rules, not keywords; titles of rules are short names.
    if (number === '1' || title!.length > 40 || /[.:]/.test(title!.replace(/!$/, ''))) continue;
    (section === '1' ? actions : abilities).push(title!.toLowerCase());
  }
  return { actions, abilities };
}

/** The keyword named in a refusal reason, by its whole name (the first word in any tense). */
function termPattern(name: string): RegExp {
  const [first, ...rest] = name.split(' ');
  const tail = rest.length === 0 ? '' : ` ${rest.map(escape).join(' ')}`;
  return new RegExp(`\\b${escape(first!)}\\w*${tail}`);
}

/** How a keyword action is used in rules text: the verb, inflected on its first word. */
function actionPattern(action: string): RegExp {
  const [first, ...rest] = action.split(' ');
  const tail = rest.length === 0 ? '' : ` ${rest.map(escape).join(' ')}`;
  return new RegExp(`\\b${escape(first!)}(?:s|es|ed|d|ing)?${tail}\\b`);
}

/**
 * How a keyword ability is used: as a keyword line (alone or in a comma list, with its cost or
 * number), or granted ("has", "have", "gain", "gains", "with"). Landwalk is matched by its
 * variants (forestwalk, islandwalk, ...).
 */
function abilityPattern(ability: string): RegExp {
  const name = ability === 'landwalk' ? '[a-z]+walk' : escape(ability);
  const end = /\w$/.test(ability) ? '\\b' : '';
  return new RegExp(
    `(?:^|^(?:[a-z' -]+, )+|\\b(?:has|have|gains?|with) (?:[a-z' -]+(?:, | and | or ))*)${name}${end}`,
  );
}

/** Every rule before retirement: CR keywords the engine does not implement, then phrases. */
export function candidateRules(crText: string): ScreenRule[] {
  const implemented = new Set<string>(IMPLEMENTED_KEYWORDS);
  const { actions, abilities } = crKeywords(crText);
  const rules: ScreenRule[] = [];
  for (const action of actions) {
    // "Tap and Untap" and similar double titles name two plain verbs, not one action.
    for (const name of action.split(' and ')) {
      rules.push({
        id: `action:${name}`,
        kind: 'keyword-action',
        missing: `The IR has no keyword action "${name}".`,
        pattern: actionPattern(name),
        confirm: termPattern(name),
      });
    }
  }
  for (const ability of abilities) {
    for (const name of ability.split(' and ')) {
      if (implemented.has(name)) continue;
      rules.push({
        id: `ability:${name}`,
        kind: 'keyword-ability',
        missing: `"${name}" is not an implemented keyword ability.`,
        pattern: abilityPattern(name),
        confirm: name === 'landwalk' ? /walk\b/ : termPattern(name),
      });
    }
  }
  for (const phrase of PHRASE_RULES) rules.push({ ...phrase, kind: 'phrase' });
  return rules;
}

/**
 * One rules line as the screen reads it: lowercased, reminder text removed, and the card's own
 * name written as `~`, the way the compiler's target lines already are.
 */
export function normalizeLine(line: string, cardName?: string): string {
  let text = line.replace(/\([^)]*\)/g, ' ');
  if (cardName !== undefined) {
    for (const name of [cardName, ...cardName.split(' // ')])
      if (name.length > 0) text = text.split(name).join('~');
  }
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Where the screen looks for evidence that a primitive exists, or is missing. */
export interface ScreenEvidence {
  /** Lines (normalized) of cards the interpreter models. */
  modeledLines: EvidenceLine[];
  /** Lines (normalized) a validated patch handled. */
  acceptedLines: EvidenceLine[];
  /** Lines (normalized) of cards a compile call answered `inexpressible` for. */
  refusedLines: EvidenceLine[];
}

export interface EvidenceLine {
  card: string;
  line: string;
  /** For a refusal: the model's reason, lowercased. */
  reason?: string;
}

export interface Screen {
  /** Confirmed missing: some refusal matches it, and nothing shows support. These screen cards. */
  active: ScreenRule[];
  /** Nothing shows support, but no refusal has confirmed the gap yet. These screen nothing. */
  unconfirmed: ScreenRule[];
  retired: RetiredRule[];
  /** The refused cards that confirm each active rule. */
  confirmedBy: Record<string, string[]>;
}

/** Every evidence line a candidate rule matches, found once so a screen can be rebuilt cheaply. */
export interface RuleEvidence {
  rule: ScreenRule;
  /** The first modeled line it matches; modeled cards are never compile targets. */
  modeled: EvidenceLine | undefined;
  accepted: EvidenceLine[];
  refused: EvidenceLine[];
}

export function matchEvidence(candidates: ScreenRule[], evidence: ScreenEvidence): RuleEvidence[] {
  return candidates.map((rule) => ({
    rule,
    modeled: evidence.modeledLines.find(({ line }) => rule.pattern.test(line)),
    accepted: evidence.acceptedLines.filter(({ line }) => rule.pattern.test(line)),
    refused: evidence.refusedLines.filter(
      ({ line, reason }) => rule.pattern.test(line) && rule.confirm.test(reason ?? ''),
    ),
  }));
}

/**
 * Sorts candidates into active, unconfirmed and retired rules. A rule screens cards only once a
 * compile call has refused a line it matches: an unimplemented keyword is often still expressible
 * from general ops (trial 02 compiled transmute and For Mirrodin! that way), so absence of support
 * alone is not enough. `without` leaves one card's own outcome out of the evidence, which is how
 * the screen is measured on cards it has not learned from.
 */
export function buildScreen(matches: readonly RuleEvidence[], without?: string): Screen {
  const screen: Screen = { active: [], unconfirmed: [], retired: [], confirmedBy: {} };
  for (const { rule, modeled, accepted, refused } of matches) {
    if (modeled !== undefined) {
      screen.retired.push({ rule, evidence: `modeled card ${modeled.card}: "${modeled.line}"` });
      continue;
    }
    const support = accepted.find(({ card }) => card !== without);
    if (support !== undefined) {
      screen.retired.push({
        rule,
        evidence: `validated patch for ${support.card}: "${support.line}"`,
      });
      continue;
    }
    const confirming = [...new Set(refused.map(({ card }) => card))].filter(
      (card) => card !== without,
    );
    if (confirming.length === 0) {
      screen.unconfirmed.push(rule);
      continue;
    }
    screen.active.push(rule);
    screen.confirmedBy[rule.id] = confirming;
  }
  return screen;
}

/** The first line of a card that names a known-missing primitive, or null when it may compile. */
export function screenLines(
  lines: readonly string[],
  rules: readonly ScreenRule[],
  cardName?: string,
): ScreenHit | null {
  for (const raw of lines) {
    const line = normalizeLine(raw, cardName);
    for (const rule of rules) if (rule.pattern.test(line)) return { rule, line: raw };
  }
  return null;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** One compiler-trial card and how its compile call ended. */
export interface TrialCard {
  name: string;
  lines: string[];
  /** `refused`: the model answered inexpressible. `accepted`: it produced a valid patch. */
  outcome: 'refused' | 'accepted';
  /** The model's reason, for a refusal. */
  reason?: string;
}

interface TrialState {
  name: string;
  lines: string[];
  stage: string;
  valid?: boolean;
  inexpressibleReason?: string;
}

/** Every committed compiler trial (`docs/reviews/card-compiler-trial-*`) with recorded outcomes. */
export function compilerTrials(): string[] {
  return readdirSync(REVIEWS_DIR)
    .filter((name) => /^card-compiler-trial-\d+$/.test(name))
    .map((name) => `${REVIEWS_DIR}/${name}`)
    .filter((trial) => existsSync(`${trial}/work/state.json`))
    .sort();
}

/**
 * The cards of a committed trial whose compile call ended: refused, or a patch that validated.
 * Cards still pending or answered with an invalid patch are left out.
 */
export function loadTrialCards(trial: string): TrialCard[] {
  const cards: TrialCard[] = [];
  for (const state of readJson<TrialState[]>(`${trial}/work/state.json`)) {
    if (state.stage === 'inexpressible')
      cards.push({
        name: state.name,
        lines: state.lines,
        outcome: 'refused',
        reason: state.inexpressibleReason ?? '',
      });
    else if (state.valid === true)
      cards.push({ name: state.name, lines: state.lines, outcome: 'accepted' });
  }
  return cards;
}

interface QueueFile {
  cards: { name: string; handledLines: string[] }[];
}

/**
 * The evidence from the committed fixtures: the pinned pool's modeled cards, every patch in the
 * review queue and every trial's validated patches, and every trial's refusals.
 */
export function loadScreenEvidence(): ScreenEvidence {
  const modeledNames = new Set(readJson<{ modeled: string[] }>(MODELED_RATCHET_PATH).modeled);
  const evidence: ScreenEvidence = { modeledLines: [], acceptedLines: [], refusedLines: [] };
  const add = (
    into: EvidenceLine[],
    card: string,
    lines: readonly string[],
    reason?: string,
  ): void => {
    for (const line of lines)
      into.push({
        card,
        line: normalizeLine(line, card),
        ...(reason === undefined ? {} : { reason: reason.toLowerCase() }),
      });
  };
  for (const { card } of readJson<PinnedCard[]>(PINNED_ORACLE_PATH))
    if (modeledNames.has(card.name))
      add(evidence.modeledLines, card.name, card.oracleText.split('\n'));
  if (existsSync(REVIEW_QUEUE_PATH))
    for (const entry of readJson<QueueFile>(REVIEW_QUEUE_PATH).cards)
      add(evidence.acceptedLines, entry.name, entry.handledLines);
  for (const trial of compilerTrials())
    for (const card of loadTrialCards(trial))
      add(
        card.outcome === 'refused' ? evidence.refusedLines : evidence.acceptedLines,
        card.name,
        card.lines,
        card.reason,
      );
  return evidence;
}

let cachedMatches: RuleEvidence[] | undefined;
/** Each candidate rule with the committed evidence it matches (computed once per process). */
export function loadRuleEvidence(): RuleEvidence[] {
  cachedMatches ??= matchEvidence(
    candidateRules(readFileSync(COMPREHENSIVE_RULES_PATH, 'utf8')),
    loadScreenEvidence(),
  );
  return cachedMatches;
}

/** The screen the compiler uses, built from the committed fixtures. */
export function loadScreen(): Screen {
  return buildScreen(loadRuleEvidence());
}

export interface ReplayResult {
  cards: number;
  refused: number;
  /** Refusals the screen catches: compile calls saved. */
  caught: number;
  /** Accepted cards the screen would have declined. */
  acceptedLost: string[];
  byRule: Record<string, string[]>;
}

/**
 * Replays trial cards through the screen. With `leaveOneOut`, each card is screened by a screen
 * built without that card's own outcome, so a rule confirmed only by the card itself does not
 * count: that is the estimate for cards the screen has never seen.
 */
export function replayScreen(
  cards: readonly TrialCard[],
  matches: readonly RuleEvidence[],
  options: { leaveOneOut?: boolean } = {},
): ReplayResult {
  const result: ReplayResult = {
    cards: cards.length,
    refused: 0,
    caught: 0,
    acceptedLost: [],
    byRule: {},
  };
  const shared = buildScreen(matches);
  for (const card of cards) {
    if (card.outcome === 'refused') result.refused++;
    const rules =
      options.leaveOneOut === true ? buildScreen(matches, card.name).active : shared.active;
    const hit = screenLines(card.lines, rules, card.name);
    if (hit === null) continue;
    (result.byRule[hit.rule.id] ??= []).push(card.name);
    if (card.outcome === 'refused') result.caught++;
    else result.acceptedLost.push(card.name);
  }
  return result;
}
