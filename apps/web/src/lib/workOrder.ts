/**
 * The work order: Markdown a person can save, or hand to an LLM, asking for one pull request that
 * models the cards a failed import needs (ADR 0054; redesign plan phase 4c). Pure: it formats what
 * it is given and never adds a fact. A card's Oracle text, hash, status, missing pieces, scenarios
 * and evidence appear only when the server sent them; otherwise the order says it does not know.
 *
 * Its six parts, in order: the deck and source; the goal; the definition of done; the cards that
 * need work; where to read the rules of the repository; the cards already supported.
 */
import type { CardReportStatus } from '@mtg/shared';
import {
  STATUS_LABELS,
  evidenceRows,
  evidenceWords,
  needsWork,
  plural,
  type ReportRow,
} from './importReportModel';

export interface WorkOrderInput {
  deckName: string;
  seat: string;
  source: { kind: 'url' | 'plaintext' | 'saved'; url?: string };
  /** Every card of the list, with its status. Cards that need work are written out in full. */
  rows: readonly ReportRow[];
  /** True when `rows` holds the supported cards too; false when only the stopped cards are known. */
  supportedKnown: boolean;
  /** Whether the server had a Card Test Lab catalog to match scenarios against. */
  labAvailable: boolean;
}

/** `decktank-work-order-<deck-slug>.md`. */
export function workOrderFileName(deckName: string): string {
  const slug = deckName
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return `decktank-work-order-${slug === '' ? 'deck' : slug}.md`;
}

function sourceText(source: WorkOrderInput['source']): string {
  switch (source.kind) {
    case 'url':
      return `a deck link${source.url === undefined ? '' : ` (${source.url})`}`;
    case 'plaintext':
      return 'a pasted decklist';
    case 'saved':
      return 'a saved deck';
  }
}

/** Why the card's own text may not be copied into a heading or a code span as-is. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function quote(value: string): string[] {
  return value.split('\n').map((line) => `> ${line}`.trimEnd());
}

function statusLine(status: CardReportStatus): string {
  return STATUS_LABELS[status];
}

/** What the completion rule still needs for this card, from what was recorded. */
function stillMissing(row: ReportRow): string[] {
  const missing: string[] = [];
  const rows = evidenceRows(row);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  if (row.status !== 'implemented-reviewed')
    missing.push(
      row.status === 'unsupported'
        ? 'A faithful implementation (the card is unsupported today)'
        : 'Review of the implementation against the Oracle text',
    );
  if (!byKey['engine']?.done)
    missing.push('Engine evidence: positive and negative scenarios for every clause');
  if (!byKey['viewer']?.done) missing.push('Real-viewer evidence from a Card Test Lab scenario');
  missing.push('Separate gameplay-AI evidence (quality evidence, never a correctness gate)');
  return missing;
}

function cardSection(row: ReportRow, labAvailable: boolean): string[] {
  const out: string[] = [`### ${oneLine(row.name)}`, ''];
  const entry = row.entry;
  out.push(`- Status: ${statusLine(row.status)}`);
  const sha = entry?.oracleSha256 ?? row.oracleSha256;
  out.push(`- Oracle hash (sha256): ${sha === undefined ? 'not available' : `\`${sha}\``}`);
  if (entry !== null) {
    out.push(`- Type line: ${oneLine(entry.typeLine)}`);
    if (entry.manaCost !== null && entry.manaCost !== '')
      out.push(`- Mana cost: ${entry.manaCost}`);
  } else {
    out.push('- Card details were not loaded when this order was written; re-open the report.');
  }
  out.push('');
  if (entry !== null) {
    out.push('Oracle text (pin this exact text):', '', ...quote(entry.oracleText), '');
    if (entry.unmodeledReasons.length > 0) {
      out.push('What the engine reports it cannot read (verbatim):', '');
      for (const reason of entry.unmodeledReasons) out.push(`- ${oneLine(reason)}`);
      out.push('');
    }
    if (entry.unsupportedReason !== undefined)
      out.push(`Audit ledger reason: ${oneLine(entry.unsupportedReason)}`, '');
    if (entry.auditConflict !== undefined) out.push(`Note: ${entry.auditConflict}`, '');
    out.push('Known scenarios:', '');
    if (entry.scenarios === null)
      out.push(
        labAvailable
          ? '- None looked up.'
          : '- Not looked up: the server that wrote this order has no Card Test Lab catalog.',
      );
    else if (entry.scenarios.length === 0)
      out.push('- None: no lab scenario pins this Oracle hash.');
    else
      for (const scenario of entry.scenarios)
        out.push(
          `- \`${scenario.id}\` ${oneLine(scenario.title)}` +
            (scenario.clauseIds.length > 0 ? ` (clauses: ${scenario.clauseIds.join(', ')})` : ''),
        );
    out.push('');
  }
  out.push('Recorded evidence:', '');
  for (const evidence of evidenceRows(row)) {
    if (evidence.key === 'implementation') continue;
    out.push(`- ${evidence.label}: ${evidenceWords(evidence.value)}`);
  }
  if (entry?.evidence?.note !== undefined)
    out.push(`- Ledger note: ${oneLine(entry.evidence.note)}`);
  if (entry?.evidence?.oracleMatchesAudit === false)
    out.push(
      '- The ledger evidence was recorded against a different Oracle text than the one above.',
    );
  out.push('', 'Still missing:', '');
  for (const item of stillMissing(row)) out.push(`- [ ] ${item}`);
  out.push('');
  return out;
}

