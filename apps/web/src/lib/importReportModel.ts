/**
 * The pure model behind the Import report (ADR 0053): which cards a failed import still needs
 * work on, how the list groups and filters, and what evidence a card has. Nothing here is invented:
 * every state comes from the preview's `unmodeledCards` or `GET /api/card-report`, and a fact the
 * server did not send stays "unknown" instead of being filled in.
 */
import type { CardReportEntry, CardReportStatus, UnmodeledCard } from '@mtg/shared';

export type ReportFilter = 'needs-work' | 'supported' | 'all';
export type ReportGroup = 'unsupported' | 'in-progress' | 'supported';

export const GROUP_LABELS: Readonly<Record<ReportGroup, string>> = {
  unsupported: 'Unsupported',
  'in-progress': 'In progress',
  supported: 'Supported',
};

export const STATUS_LABELS: Readonly<Record<CardReportStatus, string>> = {
  unsupported: 'Unsupported',
  provisional: 'Provisional',
  'implemented-unreviewed': 'Implemented, not reviewed',
  'implemented-reviewed': 'Reviewed',
};

/** The engine cannot play it, or only a machine-checked, unreviewed definition can. */
export function needsWork(status: CardReportStatus): boolean {
  return status === 'unsupported' || status === 'provisional';
}

export function groupOf(status: CardReportStatus): ReportGroup {
  if (status === 'unsupported') return 'unsupported';
  return status === 'provisional' ? 'in-progress' : 'supported';
}

/** One card of the list: what the preview said, and the report once it has arrived. */
export interface ReportRow {
  name: string;
  status: CardReportStatus;
  oracleSha256?: string;
  entry: CardReportEntry | null;
}

const key = (name: string): string => name.trim().toLowerCase();

/**
 * The list's rows. The preview's unmodeled cards come first (they are why the import stopped),
 * each with its report entry when one has loaded. Every other card the report knows, from the
 * list the person pasted, joins as a supported-side row with the status the server gave it.
 */
export function buildRows(
  unmodeled: readonly UnmodeledCard[],
  entries: readonly CardReportEntry[],
): ReportRow[] {
  const byName = new Map(entries.map((entry) => [key(entry.name), entry]));
  const rows: ReportRow[] = [];
  const seen = new Set<string>();
  for (const card of unmodeled) {
    const entry = byName.get(key(card.name)) ?? null;
    seen.add(key(card.name));
    rows.push({
      name: card.name,
      status: entry?.status ?? card.status,
      ...(card.oracleSha256 !== undefined && { oracleSha256: card.oracleSha256 }),
      entry,
    });
  }
  for (const entry of entries) {
    if (seen.has(key(entry.name))) continue;
    seen.add(key(entry.name));
    rows.push({ name: entry.name, status: entry.status, oracleSha256: entry.oracleSha256, entry });
  }
  return rows;
}

export function filterRows(rows: readonly ReportRow[], filter: ReportFilter): ReportRow[] {
  if (filter === 'all') return [...rows];
  return rows.filter((row) => needsWork(row.status) === (filter === 'needs-work'));
}

export interface ReportCounts {
  supported: number;
  inProgress: number;
  unsupported: number;
}

