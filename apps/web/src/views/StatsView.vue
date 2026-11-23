<script setup lang="ts">
import PageTitle from '../components/shell/PageTitle.vue';
import PageFoot from '../components/shell/PageFoot.vue';
import ManaPips from '../components/ManaPips.vue';
import TweenNumber from '../components/stats/TweenNumber.vue';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  HEAT_STEPS,
  causeRows,
  deckHeading,
  heatStep,
  lossesToRows,
  lowerFirst,
  mulliganBuckets,
  normalizeReport,
  romanNumeral,
  sortDecks,
  type BarRow,
  type DeckStatistic,
  type StandingsSort,
  type StatsReport,
  type StatsScopeName,
} from '../lib/statsModel';

const SCOPES: Array<{ id: StatsScopeName; label: string }> = [
  { id: 'all', label: 'All games' },
  { id: 'batch', label: 'Last batch' },
  { id: 'mine', label: 'Games I played' },
];
const SORTS: Array<{ id: StandingsSort; label: string }> = [
  { id: 'win', label: 'Win rate' },
  { id: 'finish', label: 'Avg finish' },
  { id: 'games', label: 'Games' },
];
/** A fair share of wins at a four-player table. */
const FAIR_SHARE = 0.25;
const RING_RADIUS = 50;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const MATRIX_DECKS = 6;

const report = ref<StatsReport | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);
const scope = ref<StatsScopeName>('all');
/** A batch id from an old `?batchId=` link; it selects the batch scope until the player picks another. */
const linkedBatchId = ref<string | null>(null);
const sort = ref<StandingsSort>('win');
const selectedId = ref<string | null>(null);
const generatedOpen = ref(false);
/** Entrance animations play once; after the first paint this goes false and they never replay. */
const intro = ref(true);
/** Bars and the ring start empty and grow once, then follow their values. */
const grown = ref(false);
const timers: number[] = [];

const decks = computed(() => report.value?.decks ?? []);
const played = computed(() => decks.value.filter((deck) => deck.gamesPlayed > 0));
const own = computed(() =>
  sortDecks(
    played.value.filter((deck) => !deck.generated),
    sort.value,
  ),
);
const generated = computed(() =>
  sortDecks(
    played.value.filter((deck) => deck.generated),
    sort.value,
  ),
);
const hasGames = computed(() => played.value.length > 0);
const summary = computed(() => report.value?.summary ?? null);

const selected = computed<DeckStatistic | null>(
  () => played.value.find((deck) => deck.deckSnapshotId === selectedId.value) ?? null,
);

function select(deck: DeckStatistic): void {
  selectedId.value = deck.deckSnapshotId;
}

function percent(value: number): number {
  return Math.round(value * 100);
}

// --- Standings -----------------------------------------------------------------------------

function finishTicks(deck: DeckStatistic): Array<{ left: string; height: string }> {
  const total = deck.finishDistribution.reduce((sum, n) => sum + n, 0);
  return deck.finishDistribution.map((count, index) => ({
    left: `${(index / 3) * 100}%`,
    height: `${total === 0 ? 5 : Math.round(5 + (count / total) * 10)}px`,
  }));
}
function finishLabel(deck: DeckStatistic): string {
  return deck.averageFinish === null
    ? 'No average finish'
    : `Average finish ${deck.averageFinish.toFixed(1)} of 4`;
}
function finishDotLeft(deck: DeckStatistic): string {
  if (!grown.value || deck.averageFinish === null) return '0%';
  return `${Math.min(100, Math.max(0, ((deck.averageFinish - 1) / 3) * 100))}%`;
}
function barWidth(fraction: number): string {
  return grown.value ? `${Math.min(100, Math.max(0, fraction * 100))}%` : '0%';
}
function rowTip(deck: DeckStatistic): string {
  const finish =
    deck.averageFinish === null ? '' : `, average finish ${deck.averageFinish.toFixed(1)}`;
  return `${deckHeading(deck)}: ${deck.wins} wins in ${deck.gamesPlayed} games (${percent(deck.winRate)}%)${finish}`;
}

// --- Matchups ------------------------------------------------------------------------------

