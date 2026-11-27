<script setup lang="ts">
/**
 * The Import report (ADR 0054; redesign plan phase 4b; Decktank `CardLab.dc.html`, import mode):
 * what stopped the last refused import, card by card, and a work order to hand to a person or an
 * LLM. The list is the preview's unmodeled cards plus, for a pasted list, every other card the
 * server can name; picking a card shows its Oracle text, status and the evidence the audit ledger
 * holds, from `GET /api/card-report`. Nothing is made up: a fact the server did not send reads
 * "No record", and a request that fails leaves the list standing on the preview's own statuses.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { CardReport, CardReportEntry } from '@mtg/shared';
import PageTitle from '../components/shell/PageTitle.vue';
import {
  GROUP_LABELS,
  STATUS_LABELS,
  buildRows,
  chunk,
  countRows,
  distinctNames,
  evidenceRows,
  evidenceWords,
  filterRows,
  groupOf,
  missingPiece,
  parseDeckLines,
  summaryLine,
  type ReportFilter,
  type ReportGroup,
  type ReportRow,
} from '../lib/importReportModel';
import { workOrderFileName, workOrderMarkdown } from '../lib/workOrder';
import { useImportReportStore } from '../stores/importReport';

/** The server answers at most this many names per request (`CARD_REPORT_MAX_NAMES`). */
const REQUEST_NAMES = 250;
/** Supported cards listed before "Show all". */
const SUPPORTED_SHOWN = 12;

const store = useImportReportStore();
const report = computed(() => store.report);

const entries = ref<CardReportEntry[]>([]);
const loadState = ref<'idle' | 'loading' | 'done' | 'error'>('idle');
const loadError = ref('');
const labAvailable = ref(false);
const auditAvailable = ref(true);
const unresolved = ref(0);

const filter = ref<ReportFilter>('needs-work');
const FILTERS: ReadonlyArray<[ReportFilter, string]> = [
  ['needs-work', 'Needs work'],
  ['supported', 'Supported'],
  ['all', 'All'],
];
const showAllSupported = ref(false);
const selectedName = ref<string | null>(null);

/** A list pasted as text gives every card name; a link gives only the stopped ones. */
const supportedKnown = computed(
  () => report.value?.sourceKind === 'plaintext' && loadState.value === 'done',
);

const rows = computed<ReportRow[]>(() =>
  report.value === null ? [] : buildRows(report.value.unmodeled, entries.value),
);
const counts = computed(() => countRows(rows.value));
const shown = computed(() => filterRows(rows.value, filter.value));

interface Group {
  id: ReportGroup;
  label: string;
  total: number;
  rows: ReportRow[];
  more: number;
}
const groups = computed<Group[]>(() => {
  const out: Group[] = [];
  for (const id of ['unsupported', 'in-progress', 'supported'] as const) {
    const all = shown.value.filter((row) => groupOf(row.status) === id);
    if (all.length === 0) continue;
    const limited = id === 'supported' && !showAllSupported.value;
    out.push({
      id,
      label: GROUP_LABELS[id],
      total: all.length,
      rows: limited ? all.slice(0, SUPPORTED_SHOWN) : all,
      more: limited ? Math.max(0, all.length - SUPPORTED_SHOWN) : 0,
    });
  }
  return out;
});

const selected = computed<ReportRow | null>(
  () => shown.value.find((row) => row.name === selectedName.value) ?? shown.value[0] ?? null,
);
const evidence = computed(() => (selected.value === null ? [] : evidenceRows(selected.value)));

watch(filter, () => {
  showAllSupported.value = false;
});

const title = computed(() => (counts.value.unsupported > 0 ? 'Import stopped' : 'Import report'));
const summary = computed(() => summaryLine(counts.value, supportedKnown.value));
const sourceLabel = computed(() =>
  report.value?.sourceKind === 'url' ? 'deck link' : 'pasted list',
);
const barSegments = computed(() => {
  const c = counts.value;
  return [
    { id: 'supported', n: supportedKnown.value ? c.supported : 0, label: 'supported' },
    { id: 'wip', n: c.inProgress, label: 'in progress' },
    { id: 'bad', n: c.unsupported, label: 'unsupported' },
  ];
});
const barLabel = computed(() =>
  barSegments.value
    .filter((segment) => segment.id !== 'supported' || supportedKnown.value)
    .map((segment) => `${segment.n} ${segment.label}`)
    .join(', '),
);

