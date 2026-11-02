/**
 * Triage for the EDHREC ready list (ADR 0038, plan Phase 1 step 6): for each card blocked by
 * exactly one rules line, the grammar slot that failed inside that line. It is the work queue for
 * the later phases of the [EDHREC coverage plan](../../../../docs/plans/edhrec-coverage-modelling.md).
 *
 * The slot diagnostics record every failure while a card is interpreted, including the readings
 * the line classifier tries and abandons (each line is tried as a cost and as a trigger before
 * it is read as an effect). `primaryFailure` discards those and picks the failure that best
 * explains the line. That is a lead for whoever models the card, not a verdict.
 */

import type { GrammarSlot, SlotFailure } from '@mtg/engine';

export interface TriageEntry {
  rank: number;
  name: string;
  decks: number;
  /** The blocking line as the ready list prints it, with the card's own name as `~`. */
  line: string;
  failures: readonly SlotFailure[];
}

export interface TriageRecord {
  rank: number;
  name: string;
  decks: number;
  line: string;
  /** The slot that failed, or `line` when no slot recorded a failure inside the line. */
  slot: GrammarSlot | 'line';
  text: string;
  /** Every other slot that failed inside the line, in first-failure order. */
  alsoFailed: GrammarSlot[];
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/’/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();

const TRIGGER_LINE_RE = /^(?:when|whenever|at)\b/;

/** Phrase slots: a failure in one of these names the exact phrase the grammar does not know. */
const PHRASE_SLOTS: ReadonlySet<GrammarSlot> = new Set([
  'subject',
  'card filter',
  'spell filter',
  'target',
  'amount',
  'condition',
  'cost',
]);

/** The failures recorded inside `line`, without the readings the line classifier abandoned. */
function failuresInLine(line: string, failures: readonly SlotFailure[]): SlotFailure[] {
  const whole = normalize(line);
  return failures.filter((failure) => {
    const text = normalize(failure.text);
    if (text === '' || !whole.includes(text)) return false;
    if (text !== whole) return true;
    // A whole-line failure is a reading the classifier tried, unless the line has that shape.
    if (failure.slot === 'cost') return false;
    if (failure.slot === 'trigger event') return TRIGGER_LINE_RE.test(whole);
    return true;
  });
}

/**
 * The failure that best explains why `line` did not parse, or null when none was recorded.
 *
 * In order: the shortest phrase-slot failure (the most specific phrase the grammar does not
 * know); else a failed trigger head; else the effect fragment that starts earliest in the line,
 * the shorter one when two start at the same place. "Earliest" rather than "shortest" because a
 * sentence split on ", then" also records its tail ("shuffle") as a failure, and the tail is
 * not why the sentence failed.
 */
export function primaryFailure(line: string, failures: readonly SlotFailure[]): SlotFailure | null {
  const whole = normalize(line);
  const relevant = failuresInLine(line, failures);
  const shortest = (list: readonly SlotFailure[]): SlotFailure | null => {
    let best: SlotFailure | null = null;
    for (const failure of list) {
      if (best === null || normalize(failure.text).length <= normalize(best.text).length) {
        best = failure;
      }
    }
    return best;
  };
  const phrase = shortest(relevant.filter((failure) => PHRASE_SLOTS.has(failure.slot)));
  if (phrase !== null) return phrase;
  const head = relevant.find((failure) => failure.slot === 'trigger event');
  if (head !== undefined) return head;
  let best: SlotFailure | null = null;
  let bestAt = Infinity;
  for (const failure of relevant) {
    if (failure.slot !== 'effect') continue;
    const text = normalize(failure.text);
    const at = whole.indexOf(text);
    if (
      at < bestAt ||
      (at === bestAt && best !== null && text.length < normalize(best.text).length)
    ) {
      best = failure;
      bestAt = at;
    }
  }
  return best;
}

export function triageRecord(entry: TriageEntry): TriageRecord {
  const primary = primaryFailure(entry.line, entry.failures);
  const alsoFailed: GrammarSlot[] = [];
  for (const failure of failuresInLine(entry.line, entry.failures)) {
    if (failure.slot === primary?.slot || alsoFailed.includes(failure.slot)) continue;
    alsoFailed.push(failure.slot);
  }
  return {
    rank: entry.rank,
    name: entry.name,
    decks: entry.decks,
    line: entry.line,
    slot: primary?.slot ?? 'line',
    text: primary === null ? entry.line : normalize(primary.text),
    alsoFailed,
  };
}

/** One JSON object per line, in rank order, so a re-triage diff reads row by row. */
export function renderTriageJson(records: readonly TriageRecord[]): string {
  const rows = [...records].sort((a, b) => a.rank - b.rank).map((record) => JSON.stringify(record));
  return `[\n${rows.join(',\n')}\n]\n`;
}

/** A failing text with numbers, mana symbols and P/T normalized, for grouping. */
export function textShape(text: string): string {
  return normalize(text)
    .replace(/\{[^}]+\}/g, '{m}')
    .replace(/[+-]\d+\/[+-]\d+/g, '+n/+n')
    .replace(/\b\d+\/\d+\b/g, 'p/t')
    .replace(/\b(?:\d+|x|one|two|three|four|five|six|seven)\b/g, 'n');
}