const matrixDecks = computed(() =>
  [...own.value]
    .sort((a, b) => b.gamesPlayed - a.gamesPlayed || deckHeading(a).localeCompare(deckHeading(b)))
    .slice(0, MATRIX_DECKS),
);
const matchupCount = computed(() => {
  const counts = new Map<string, number>();
  for (const entry of report.value?.matchups ?? [])
    counts.set(`${entry.winner}|${entry.beaten}`, entry.games);
  return (winner: string, beaten: string): number => counts.get(`${winner}|${beaten}`) ?? 0;
});
const matrix = computed(() => {
  const shown = matrixDecks.value;
  const values: number[] = [];
  const rows = shown.map((winner) => {
    const cells = shown.map((beaten) => {
      const diagonal = winner.deckSnapshotId === beaten.deckSnapshotId;
      const games = diagonal ? 0 : matchupCount.value(winner.deckSnapshotId, beaten.deckSnapshotId);
      if (!diagonal) values.push(games);
      return { id: beaten.deckSnapshotId, diagonal, games, step: 0 };
    });
    return {
      id: winner.deckSnapshotId,
      name: deckHeading(winner),
      cells,
      total: cells.reduce((sum, cell) => sum + cell.games, 0),
    };
  });
  const min = values.length === 0 ? 0 : Math.min(...values);
  const max = values.length === 0 ? 0 : Math.max(...values);
  for (const row of rows) for (const cell of row.cells) cell.step = heatStep(cell.games, min, max);
  return { rows, min, max };
});
const names = computed(
  () => new Map(decks.value.map((deck) => [deck.deckSnapshotId, deckHeading(deck)])),
);
function cellTip(
  row: { id: string; name: string },
  cell: { id: string; diagonal: boolean; games: number },
): string {
  return cell.diagonal
    ? row.name
    : `${row.name} beat ${names.value.get(cell.id) ?? 'another deck'} in ${cell.games} ${cell.games === 1 ? 'game' : 'games'}`;
}

// --- The selected deck -----------------------------------------------------------------------

const mulligans = computed<BarRow[]>(() =>
  selected.value === null
    ? []
    : mulliganBuckets(selected.value.mulliganDistribution).map((bucket) => ({
        ...bucket,
        tip: '',
      })),
);
const mulliganTotal = computed(() => mulligans.value.reduce((sum, row) => sum + row.count, 0));
const causes = computed(() =>
  selected.value === null ? { rows: [] as BarRow[], total: 0 } : causeRows(selected.value),
);
const lossTotal = computed(() => {
  const beaten = selected.value?.lossesTo.reduce((sum, row) => sum + row.count, 0) ?? 0;
  return Math.max(causes.value.total, beaten);
});
const beatenBy = computed<BarRow[]>(() =>
  selected.value === null ? [] : lossesToRows(selected.value, lossTotal.value),
);
const panels = computed(() => [
  { title: 'Mulligans', rows: mulligans.value, total: mulliganTotal.value, unit: 'games' },
  { title: 'How it lost', rows: causes.value.rows, total: lossTotal.value, unit: 'losses' },
  { title: 'Who beats it', rows: beatenBy.value, total: lossTotal.value, unit: 'losses' },
]);
function panelTip(row: BarRow, total: number, unit: string): string {
  if (row.tip !== '') return row.tip;
  return row.label === '—' ? '' : `${row.count} of ${total} ${unit}`;
}
const vsFair = computed(() =>
  selected.value === null ? 0 : Math.round((selected.value.winRate - FAIR_SHARE) * 100),
);
const ringArc = computed(() => {
  const rate = grown.value && selected.value !== null ? selected.value.winRate : 0;
  return `${(RING_CIRCUMFERENCE * rate).toFixed(1)} ${RING_CIRCUMFERENCE.toFixed(1)}`;
});
const ringLabel = computed(() =>
  selected.value === null
    ? ''
    : `Won ${selected.value.wins} of ${selected.value.gamesPlayed} games, ${percent(selected.value.winRate)} percent. A fair share at a four-player table is 25 percent.`,
);

// --- Tiles -----------------------------------------------------------------------------------

const endUnit = computed(() => {
  const end = summary.value?.mostCommonEnd;
  return end === null || end === undefined ? '' : lowerFirst(end.label);
});

// --- Loading ---------------------------------------------------------------------------------