/** The card names to ask about: the stopped ones, then the rest of a pasted list. */
function namesToAsk(): string[] {
  const current = report.value;
  if (current === null) return [];
  const names = current.unmodeled.map((card) => card.name);
  if (current.sourceKind === 'plaintext')
    names.push(...distinctNames(parseDeckLines(current.source)));
  return [...new Set(names)];
}

let loadGeneration = 0;
async function load(): Promise<void> {
  const generation = ++loadGeneration;
  const names = namesToAsk();
  entries.value = [];
  unresolved.value = 0;
  loadError.value = '';
  if (names.length === 0) {
    loadState.value = 'done';
    return;
  }
  loadState.value = 'loading';
  try {
    const collected: CardReportEntry[] = [];
    let missing = 0;
    for (const part of chunk(names, REQUEST_NAMES)) {
      const query = new URLSearchParams();
      for (const name of part) query.append('names', name);
      const response = await fetch(`/api/card-report?${query.toString()}`);
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `The server answered ${response.status}.`);
      }
      const result = (await response.json()) as CardReport;
      if (generation !== loadGeneration) return;
      collected.push(...result.cards);
      missing += result.unresolved.length;
      labAvailable.value = result.labAvailable;
      auditAvailable.value = result.auditAvailable;
    }
    if (generation !== loadGeneration) return;
    entries.value = collected;
    unresolved.value = missing;
    loadState.value = 'done';
  } catch (reason) {
    if (generation !== loadGeneration) return;
    loadError.value = reason instanceof Error ? reason.message : String(reason);
    loadState.value = 'error';
  }
}

const rootEl = ref<HTMLElement | null>(null);
onMounted(() => {
  // The shell's `main` scrolls, and keeps the position New game left it at.
  try {
    rootEl.value?.closest('main')?.scrollTo(0, 0);
  } catch {
    // Staying where it is is harmless.
  }
  void load();
});
onBeforeUnmount(() => {
  loadGeneration++;
  window.clearTimeout(copiedTimer);
});

const detailEl = ref<HTMLElement | null>(null);
async function pick(row: ReportRow): Promise<void> {
  selectedName.value = row.name;
  await nextTick();
  try {
    // On a narrow screen the list is above the card, so bring the card up.
    if (window.matchMedia('(max-width: 1100px)').matches)
      detailEl.value?.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      });
  } catch {
    // No scrolling is fine; the card is still selected.
  }
}

// ---- The work order -------------------------------------------------------------------------

const markdown = computed(() => {
  const current = report.value;
  if (current === null) return '';
  return workOrderMarkdown({
    deckName: current.deckName,
    seat: current.seat,
    source:
      current.sourceKind === 'url' ? { kind: 'url', url: current.source } : { kind: 'plaintext' },
    rows: rows.value,
    supportedKnown: supportedKnown.value,
    labAvailable: labAvailable.value,
  });
});
const fileName = computed(() => workOrderFileName(report.value?.deckName ?? ''));

const note = ref('');
const copied = ref(false);
let copiedTimer = 0;
const preEl = ref<HTMLElement | null>(null);
const previewEl = ref<HTMLDetailsElement | null>(null);
/** The preview is the way out when saving or copying is blocked, so it opens itself then. */
const previewOpen = ref(false);
function onPreviewToggle(): void {
  previewOpen.value = previewEl.value?.open === true;
}