/** The whole work order as Markdown. */
export function workOrderMarkdown(input: WorkOrderInput): string {
  const stopped = input.rows.filter((row) => needsWork(row.status));
  const supported = input.rows.filter((row) => !needsWork(row.status));
  const unsupportedCount = stopped.filter((row) => row.status === 'unsupported').length;
  const provisionalCount = stopped.length - unsupportedCount;
  const lines: string[] = [];

  lines.push(
    `# Work order: model ${plural(stopped.length, 'card')} for ${oneLine(input.deckName)}`,
    '',
  );

  lines.push('## 1. Deck and source', '');
  lines.push(`- Deck: ${oneLine(input.deckName)}`);
  lines.push(`- Seat: ${input.seat}`);
  lines.push(`- Source: ${sourceText(input.source)}`);
  lines.push(
    `- Cards that need work: ${stopped.length} (${unsupportedCount} unsupported, ${provisionalCount} provisional)`,
  );
  lines.push(
    input.supportedKnown
      ? `- Cards already supported: ${supported.length} distinct`
      : '- Cards already supported: not known (the list came from a link, so only the stopped cards were reported)',
  );
  lines.push('');

  lines.push('## 2. Goal', '');
  lines.push(
    `Open one pull request that models ${stopped.length === 1 ? 'the card' : 'the cards'} listed in section 4, so that importing this deck no longer stops. A card that cannot be modeled faithfully stays explicit with \`unimplemented()\` or \`unsupportedCard()\`; never substitute a mana cost, target, event or \`noOp\` for rules behavior the engine does not have.`,
    '',
  );

  lines.push('## 3. Definition of done', '');
  lines.push(
    'Copied from the completion rule in `docs/guides/card-modeling-and-testing.md`. For every card, and for every Oracle clause changed:',
    '',
  );
  lines.push('- [ ] The Oracle text is pinned, with its hash.');
  lines.push(
    '- [ ] Every Oracle clause maps to an implementation primitive or an explicit unsupported reason.',
  );
  lines.push('- [ ] Positive and negative engine scenarios exist for each clause.');
  lines.push(
    '- [ ] The normal cast or activation path is exercised, with the cost, targeting, timing and zone-change scenarios that apply.',
  );
  lines.push(
    '- [ ] Real-viewer evidence comes from the Card Test Lab and its Playwright suite, bound to the tested revision and Oracle hash.',
  );
  lines.push(
    '- [ ] Gameplay-AI evidence is reported separately; it is quality evidence, never a correctness gate.',
  );
  lines.push(
    '',
    '`modeled: true`, a snapshot, deck membership, aggregate coverage, a mocked UI test or a written claim of completion proves none of this.',
    '',
  );

  lines.push('## 4. Cards that need work', '');
  if (stopped.length === 0) lines.push('No card needs work.', '');
  for (const row of stopped) lines.push(...cardSection(row, input.labAvailable));

  lines.push('## 5. How to work in this repository', '');
  lines.push('- Read `AGENTS.md` first.');
  lines.push(
    '- Follow `docs/guides/card-modeling-and-testing.md` (the completion standard) and `docs/guides/card-coverage-workflow.md`.',
  );
  lines.push(
    '- Read `docs/guides/rules-engine-constraints.md` before changing `packages/engine`, and `docs/guides/testing-discipline.md` before adding tests.',
  );
  lines.push(
    '- Do not change supported cards. If the Oracle text is ambiguous, stop and ask instead of choosing a reading.',
    '',
  );

  lines.push('## 6. Cards already supported', '');
  if (!input.supportedKnown) lines.push('Not known for this source.', '');
  else if (supported.length === 0) lines.push('None.', '');
  else {
    for (const row of supported) lines.push(`- ${oneLine(row.name)} (${statusLine(row.status)})`);
    lines.push('');
  }
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd() + '\n'
  );
}