function pickScope(next: StatsScopeName): void {
  if (next === scope.value && linkedBatchId.value === null) return;
  if (next !== scope.value || next !== 'batch') linkedBatchId.value = null;
  scope.value = next;
  void load();
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    // The default scope sends no query at all, so the URL stays the plain `/api/stats`.
    const query = new URLSearchParams();
    if (scope.value !== 'all') query.set('scope', scope.value);
    if (scope.value === 'batch' && linkedBatchId.value !== null)
      query.set('batchId', linkedBatchId.value);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    const response = await fetch(`/api/stats${suffix}`);
    if (!response.ok)
      throw new Error(
        ((await response.json()) as { message?: string }).message ?? 'Could not load stats.',
      );
    report.value = normalizeReport(
      (await response.json()) as Parameters<typeof normalizeReport>[0],
    );
    if (selected.value === null)
      selectedId.value = (own.value[0] ?? generated.value[0])?.deckSnapshotId ?? null;
    // Let the first frame paint empty bars, then grow them.
    if (!grown.value) timers.push(window.setTimeout(() => (grown.value = true), 90));
    if (intro.value) timers.push(window.setTimeout(() => (intro.value = false), 2400));
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason);
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  const linked = new URLSearchParams(window.location.search).get('batchId');
  if (linked !== null && linked !== '') {
    linkedBatchId.value = linked;
    scope.value = 'batch';
  }
  void load();
});
onBeforeUnmount(() => timers.forEach((timer) => window.clearTimeout(timer)));

const HEAT_LEVELS = Array.from({ length: HEAT_STEPS }, (_, index) => index);
</script>