function save(): void {
  try {
    const url = URL.createObjectURL(new Blob([markdown.value], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName.value;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    note.value = `Saved as ${fileName.value}.`;
  } catch {
    note.value = 'This browser blocked the download. Copy the text from the preview instead.';
    previewOpen.value = true;
  }
}

function markCopied(): void {
  copied.value = true;
  note.value = '';
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => (copied.value = false), 1600);
}

/** Select the preview's text, so the person can copy it by hand. */
async function selectPreview(): Promise<void> {
  previewOpen.value = true;
  await nextTick();
  try {
    const el = preEl.value;
    if (el === null) return;
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    el.focus();
  } catch {
    // Nothing more to try; the message below says what to do.
  }
}

function copyBlocked(): void {
  note.value = 'Copying was blocked. The preview is selected: copy it with your keyboard.';
  void selectPreview();
}

function legacyCopy(): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = markdown.value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(markdown.value);
    markCopied();
  } catch {
    if (legacyCopy()) markCopied();
    else copyBlocked();
  }
}

function clearReport(): void {
  store.clear();
  entries.value = [];
  selectedName.value = null;
  note.value = '';
}

function sha(row: ReportRow): string {
  return row.entry?.oracleSha256 ?? row.oracleSha256 ?? '';
}

/** Whether the ledger gave this card an entry at all, to word the empty evidence honestly. */
function ledgerSilent(row: ReportRow): boolean {
  return (
    row.entry !== null && row.entry.evidence === undefined && row.entry.auditConflict === undefined
  );
}
</script>