export function countRows(rows: readonly ReportRow[]): ReportCounts {
  const counts: ReportCounts = { supported: 0, inProgress: 0, unsupported: 0 };
  for (const row of rows) {
    const group = groupOf(row.status);
    if (group === 'supported') counts.supported++;
    else if (group === 'in-progress') counts.inProgress++;
    else counts.unsupported++;
  }
  return counts;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** One line under the title: what stopped the import, in numbers. */
export function summaryLine(counts: ReportCounts, supportedKnown: boolean): string {
  const parts: string[] = [];
  if (counts.unsupported > 0)
    parts.push(`${plural(counts.unsupported, 'card')} can't be played yet`);
  if (counts.inProgress > 0) parts.push(`${counts.inProgress} in progress`);
  if (supportedKnown) parts.push(`${counts.supported} supported`);
  return parts.length > 0 ? parts.join(' · ') : 'No card needs work.';
}

/** The missing piece shown under a card in the list. */
export function missingPiece(row: ReportRow): string {
  if (row.entry === null) return 'Details not loaded';
  const reason = row.entry.unmodeledReasons[0];
  switch (row.status) {
    case 'unsupported':
      return reason ?? row.entry.unsupportedReason ?? 'Not modeled by the engine';
    case 'provisional':
      return 'Machine-checked, not yet reviewed';
    case 'implemented-unreviewed':
      return 'Modeled, not yet reviewed';
    case 'implemented-reviewed':
      return 'Reviewed';
  }
}

/** The four states of the completion rule, as the report shows them. */
export interface EvidenceRow {
  key: 'implementation' | 'engine' | 'viewer' | 'gameplayAi';
  label: string;
  /** What the server recorded, in its own words, or null when there is no record. */
  value: string | null;
  /** True only for a value that is itself positive evidence. */
  done: boolean;
}

const EVIDENCE_DONE: Readonly<Record<EvidenceRow['key'], readonly string[]>> = {
  implementation: ['implemented-reviewed'],
  engine: ['engine-tests'],
  viewer: ['playwright'],
  gameplayAi: [],
};

/**
 * Implementation, engine, viewer and gameplay-AI evidence for a card, from its report entry. A
 * field the audit ledger did not record is `null`; gameplay-AI evidence is quality information and
 * is never counted as done here.
 */
export function evidenceRows(row: ReportRow): EvidenceRow[] {
  const evidence = row.entry?.evidence;
  const make = (
    rowKey: EvidenceRow['key'],
    label: string,
    value: string | null | undefined,
  ): EvidenceRow => ({
    key: rowKey,
    label,
    value: value ?? null,
    done: value !== null && value !== undefined && EVIDENCE_DONE[rowKey].includes(value),
  });
  return [
    make('implementation', 'Implementation', row.entry === null ? null : row.status),
    make('engine', 'Engine scenarios', evidence?.engine),
    make('viewer', 'Real viewer', evidence?.viewer),
    make('gameplayAi', 'Gameplay AI', evidence?.gameplayAi),
  ];
}

/** Short words for the ledger's own values, kept next to the raw value where it is shown. */
export function evidenceWords(value: string | null): string {
  switch (value) {
    case null:
      return 'No record';
    case 'engine-tests':
      return 'Engine tests recorded';
    case 'playwright':
      return 'Playwright run recorded';
    case 'not-run':
      return 'Not run';
    case 'not-evaluated':
      return 'Not evaluated';
    case 'not-applicable':
      return 'Not applicable';
    case 'contained':
      return 'Contained (kept out of play)';
    case 'implemented-reviewed':
      return 'Reviewed';
    default:
      return value;
  }
}

/** A deck line: one card name and how many the list asks for. */
export interface DeckLine {
  name: string;
  qty: number;
}

const SECTION =
  /^(commander|commanders|companion|deck|main|mainboard|sideboard|maybeboard|considering)s?:?$/i;

/**
 * The card names of a pasted decklist, for asking the server about each. It reads the shapes the
 * server's plaintext importer reads (`1 Name`, `1x Name`, section headers, set codes, comments)
 * and ignores the sideboard. It is a convenience: a name it gets wrong just comes back
 * unresolved, and the report says so.
 */
export function parseDeckLines(list: string): DeckLine[] {
  const lines: DeckLine[] = [];
  let skipping = false;
  for (const raw of list.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;
    const section = SECTION.exec(line);
    if (section !== null) {
      skipping = /^(sideboard|maybeboard|considering)/i.test(line);
      continue;
    }
    if (skipping) continue;
    const inline = /^(?:commander|companion)\s*:\s*(.+)$/i.exec(line);
    const body = (inline?.[1] ?? line)
      .replace(/^(\d+)\s*x?\s+/i, '$1 ')
      .replace(/\s+\([A-Za-z0-9]{2,6}\)(\s+\S+)?\s*(\*[A-Za-z]\*)?$/, '')
      .replace(/\s+\*[A-Za-z]\*$/, '')
      .trim();
    const counted = /^(\d+)\s+(.+)$/.exec(body);
    const name = (counted?.[2] ?? body).trim();
    if (name === '') continue;
    lines.push({ name, qty: counted === null ? 1 : Number(counted[1]) });
  }
  return lines;
}

/** Distinct names of a list, in order, for a request. */
export function distinctNames(lines: readonly DeckLine[]): string[] {
  return [...new Set(lines.map((line) => line.name))];
}

/** Split names into requests the server accepts (at most 250 each). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