<template>
  <section class="stats" :class="{ intro }">
    <header class="top">
      <PageTitle place="II. Records · a. Stats" hide-kicker>Deck statistics</PageTitle>
      <div class="controls">
        <div class="dt-seg scope" role="group" aria-label="Which games">
          <button
            v-for="item in SCOPES"
            :key="item.id"
            type="button"
            :aria-pressed="scope === item.id"
            @click="pickScope(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
        <button type="button" class="dt-btn" @click="load">Refresh</button>
      </div>
    </header>

    <dl class="tiles">
      <div class="tile rise" style="--i: 0">
        <dt>Finished games</dt>
        <dd>
          <span class="big"><TweenNumber :value="summary?.finishedGames ?? 0" /></span>
          <span v-if="summary && summary.generatedGames > 0" class="unit"
            >{{ summary.generatedGames }} with generated decks</span
          >
        </dd>
      </div>
      <div class="tile rise" style="--i: 1">
        <dt>Decks tracked</dt>
        <dd>
          <span class="big"><TweenNumber :value="summary?.decksTracked ?? 0" /></span>
          <span class="unit">saved &amp; imported</span>
        </dd>
      </div>
      <div class="tile rise" style="--i: 2">
        <dt>Average game</dt>
        <dd>
          <span class="big"
            ><TweenNumber
              v-if="summary?.averageTurns != null"
              :value="summary.averageTurns"
              :decimals="1"
            /><template v-else>—</template></span
          >
          <span class="unit">turns</span>
        </dd>
      </div>
      <div class="tile rise" style="--i: 3">
        <dt>Most common end</dt>
        <dd>
          <span class="big"
            ><TweenNumber
              v-if="summary?.mostCommonEnd"
              :value="summary.mostCommonEnd.share * 100"
              suffix="%"
            /><template v-else>—</template></span
          >
          <span class="unit">{{ endUnit }}</span>
        </dd>
      </div>
    </dl>

    <p v-if="error" class="state error" role="alert">{{ error }}</p>
    <p v-else-if="loading && report === null" class="state">Loading…</p>
    <p v-else-if="!hasGames" class="state">No finished games yet.</p>

    <div v-else class="cols">
      <div class="left">
        <section aria-labelledby="standings-title" class="block">
          <div class="head">
            <span class="fig"
              ><span class="fig-no" aria-hidden="true">FIG. 001</span>
              <h2 id="standings-title">Standings</h2></span
            >
            <div class="sorts" role="group" aria-label="Sort by">
              <span class="label">Sort</span>
              <button
                v-for="item in SORTS"
                :key="item.id"
                type="button"
                class="sort"
                :aria-pressed="sort === item.id"
                @click="sort = item.id"
              >
                [ {{ item.label }} ]
              </button>
            </div>
          </div>

          <div class="grid st-grid st-head" aria-hidden="true">
            <span></span><span>Deck</span><span class="num">Games</span>
            <span class="win-head"
              ><span>Win rate</span><span class="legend">¦ 25% = fair share</span></span
            >
            <span class="hide-sm">Avg finish</span><span class="hide-sm num">Turns</span>
          </div>

          <ol class="rows">
            <li
              v-for="(deck, index) in own"
              :key="deck.deckSnapshotId"
              class="rise"
              :style="{ '--i': index + 3 }"
            >
              <button
                type="button"
                class="st-row grid st-grid"
                :class="{ on: selectedId === deck.deckSnapshotId }"
                :aria-pressed="selectedId === deck.deckSnapshotId"
                :title="rowTip(deck)"
                @click="select(deck)"
              >
                <span class="rank">{{ romanNumeral(index + 1) }}</span>
                <span class="deck-cell">
                  <span class="deck-name">{{ deckHeading(deck) }}</span>
                  <span class="deck-sub"
                    ><ManaPips :colors="deck.colorIdentity" /> · {{ deck.archetypeTag }}</span
                  >
                </span>
                <span class="num">{{ deck.gamesPlayed }}</span>
                <span class="win-cell">
                  <span class="track">
                    <span class="fill grow" :style="{ width: barWidth(deck.winRate) }"></span>
                    <span class="fair" aria-hidden="true"></span>
                  </span>
                  <span class="pct">{{ percent(deck.winRate) }}%</span>
                </span>
                <span class="finish hide-sm" role="img" :aria-label="finishLabel(deck)">
                  <span class="axis"></span>
                  <span
                    v-for="(tick, slot) in finishTicks(deck)"
                    :key="slot"
                    class="tick"
                    :style="{ left: tick.left, height: tick.height }"
                  ></span>
                  <span class="dot grow" :style="{ left: finishDotLeft(deck) }"></span>
                  <span class="end first">1st</span>
                  <span class="end last">4th</span>
                </span>
                <span class="num hide-sm">{{
                  deck.averageGameLength === null ? '—' : deck.averageGameLength.toFixed(1)
                }}</span>
              </button>
            </li>
          </ol>

          <template v-if="generated.length > 0">
            <button
              type="button"
              class="toggle"
              :aria-expanded="generatedOpen"
              @click="generatedOpen = !generatedOpen"
            >
              [ {{ generatedOpen ? 'Hide' : 'Show' }} {{ generated.length }} generated
              {{ generated.length === 1 ? 'deck' : 'decks' }} ]
            </button>
            <ul v-if="generatedOpen" class="gen">
              <li v-for="deck in generated" :key="deck.deckSnapshotId">
                <button
                  type="button"
                  class="gen-row"
                  :class="{ on: selectedId === deck.deckSnapshotId }"
                  :aria-pressed="selectedId === deck.deckSnapshotId"
                  @click="select(deck)"
                >
                  <span class="gen-name"
                    >{{ deckHeading(deck) }}
                    <ManaPips :colors="deck.colorIdentity" class="gen-pips"
                  /></span>
                  <span class="muted">{{ deck.gamesPlayed }}</span>
                  <span class="gen-rate">{{ percent(deck.winRate) }}%</span>
                </button>
              </li>
            </ul>
          </template>
        </section>

        <section v-if="matrix.rows.length > 0" aria-labelledby="matchups-title" class="block">
          <div class="head">
            <span class="fig"
              ><span class="fig-no" aria-hidden="true">FIG. 002</span>
              <h2 id="matchups-title">Matchups</h2></span
            >
          </div>
          <div class="matrix-scroll">
            <div
              class="matrix"
              role="table"
              aria-label="Matchup wins"
              :style="{ '--n': matrix.rows.length }"
            >
              <div class="m-row m-head" role="row">
                <span role="columnheader" class="m-corner">Winner ↓ · beaten →</span>
                <span
                  v-for="column in matrix.rows"
                  :key="column.id"
                  role="columnheader"
                  class="m-col"
                  :class="{ on: selectedId === column.id }"
                  :title="column.name"
                  >{{ column.name }}</span
                >
                <span role="columnheader" class="m-total">Total</span>
              </div>
              <div
                v-for="row in matrix.rows"
                :key="row.id"
                role="row"
                class="m-row"
                :class="{ on: selectedId === row.id }"
              >
                <span role="rowheader" class="m-name" :title="row.name">{{ row.name }}</span>
                <span
                  v-for="cell in row.cells"
                  :key="cell.id"
                  role="cell"
                  class="m-cell"
                  :class="[
                    `heat-${cell.step}`,
                    {
                      diag: cell.diagonal,
                      sel: selectedId === row.id || selectedId === cell.id,
                      'sel-row': selectedId === row.id,
                      'sel-col': selectedId === cell.id,
                    },
                  ]"
                  :title="cellTip(row, cell)"
                >
                  <svg
                    v-if="cell.diagonal"
                    viewBox="0 0 14 14"
                    width="12"
                    height="12"
                    aria-hidden="true"
                  >
                    <path d="M7 0 L8 6 L14 7 L8 8 L7 14 L6 8 L0 7 L6 6 Z" fill="currentColor" />
                  </svg>
                  <template v-else>{{ cell.games }}</template>
                </span>
                <span role="cell" class="m-total">{{ row.total }}</span>
              </div>
            </div>
          </div>
          <div class="heat-legend" aria-hidden="true">
            <span>{{ matrix.min }}</span>
            <span class="swatches"
              ><span v-for="level in HEAT_LEVELS" :key="level" :class="`heat-${level}`"></span
            ></span>
            <span>{{ matrix.max }}</span>
          </div>
        </section>
      </div>

      <aside v-if="selected" class="detail" aria-labelledby="detail-title">
        <div class="d-head">
          <span class="label">Selected deck</span>
          <h2 id="detail-title">{{ deckHeading(selected) }}</h2>
          <span class="deck-sub"
            ><ManaPips :colors="selected.colorIdentity" /> · {{ selected.archetypeTag }} ·
            {{ selected.gamesPlayed }} {{ selected.gamesPlayed === 1 ? 'game' : 'games' }}</span
          >
        </div>

        <div class="d-ring">
          <div class="ring">
            <svg viewBox="0 0 120 120" role="img" :aria-label="ringLabel">
              <circle cx="60" cy="60" r="50" class="ring-track" />
              <circle
                cx="60"
                cy="60"
                r="50"
                class="ring-arc"
                :stroke-dasharray="ringArc"
                transform="rotate(-90 60 60)"
              />
              <line x1="110" y1="60" x2="117" y2="60" class="ring-fair" />
              <circle cx="60" cy="60" r="38" class="ring-inner" />
            </svg>
            <div class="ring-text">
              <span class="ring-pct"
                ><TweenNumber :value="selected.winRate * 100" suffix="%"
              /></span>
              <span class="ring-of"
                ><TweenNumber :value="selected.wins" /> of
                <TweenNumber :value="selected.gamesPlayed"
              /></span>
            </div>
          </div>
          <dl class="facts">
            <dt>Avg finish</dt>
            <dd>
              <TweenNumber
                v-if="selected.averageFinish !== null"
                :value="selected.averageFinish"
                :decimals="1"
              /><template v-else>—</template>
            </dd>
            <dt>Game length</dt>
            <dd>
              <template v-if="selected.averageGameLength !== null"
                ><TweenNumber :value="selected.averageGameLength" :decimals="1" /> turns</template
              ><template v-else>—</template>
            </dd>
            <dt>Mulligans per game</dt>
            <dd><TweenNumber :value="selected.averageMulligans" :decimals="2" /></dd>
            <dt>Vs fair share</dt>
            <dd><TweenNumber :value="vsFair" signed /> points</dd>
          </dl>
        </div>

        <section v-for="panel in panels" :key="panel.title" class="d-block">
          <h3>{{ panel.title }}</h3>
          <div
            v-for="(row, index) in panel.rows"
            :key="index"
            class="bar-row"
            :title="panelTip(row, panel.total, panel.unit)"
          >
            <span class="bar-label">{{ row.label }}</span>
            <span class="bar-track"
              ><span
                class="fill grow"
                :style="{ width: barWidth(panel.total === 0 ? 0 : row.count / panel.total) }"
              ></span
            ></span>
            <span class="bar-value"><TweenNumber :value="row.count" /></span>
          </div>
        </section>

        <div class="d-actions">
          <RouterLink to="/batch" class="dt-btn"
            >Games in batch runs <span class="dt-arr" aria-hidden="true"
          /></RouterLink>
          <RouterLink
            v-if="selected.lastGameId"
            :to="{ name: 'debug', query: { gameId: selected.lastGameId } }"
            class="dt-btn"
            >Open last game in Debug <span class="dt-arr" aria-hidden="true"
          /></RouterLink>
          <button v-else type="button" class="dt-btn" disabled>
            Open last game in Debug <span class="dt-arr" aria-hidden="true" />
          </button>
        </div>
      </aside>
    </div>

    <PageFoot place="II. Records · a. Stats" />
  </section>