<template>
  <section ref="rootEl" class="report-page">
    <!-- Nothing to report -->
    <div v-if="report === null" class="empty">
      <PageTitle place="III. Workshop · a. Card lab" hide-kicker>Import report</PageTitle>
      <p class="lede">
        Nothing to report. When a deck you bring to New game is stopped by cards the rules engine
        does not model, they are listed here with what each one still needs, and written up as a
        work order.
      </p>
      <RouterLink to="/" class="dt-btn"
        >Back to New game<span class="dt-arr" aria-hidden="true"
      /></RouterLink>
    </div>

    <template v-else>
      <header class="head">
        <PageTitle place="III. Workshop · a. Card lab" hide-kicker>{{ title }}</PageTitle>
        <p class="deck">{{ report.deckName }} · Seat {{ report.seat }} · {{ sourceLabel }}</p>
        <p class="summary" aria-live="polite">{{ summary }}</p>

        <div class="bar-wrap">
          <div class="bar" role="img" :aria-label="barLabel">
            <template v-for="segment in barSegments" :key="segment.id">
              <span
                v-if="segment.n > 0"
                class="seg"
                :class="segment.id"
                :style="{ flexGrow: segment.n }"
              />
            </template>
          </div>
          <ul class="legend">
            <li v-if="supportedKnown">
              <span class="swatch supported" aria-hidden="true" />{{ counts.supported }} supported
            </li>
            <li v-if="counts.inProgress > 0">
              <span class="swatch wip" aria-hidden="true" />{{ counts.inProgress }} in progress
            </li>
            <li>
              <span class="swatch bad" aria-hidden="true" />{{ counts.unsupported }} unsupported
            </li>
          </ul>
        </div>

        <div class="actions">
          <button type="button" class="dt-btn" @click="save">
            Save work order<span class="dt-arr" aria-hidden="true" />
          </button>
          <button type="button" class="dt-btn copy" aria-live="polite" @click="copy">
            {{ copied ? 'Copied' : 'Copy for an LLM' }}
          </button>
          <RouterLink to="/" class="text-link">Back to New game</RouterLink>
          <button type="button" class="text-link" @click="clearReport">Clear report</button>
        </div>
        <p class="note" role="status">{{ note }}</p>

        <details ref="previewEl" class="preview" :open="previewOpen" @toggle="onPreviewToggle">
          <summary>
            Preview the work order <span class="file">{{ fileName }}</span>
          </summary>
          <pre ref="preEl" tabindex="0" aria-label="Work order preview">{{ markdown }}</pre>
        </details>
      </header>

      <div class="cols">
        <!-- The cards -->
        <nav class="list" aria-label="Cards of this import">
          <div class="dt-seg filters" role="group" aria-label="Show">
            <button
              v-for="[id, label] in FILTERS"
              :key="id"
              type="button"
              :aria-pressed="filter === id"
              @click="filter = id"
            >
              {{ label }}
            </button>
          </div>

          <p v-if="loadState === 'loading'" class="state">Loading card details…</p>
          <p v-else-if="loadState === 'error'" class="dt-note danger" role="alert">
            Card details could not be loaded: {{ loadError }} The list below shows only what the
            preview said.
          </p>

          <section v-for="group in groups" :key="group.id" :aria-label="group.label" class="group">
            <div class="group-head">
              <h2>{{ group.label }}</h2>
              <span class="count">{{ group.total }}</span>
            </div>
            <ul>
              <li v-for="row in group.rows" :key="row.name">
                <button
                  type="button"
                  class="row"
                  :class="{ on: selected?.name === row.name }"
                  :aria-pressed="selected?.name === row.name"
                  @click="pick(row)"
                >
                  <span class="row-text">
                    <span class="row-name" :class="{ struck: row.status === 'unsupported' }">{{
                      row.name
                    }}</span>
                    <span class="row-missing">{{ missingPiece(row) }}</span>
                  </span>
                  <span class="tag" :class="groupOf(row.status)">{{
                    groupOf(row.status) === 'supported'
                      ? 'Supported'
                      : groupOf(row.status) === 'in-progress'
                        ? 'In progress'
                        : 'Unsupported'
                  }}</span>
                </button>
              </li>
              <li v-if="group.more > 0" class="more-row">
                <button type="button" class="text-link" @click="showAllSupported = true">
                  Show {{ group.more }} more supported cards
                </button>
              </li>
            </ul>
          </section>

          <p v-if="groups.length === 0 && loadState !== 'loading'" class="state">
            <template v-if="filter === 'supported' && !supportedKnown">
              The supported cards are not known for a deck link: the preview sends only the cards
              that stop an import. Paste the list to see the rest.
            </template>
            <template v-else-if="filter === 'supported'">No supported card was found.</template>
            <template v-else>No card in this list needs work.</template>
          </p>
          <p v-if="unresolved > 0" class="state">
            {{ unresolved }} name{{ unresolved === 1 ? '' : 's' }} in the list did not match a known
            card and {{ unresolved === 1 ? 'is' : 'are' }} not shown.
          </p>
        </nav>

        <!-- The chosen card -->
        <main ref="detailEl" class="detail" aria-live="polite">
          <template v-if="selected">
            <div class="card-top">
              <div class="frame">
                <span class="frame-head">
                  <span>{{ selected.name }}</span>
                  <span class="cost">{{ selected.entry?.manaCost ?? '' }}</span>
                </span>
                <span class="art" aria-hidden="true" />
                <span class="type">{{ selected.entry?.typeLine ?? 'Details not loaded' }}</span>
                <span class="oracle">{{
                  selected.entry?.oracleText ??
                  'The Oracle text is not available. Re-open this report with the server running.'
                }}</span>
              </div>
              <div class="facts">
                <h2 class="card-title">{{ selected.name }}</h2>
                <dl>
                  <dt>Oracle pinned</dt>
                  <dd class="hash">
                    {{ sha(selected) === '' ? 'Not available' : `sha256 ${sha(selected)}` }}
                  </dd>
                  <dt>Status</dt>
                  <dd>{{ STATUS_LABELS[selected.status] }}</dd>
                  <dt>Missing</dt>
                  <dd>{{ missingPiece(selected) }}</dd>
                </dl>
              </div>
            </div>

            <section class="clauses" aria-labelledby="clauses-title">
              <h2 id="clauses-title">What the engine cannot read</h2>
              <ul
                v-if="selected.entry && selected.entry.unmodeledReasons.length > 0"
                class="reasons"
              >
                <li v-for="reason in selected.entry.unmodeledReasons" :key="reason">
                  {{ reason }}
                </li>
              </ul>
              <p v-else-if="selected.entry && selected.entry.unsupportedReason" class="state">
                {{ selected.entry.unsupportedReason }}
              </p>
              <p v-else-if="selected.entry" class="state">
                The interpreter reports nothing it cannot read for this card.
              </p>
              <p v-else class="state">Card details were not loaded.</p>

              <h2 class="second">Lab scenarios</h2>
              <ul
                v-if="
                  selected.entry && selected.entry.scenarios && selected.entry.scenarios.length > 0
                "
                class="scenarios"
              >
                <li v-for="scenario in selected.entry.scenarios" :key="scenario.id">
                  <span class="sid">{{ scenario.id }}</span>
                  <span>{{ scenario.title }}</span>
                  <span v-if="scenario.clauseIds.length > 0" class="clause-ids"
                    >Clauses {{ scenario.clauseIds.join(', ') }}</span
                  >
                </li>
              </ul>
              <p v-else-if="selected.entry && selected.entry.scenarios === null" class="state">
                This server has no Card Test Lab catalog, so scenarios are not looked up.
              </p>
              <p v-else-if="selected.entry" class="state">
                No lab scenario pins this card's Oracle text yet.
              </p>
              <p v-else class="state">Card details were not loaded.</p>
            </section>
          </template>
          <p v-else class="state">Pick a card to see its Oracle text and evidence.</p>
        </main>

        <!-- Evidence -->
        <aside class="evidence" aria-labelledby="evidence-title">
          <h2 id="evidence-title">Evidence</h2>
          <template v-if="selected">
            <p class="state">
              Only what the audit ledger and the engine record. A modeled flag, a snapshot or deck
              membership is not evidence.
            </p>
            <ol>
              <li v-for="item in evidence" :key="item.key">
                <span class="box" :class="{ done: item.done }" aria-hidden="true">{{
                  item.done ? '✓' : ''
                }}</span>
                <span class="ev-text">
                  <span class="ev-label">{{ item.label }}</span>
                  <span class="ev-state">{{
                    item.key === 'implementation' && item.value !== null
                      ? STATUS_LABELS[selected.status]
                      : evidenceWords(item.value)
                  }}</span>
                </span>
              </li>
            </ol>
            <p v-if="selected.entry?.evidence?.note" class="state">
              Ledger note: {{ selected.entry.evidence.note }}
            </p>
            <p v-if="selected.entry?.evidence?.oracleMatchesAudit === false" class="state">
              The ledger's evidence was recorded against different Oracle text.
            </p>
            <p v-if="selected.entry?.auditConflict" class="state">
              {{ selected.entry.auditConflict }} Its evidence is left out.
            </p>
            <p v-if="ledgerSilent(selected) && auditAvailable" class="state">
              The audit ledger has no record of this card.
            </p>
            <p v-if="!auditAvailable" class="state">The audit ledger could not be read.</p>
          </template>
          <p v-else class="state">Nothing selected.</p>
        </aside>
      </div>
    </template>
  </section>
