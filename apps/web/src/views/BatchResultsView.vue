<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type { BatchResults } from '@mtg/shared';
const route = useRoute(); const batchId = String(route.params['id']); const data = ref<BatchResults | null>(null); const error = ref<string | null>(null); let timer: ReturnType<typeof setInterval> | null = null;
const terminal = computed(() => data.value !== null && ['completed','failed','cancelled'].includes(data.value.progress.status));
async function load(): Promise<void> { try { const response = await fetch(`/api/batches/${encodeURIComponent(batchId)}/results`); if (!response.ok) throw new Error((await response.json() as {message?:string}).message ?? 'Could not load batch.'); data.value = await response.json() as BatchResults; if (terminal.value && timer !== null) { clearInterval(timer); timer = null; } } catch (reason) { error.value = reason instanceof Error ? reason.message : String(reason); } }
async function cancel(): Promise<void> { await fetch(`/api/batches/${encodeURIComponent(batchId)}/cancel`, { method:'POST' }); await load(); }
function percent(done: number, total: number): string { return total === 0 ? '0%' : `${Math.round(done / total * 100)}%`; }
onMounted(() => { void load(); timer = setInterval(() => void load(), 1000); }); onUnmounted(() => { if (timer !== null) clearInterval(timer); });
</script>
<template>
  <section class="batch-results"><header class="result-head"><div><p class="eyebrow">Batch {{ batchId }}</p><h1>Simulation results</h1><p v-if="data" class="hint">Seed {{ data.progress.seed }} · {{ data.progress.status }}</p></div><div class="actions"><button v-if="data && !terminal" type="button" @click="cancel">Cancel</button><RouterLink to="/batch">New batch</RouterLink></div></header>
    <p v-if="error" class="error">{{ error }}</p><p v-else-if="!data">Loading…</p>
    <template v-else>
      <section class="summary"><div><strong>{{ data.progress.completedGames }}/{{ data.progress.totalGames }}</strong><span>processed</span></div><div><strong>{{ percent(data.progress.completedGames, data.progress.totalGames) }}</strong><span>progress</span></div><div><strong>{{ data.aggregate.gamesFinished }}</strong><span>finished</span></div><div><strong>{{ data.aggregate.gamesFailed }}</strong><span>failed</span></div><div><strong>{{ data.aggregate.averageTurns?.toFixed(1) ?? '—' }}</strong><span>avg turns</span></div></section>
      <p v-if="data.progress.failure" class="error">Stopped: {{ data.progress.failure.reason }}</p>
      <section class="panel"><h2>Scenarios</h2><div v-for="scenario in data.progress.scenarios" :key="scenario.id" class="scenario-row"><span>{{ scenario.name }}</span><span>{{ scenario.completedGames }}/{{ scenario.games }} · {{ scenario.status }}</span></div></section>
      <section class="panel"><h2>Games</h2><div class="table-wrap"><table><thead><tr><th>Scenario</th><th>Game</th><th>Seed</th><th>Status</th><th>Winner</th><th>Turns</th></tr></thead><tbody><tr v-for="game in data.games" :key="game.gameId"><td>{{ game.scenarioName }}</td><td>{{ game.gameIndex + 1 }}</td><td><code>{{ game.seed }}</code></td><td>{{ game.status }}</td><td>{{ game.winnerSeat ?? '—' }}</td><td>{{ game.turnCount ?? '—' }}</td></tr></tbody></table></div></section>
      <section class="panel"><h2>Aggregate</h2><p class="hint">AI calls {{ data.aggregate.ai.calls }} · tokens {{ data.aggregate.ai.promptTokens + data.aggregate.ai.responseTokens }} · cost ${{ data.aggregate.ai.costUsd.toFixed(4) }}</p><div class="scenario-row" v-for="entry in data.aggregate.winsBySeat" :key="entry.seat"><span>{{ entry.seat }}</span><span>{{ entry.wins }} wins</span></div></section>
      <RouterLink :to="`/stats?batchId=${encodeURIComponent(batchId)}`">Open batch-filtered deck stats →</RouterLink>
    </template>
  </section>
</template>
<style scoped>
.batch-results{max-width:1100px;margin:0 auto;padding:1.25rem 1rem 3rem;display:flex;flex-direction:column;gap:.75rem}.result-head{display:flex;justify-content:space-between;gap:1rem;align-items:start}.result-head h1{margin:.25rem 0}.eyebrow{margin:0;text-transform:uppercase;letter-spacing:.1em;font-size:10px;font-weight:700;color:var(--muted)}.hint{color:var(--muted);font-size:11px}.actions{display:flex;gap:.6rem;align-items:center}.summary{display:grid;grid-template-columns:repeat(5,1fr);gap:.5rem}.summary div,.panel{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:.8rem}.summary strong,.summary span{display:block}.summary span{color:var(--muted);font-size:10px;margin-top:.2rem}.panel h2{font-size:1rem;margin:0 0 .6rem}.scenario-row{display:flex;justify-content:space-between;border-top:1px solid var(--line);padding:.45rem 0;font-size:.85rem}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:.8rem}th,td{text-align:left;border-top:1px solid var(--line);padding:.45rem;white-space:nowrap}.error{color:var(--danger);border-left:2px solid var(--danger);padding-left:.5rem}@media(max-width:700px){.summary{grid-template-columns:repeat(2,1fr)}.result-head{display:block}.actions{margin-top:.6rem}}
</style>