</template>

<style scoped>
.stats {
  max-width: 1280px;
  margin: 0 auto;
  padding: 1.5rem 1.5rem 3rem;
  display: flex;
  flex-direction: column;
  gap: 2rem;
  font-family: var(--font-body);
  color: var(--ink);
}
h2,
h3,
p,
dl,
dd {
  margin: 0;
}
.st-row,
.gen-row,
.sort,
.toggle {
  font: inherit;
  color: inherit;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
}
button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--ink);
  outline-offset: 3px;
}
.label,
.st-head,
dt,
h3 {
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
}
.muted {
  color: var(--muted);
}

/* Entrances: once, on first paint. `.intro` drops away after the first seconds. */
.intro .rise {
  animation: statsRise 0.6s var(--ease) calc(var(--i, 0) * 0.07s) both;
}
@keyframes statsRise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.grow {
  transition:
    width 1s var(--ease),
    left 1s var(--ease);
}

/* Title and scope */
.top {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: 1.25rem 2rem;
}
.top :deep(.page-title) {
  flex: 1 1 22rem;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem 1.25rem;
}
.scope {
  flex-wrap: nowrap;
}
.scope > * {
  flex: 0 0 auto;
  min-height: 44px;
  text-align: center;
}
.dt-btn {
  min-height: 44px;
}