export interface TriageSummaryInput {
  records: readonly TriageRecord[];
  totalSlots: number;
  /** Where the cards came from: the corpus or the bank. */
  source: string;
  shapesPerSlot?: number;
}

const percent = (part: number, whole: number): string => `${((part / whole) * 100).toFixed(2)}%`;

function inlineCode(text: string): string {
  const fence = text.includes('`') ? '``' : '`';
  return `${fence}${text}${fence}`;
}

export function renderTriageMarkdown(summary: TriageSummaryInput): string {
  const { totalSlots, source } = summary;
  const records = [...summary.records].sort((a, b) => a.rank - b.rank);
  const shapesPerSlot = summary.shapesPerSlot ?? 15;
  const bySlot = new Map<string, TriageRecord[]>();
  for (const record of records) {
    const list = bySlot.get(record.slot) ?? [];
    list.push(record);
    bySlot.set(record.slot, list);
  }
  const decks = (list: readonly TriageRecord[]) => list.reduce((sum, r) => sum + r.decks, 0);
  const slots = [...bySlot.entries()].sort((a, b) => b[1].length - a[1].length);

  const out: string[] = [
    '# EDHREC triage: the failing slot of each one-line card',
    '',
    'Generated by `bun run edhrec:triage`. Do not edit by hand.',
    '',
    `Each of the ${records.length} cards in the [EDHREC ready list](edhrec-ready-list.md) that is blocked by one rules line, with the grammar slot that failed inside that line (ADR 0038). The slot is the most specific failure the slot diagnostics recorded; it is a lead, not a verdict. Source: ${source}. Machine-readable queue: \`packages/server/fixtures/edhrec-triage.json\`.`,
    '',
    '| Failing slot | Cards | Share of slots |',
    '| ------------ | ----: | -------------: |',
    ...slots.map(
      ([slot, list]) => `| ${slot} | ${list.length} | ${percent(decks(list), totalSlots)} |`,
    ),
    '',
    '`line` means no slot recorded a failure inside the line: the line matched no sentence shape at all.',
  ];
  for (const [slot, list] of slots) {
    const shapes = new Map<string, TriageRecord[]>();
    for (const record of list) {
      const shape = textShape(record.text);
      const group = shapes.get(shape) ?? [];
      group.push(record);
      shapes.set(shape, group);
    }
    const ranked = [...shapes.entries()]
      .sort((a, b) => b[1].length - a[1].length || decks(b[1]) - decks(a[1]))
      .slice(0, shapesPerSlot);
    out.push('', `## ${slot} (${list.length})`, '');
    for (const [shape, group] of ranked) {
      const names = group
        .slice(0, 3)
        .map((r) => r.name)
        .join(', ');
      out.push(`- ${group.length} × ${inlineCode(shape)} (${names})`);
    }
  }
  return `${out.join('\n')}\n`;
}