</template>

<style scoped>
.report-page {
  max-width: 1440px;
  margin: 0 auto;
  padding: 1.75rem 3rem 3rem;
  font-family: var(--font-body);
  color: var(--ink);
}
h2,
p,
dl,
dd,
ol,
ul {
  margin: 0;
}
ul,
ol {
  padding: 0;
  list-style: none;
}
button,
a {
  font: inherit;
}
button:focus-visible,
a:focus-visible,
pre:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}
.empty {
  display: grid;
  gap: 1.25rem;
  justify-items: start;
  max-width: 40rem;
}
.lede {
  font-size: 0.9rem;
  line-height: 1.6;
}
.state {
  font-size: 0.75rem;
  line-height: 1.6;
  color: var(--muted);
}

/* Header */
.head {
  display: grid;
  gap: 0.9rem;
  padding-bottom: 1.75rem;
  border-bottom: 1px solid var(--ink);
}
.deck {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.summary {
  font-size: 0.9rem;
  line-height: 1.6;
}
.bar-wrap {
  display: grid;
  gap: 0.6rem;
  max-width: 36rem;
}
.bar {
  display: flex;
  gap: 3px;
  height: 12px;
}
.seg {
  flex-basis: 0;
  flex-shrink: 1;
  min-width: 12px;
  box-sizing: border-box;
}
.seg.supported {
  background: var(--ink);
}
.seg.wip {
  border: 1px dashed var(--ink);
}
.seg.bad {
  border: 1px solid var(--warm);
  background: repeating-linear-gradient(135deg, var(--warm) 0 1px, transparent 1px 4px);
}
.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem 1.25rem;
  font-size: 0.75rem;
}
.legend li {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.swatch {
  width: 10px;
  height: 10px;
  box-sizing: border-box;
}
.swatch.supported {
  background: var(--ink);
}
.swatch.wip {
  border: 1px dashed var(--ink);
}
.swatch.bad {
  border: 1px solid var(--warm);
  background: repeating-linear-gradient(135deg, var(--warm) 0 1px, transparent 1px 4px);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.25rem;
}
.copy {
  width: 11.5rem;
}
.text-link {
  padding: 0;
  border: 0;
  background: none;
  color: var(--ink);
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  text-underline-offset: 0.3em;
  text-decoration: underline;
  cursor: pointer;
}
.note {
  min-height: 1.2rem;
  font-size: 0.75rem;
  color: var(--muted);
}
.preview summary {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.2rem 1rem;
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  cursor: pointer;
}
.preview[open] summary {
  margin-bottom: 0.6rem;
}
.file {
  color: var(--muted);
  text-transform: none;
  letter-spacing: 0.02em;
}
pre {
  margin: 0;
  max-height: 16rem;
  overflow: auto;
  padding: 0.9rem 1rem;
  background: var(--paper-2);
  border: 1px solid var(--rule);
  font-family: var(--font-body);
  font-size: 0.75rem;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* Three columns */
.cols {
  display: grid;
  grid-template-columns: minmax(15rem, 19rem) minmax(0, 1fr) minmax(15rem, 20rem);
  align-items: stretch;
  margin-top: 0;
}
.list,
.detail,
.evidence {
  align-content: start;
  min-width: 0;
  padding-top: 1.75rem;
}
.list {
  display: grid;
  gap: 1.25rem;
  padding-right: 1.5rem;
  padding-bottom: 1.5rem;
  border-right: 1px solid var(--ink);
}
.detail {
  display: grid;
  gap: 1.75rem;
  padding-left: 2.5rem;
  padding-right: 2.5rem;
}
.evidence {
  display: grid;
  gap: 0.9rem;
  padding-left: 1.75rem;
  border-left: 1px solid var(--ink);
}
.filters {
  width: 100%;
  flex-wrap: nowrap;
}
.filters > * {
  min-width: 0;
  padding: 0 0.3rem;
  font-size: 0.62rem;
  letter-spacing: 0.06em;
}
.group {
  display: grid;
  gap: 0.5rem;
}
.group-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.75rem;
}
.group-head h2,
.evidence h2,
.clauses h2 {
  font-family: var(--font-ui);
  font-weight: 400;
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.evidence h2 {
  font-family: var(--font-display);
  font-size: 2.1rem;
  line-height: 1;
  letter-spacing: -0.03em;
}
.count {
  font-size: 0.8rem;
  color: var(--muted);
}
.group ul {
  border-top: 1px solid var(--ink);
}
.group li {
  border-bottom: 1px solid var(--ink);
}
.row {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 0.6rem 0.4rem;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.3s var(--ease);
}
.row:hover {
  background: var(--paper-2);
}
.row.on {
  background:
    linear-gradient(var(--ink), var(--ink)) left center / 2px 100% no-repeat,
    var(--paper-2);
}
.row-text {
  display: grid;
  gap: 0.2rem;
  min-width: 0;
}
.row-name {
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}
.row.on .row-name {
  text-decoration: underline;
  text-underline-offset: 0.3em;
}
.row-name.struck {
  text-decoration: line-through;
  text-decoration-color: var(--muted);
}
.row.on .row-name.struck {
  text-decoration: underline;
}
.row-missing {
  font-size: 0.65rem;
  line-height: 1.4;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.tag {
  flex: 0 0 auto;
  padding: 0.15rem 0.35rem;
  border: 1px solid var(--ink);
  font-family: var(--font-ui);
  font-size: 0.6rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  white-space: nowrap;
}
.tag.supported {
  background: var(--ink);
  color: var(--paper);
}
.tag.in-progress {
  border-style: dashed;
}
.tag.unsupported {
  border-color: var(--rule);
  color: var(--muted);
}
.more-row {
  padding: 0.6rem 0.4rem;
}

/* Detail */
.card-top {
  display: flex;
  flex-wrap: wrap;
  gap: 2rem;
  align-items: flex-start;
}
.frame {
  flex: 0 0 15rem;
  box-sizing: border-box;
  min-height: 21rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 0.9rem;
  border: 1px solid var(--ink);
}
.frame-head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-family: var(--font-ui);
  font-size: 0.85rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.cost {
  white-space: nowrap;
  font-family: var(--font-body);
  letter-spacing: 0;
}
.art {
  flex: 1;
  min-height: 3rem;
  background: var(--mana-c);
}
.type {
  padding-bottom: 0.3rem;
  border-bottom: 1px solid var(--ink);
  font-size: 0.7rem;
  color: var(--muted);
}
.oracle {
  font-size: 0.8rem;
  line-height: 1.55;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.facts {
  flex: 1 1 18rem;
  min-width: 0;
  display: grid;
  gap: 0.9rem;
}
.card-title {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: clamp(1.8rem, 3vw, 2.8rem);
  line-height: 0.98;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  overflow-wrap: anywhere;
}
dl {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.4rem 1.25rem;
  font-size: 0.8rem;
}
dt {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.hash {
  word-break: break-all;
}
.clauses {
  display: grid;
  gap: 0.6rem;
}
.clauses h2 {
  padding-bottom: 0.4rem;
  border-bottom: 1px solid var(--ink);
  font-size: 0.8rem;
}
.clauses h2.second {
  margin-top: 0.9rem;
}
.reasons li,
.scenarios li {
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--rule);
  font-size: 0.8rem;
  line-height: 1.55;
  overflow-wrap: anywhere;
}
.scenarios li {
  display: flex;
  flex-wrap: wrap;
  gap: 0.2rem 0.8rem;
}
.sid,
.clause-ids {
  font-size: 0.65rem;
  letter-spacing: 0.06em;
  color: var(--muted);
}

/* Evidence */
.evidence ol {
  border-top: 1px solid var(--ink);
}
.evidence li {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  padding: 0.6rem 0;
  border-bottom: 1px solid var(--ink);
}
.box {
  flex: 0 0 1.1rem;
  height: 1.1rem;
  margin-top: 0.1rem;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--ink);
  font-size: 0.7rem;
}
.box.done {
  background: var(--ink);
  color: var(--paper);
}
.ev-text {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
}
.ev-label {
  font-size: 0.8rem;
}
.ev-state {
  font-size: 0.65rem;
  letter-spacing: 0.06em;
  color: var(--muted);
}

/* Narrower: the evidence drops under the card, then everything stacks. */
@media (max-width: 1100px) {
  .cols {
    grid-template-columns: minmax(14rem, 19rem) minmax(0, 1fr);
  }
  .evidence {
    grid-column: 1 / -1;
    padding-left: 0;
    border-left: 0;
    border-top: 1px solid var(--ink);
    margin-top: 1.5rem;
  }
}
@media (max-width: 760px) {
  .report-page {
    padding: 1.25rem 1rem 2.5rem;
  }
  .cols {
    grid-template-columns: minmax(0, 1fr);
  }
  .list {
    padding-right: 0;
    border-right: 0;
    border-bottom: 1px solid var(--ink);
  }
  .detail {
    padding-left: 0;
    padding-right: 0;
  }
  .frame {
    flex-basis: 100%;
    min-height: 0;
  }
  .copy {
    flex: 1 1 11.5rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .row {
    transition: none;
  }
}
</style>