/* Fact tiles */
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10.5rem, 1fr));
  border-top: 1px solid var(--ink);
  border-left: 1px solid var(--ink);
}
.tile {
  border-right: 1px solid var(--ink);
  border-bottom: 1px solid var(--ink);
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}
.tile dd {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.15rem 0.5rem;
}
.big {
  font-family: var(--font-display);
  font-size: 2.1rem;
  line-height: 1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}
.unit {
  font-size: 0.725rem;
  color: var(--muted);
}

.state {
  color: var(--muted);
  font-size: 0.9rem;
}
.state.error {
  color: var(--danger);
}

/* Columns */
.cols {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(22rem, 28rem);
  gap: 2.5rem;
  align-items: start;
}
.left {
  display: flex;
  flex-direction: column;
  gap: 2.5rem;
  min-width: 0;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 0.9rem;
  min-width: 0;
}
.head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem 1.5rem;
}
.fig {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}
.fig-no {
  font-size: 0.6rem;
  letter-spacing: 0.09em;
  color: var(--muted);
}
.fig h2,
.d-head h2 {
  font-family: var(--font-display);
  font-weight: 400;
  font-size: 2.1rem;
  line-height: 1;
  letter-spacing: -0.03em;
  text-transform: uppercase;
}
.sorts {
  display: flex;
  align-items: center;
  gap: 0.25rem 0.75rem;
  font-size: 0.8rem;
}
.sort {
  min-height: 44px;
  display: inline-flex;
  align-items: center;
}
.sort[aria-pressed='true'] {
  text-decoration: underline;
  text-underline-offset: 0.35em;
}

/* Standings */
.st-grid {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) 4rem minmax(9rem, 13rem) 7rem 4.5rem;
  gap: 1rem;
  align-items: center;
}
.st-head {
  align-items: end;
  padding: 0 0.75rem 0.4rem;
  border-bottom: 1px solid var(--ink);
  font-size: 0.65rem;
}
.win-head {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
}
.legend {
  font-family: var(--font-body);
  letter-spacing: 0.04em;
  text-transform: none;
}
.num {
  text-align: right;
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
}
.st-head .num {
  font-size: inherit;
}
.rows {
  margin: 0;
  padding: 0;
  list-style: none;
}
.rows > li {
  border-bottom: 1px solid var(--ink);
}
.st-row {
  width: 100%;
  padding: 0.85rem 0.75rem;
  transition: background-color 0.3s var(--ease);
}
.st-row:hover,
.st-row.on {
  background: var(--paper-2);
}
.rank {
  font-family: var(--font-display);
  font-size: 1.6rem;
  line-height: 1;
}
.deck-cell {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}
.deck-name {
  font-family: var(--font-ui);
  font-size: 0.85rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.deck-sub {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.2rem 0.4rem;
  font-size: 0.725rem;
  color: var(--muted);
}
.win-cell {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.track {
  position: relative;
  flex: 1;
  height: 10px;
  background: var(--paper-2);
  box-shadow: inset 0 0 0 1px var(--rule);
}
.fill {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  background: var(--ink);
}
.fair {
  position: absolute;
  left: 25%;
  top: -4px;
  bottom: -4px;
  border-left: 1px dashed var(--ink);
}
.pct {
  min-width: 2.6rem;
  text-align: right;
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
}
.finish {
  position: relative;
  height: 18px;
}
.finish .axis {
  position: absolute;
  left: 0;
  right: 0;
  top: 8px;
  height: 1px;
  background: var(--ink);
}
.finish .tick {
  position: absolute;
  top: 8px;
  width: 1px;
  background: var(--ink);
  transform: translateY(-50%);
  transition: height 0.6s var(--ease);
}
.finish .dot {
  position: absolute;
  top: 3px;
  width: 11px;
  height: 11px;
  margin-left: -5.5px;
  border-radius: 50%;
  background: var(--ink);
  border: 2px solid var(--paper);
  box-sizing: border-box;
}
.finish .end {
  position: absolute;
  top: 14px;
  font-size: 0.55rem;
  color: var(--muted);
}
.finish .first {
  left: 0;
}
.finish .last {
  right: 0;
}
.toggle {
  align-self: flex-start;
  min-height: 44px;
  display: inline-flex;
  align-items: center;
  font-size: 0.8rem;
}
.gen {
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--ink);
}
.gen li {
  border-bottom: 1px solid var(--ink);
}
.gen-row {
  width: 100%;
  min-height: 44px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 2.5rem 3rem;
  gap: 1rem;
  align-items: center;
  padding: 0.35rem 0.75rem;
  font-size: 0.8rem;
  transition: background-color 0.3s var(--ease);
}
.gen-row:hover,
.gen-row.on {
  background: var(--paper-2);
}
.gen-name {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gen-rate {
  text-align: right;
}

/* Matchups */
.matrix-scroll {
  overflow-x: auto;
  max-width: 100%;
}
.matrix {
  display: flex;
  flex-direction: column;
  font-size: 0.8rem;
  min-width: 30rem;
  --cols: minmax(7rem, 30fr) repeat(var(--n), minmax(2.6rem, 14.5fr)) minmax(3rem, 12fr);
}
.m-row {
  display: grid;
  grid-template-columns: var(--cols);
  gap: 0 6px;
  align-items: center;
  border-top: 1px solid var(--ink);
  padding: 4px 0;
}
.m-head {
  border-top: 0;
  padding: 0 0 0.5rem;
  font-family: var(--font-ui);
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.m-corner,
.m-total {
  color: var(--muted);
}
.m-head .m-total {
  text-align: right;
}
.m-row > .m-total {
  text-align: right;
  color: var(--ink);
}
.m-head .m-total {
  color: var(--muted);
}
.m-col {
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.m-col.on {
  text-decoration: underline;
  text-underline-offset: 0.3em;
}
.m-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.m-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 2.4rem;
  font-size: 0.9rem;
  font-variant-numeric: tabular-nums;
  transition:
    background-color 0.4s var(--ease),
    box-shadow 0.4s var(--ease);
}
.m-cell.diag {
  color: var(--rule);
}
.m-cell.sel-row,
.m-cell.sel-col {
  box-shadow:
    inset 0 0 0 1px var(--ink),
    inset 0 0 0 2px var(--paper);
}
/* Heat: six steps from --rule to --ink; text flips to paper once the fill is dark enough. */
.heat-0 {
  background: var(--rule);
  color: var(--ink);
}
.heat-1 {
  background: color-mix(in srgb, var(--ink) 15%, var(--rule));
  color: var(--ink);
}
.heat-2 {
  background: color-mix(in srgb, var(--ink) 30%, var(--rule));
  color: var(--ink);
}
.heat-3 {
  background: color-mix(in srgb, var(--ink) 70%, var(--rule));
  color: var(--paper);
}
.heat-4 {
  background: color-mix(in srgb, var(--ink) 85%, var(--rule));
  color: var(--paper);
}
.heat-5 {
  background: var(--ink);
  color: var(--paper);
}
.m-cell.diag {
  background: transparent;
}
.m-cell.diag.sel-row,
.m-cell.diag.sel-col {
  background: transparent;
}
.heat-legend {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.6rem;
  letter-spacing: 0.09em;
  color: var(--muted);
}
.swatches {
  display: flex;
}
.swatches > span {
  width: 1.6rem;
  height: 0.6rem;
}

/* Detail */
.detail {
  position: sticky;
  top: 1rem;
  border: 1px solid var(--ink);
  min-width: 0;
}
.d-head {
  padding: 1.25rem 1.5rem;
  border-bottom: 1px solid var(--ink);
  background: var(--paper-2);
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.d-ring {
  padding: 1.25rem 1.5rem;
  display: flex;
  align-items: center;
  gap: 1.5rem;
  border-bottom: 1px solid var(--ink);
}
.ring {
  position: relative;
  width: 9.5rem;
  height: 9.5rem;
  flex: 0 0 auto;
}
.ring svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.ring-track,
.ring-arc,
.ring-inner {
  fill: none;
}
.ring-track {
  stroke: var(--paper-2);
  stroke-width: 10;
}
.ring-arc {
  stroke: var(--ink);
  stroke-width: 10;
  transition: stroke-dasharray 0.8s var(--ease);
}
.ring-fair {
  stroke: var(--warm);
  stroke-width: 3;
}
.ring-inner {
  stroke: var(--ink);
  stroke-width: 1;
}
.ring-text {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.ring-pct {
  font-family: var(--font-display);
  font-size: 2.1rem;
  line-height: 1;
}
.ring-of {
  font-size: 0.6rem;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--muted);
}
.facts {
  flex: 1;
  min-width: 0;
  display: grid;
  grid-template-columns: auto auto;
  gap: 0.45rem 1rem;
  align-items: baseline;
  justify-content: space-between;
}
.facts dd {
  font-size: 0.9rem;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.d-block {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--ink);
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}
.d-block h3 {
  font-weight: 400;
  color: var(--ink);
}
.bar-row {
  display: grid;
  grid-template-columns: minmax(0, 10rem) minmax(0, 1fr) 2.6rem;
  gap: 0.75rem;
  align-items: center;
  font-size: 0.8rem;
}
.bar-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar-track {
  position: relative;
  height: 8px;
  background: var(--paper-2);
  box-shadow: inset 0 0 0 1px var(--rule);
}
.bar-value {
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.d-actions {
  padding: 1rem 1.5rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
}
.dt-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@media (max-width: 1100px) {
  .cols {
    grid-template-columns: minmax(0, 1fr);
  }
  .detail {
    position: static;
  }
}
@media (max-width: 760px) {
  .stats {
    padding: 1rem 1rem 2.5rem;
    gap: 1.5rem;
  }
  .st-grid {
    grid-template-columns: 1.75rem minmax(7rem, 1fr) 2.25rem 6.25rem;
    gap: 0.6rem;
  }
  .hide-sm {
    display: none !important;
  }
  .st-row {
    padding-left: 0.4rem;
    padding-right: 0.4rem;
    align-items: start;
  }
  .deck-name {
    white-space: normal;
    overflow-wrap: anywhere;
    line-height: 1.25;
  }
  .legend {
    display: none;
  }
  .scope {
    width: 100%;
  }
  .scope > * {
    flex: 1 1 0;
    padding: 0 0.4rem;
    font-size: 0.62rem;
    white-space: normal;
  }
  .d-ring {
    flex-direction: column;
    align-items: stretch;
  }
  .ring {
    align-self: center;
  }
  .d-head,
  .d-ring,
  .d-block,
  .d-actions {
    padding-left: 1rem;
    padding-right: 1rem;
  }
  .bar-row {
    grid-template-columns: minmax(0, 7.5rem) minmax(0, 1fr) 2rem;
    gap: 0.5rem;
  }
}
</style>
