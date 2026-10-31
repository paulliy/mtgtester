<script setup lang="ts">
/**
 * One table's page (plan M6): joining with the invite in the address fragment, then the lobby,
 * then the player board with the table bar, then the post-game view. The phase decides which.
 */
import { computed, onUnmounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PlayerGameView from '../views/PlayerGameView.vue';
import { useGameStore } from '../stores/game';
import { useTableStore } from '../stores/table';
import { inviteCodeFor } from './invite';
import TableLobby from './TableLobby.vue';
import TablePostGame from './TablePostGame.vue';
import TableStatusBar from './TableStatusBar.vue';

const route = useRoute();
const table = useTableStore();
const game = useGameStore();
const name = ref('');

const tableId = computed(() => String(route.params['id'] ?? ''));
const inviteCode = computed(() => inviteCodeFor(route.hash, table.state?.inviteCode));

// Vue Router reuses this view when only the table id changes.
watch(tableId, (id) => table.open(id), { immediate: true });
onUnmounted(() => {
  table.close();
});

/** You have joined with a name, or hold a seat from an earlier visit. */
const joined = computed(
  () =>
    (table.you?.displayName !== null && table.you?.displayName !== undefined) ||
    table.seatToken !== null,
);
/** The host sees the lobby before joining, and joins like anyone else to play. */
const inTable = computed(() => joined.value || table.isHost);
const playing = computed(
  () => (table.phase === 'playing' || table.phase === 'starting') && table.mySeat !== null,
);
const stoppedText = computed(() => {
  switch (table.stopped) {
    case 'takenOver':
      return 'Your seat is open in another tab or device. Close this one.';
    case 'protocolMismatch':
      return 'This page is out of date. Reload it.';
    case 'kicked':
      return 'The host removed you from this table.';
    case 'reaped':
    case 'abandoned':
      return 'This table has closed.';
    default:
      return null;
  }
});

function join(): void {
  table.join(inviteCode.value, name.value.trim());
}
</script>

<template>
  <div class="table-view">
    <p v-if="stoppedText" class="stopped" role="alert" data-testid="stopped">{{ stoppedText }}</p>
    <p v-else-if="table.connection !== 'open'" class="connecting">
      {{ table.connection === 'closed' ? 'Reconnecting…' : 'Connecting…' }}
    </p>

    <template v-if="table.phase === 'finished'">
      <TablePostGame />
    </template>

    <template v-else-if="playing">
      <TableStatusBar />
      <PlayerGameView v-if="game.gameId !== null" />
      <p v-else class="connecting">The game is starting…</p>
    </template>

    <template v-else-if="table.state !== null && inTable">
      <TableStatusBar v-if="table.insecureLan" />
      <TableLobby />
    </template>

    <form
      v-if="table.connection === 'open' && !joined && (table.phase ?? 'open') === 'open'"
      class="join"
      data-testid="join-form"
      @submit.prevent="join"
    >
      <h1>{{ table.isHost ? 'Play at your table' : 'Join the table' }}</h1>
      <p v-if="inviteCode === ''" class="error">
        This link has no invite code. Ask the host for the full link.
      </p>
      <label>
        Your name
        <input v-model="name" maxlength="24" autocomplete="nickname" data-testid="display-name" />
      </label>
      <button type="submit" :disabled="name.trim() === '' || inviteCode === ''" data-testid="join">
        Join
      </button>
    </form>

    <ul v-if="table.errors.length > 0 && !playing" class="errors" role="alert">
      <li v-for="error in table.errors" :key="error">{{ error }}</li>
    </ul>
  </div>
</template>

<style scoped>
.join {
  max-width: 28rem;
  margin: 3rem auto;
  display: grid;
  gap: 0.75rem;
}
.join label {
  display: grid;
  gap: 0.25rem;
}
.stopped,
.errors,
.error {
  color: var(--danger, #e05a5a);
}
.stopped,
.connecting {
  text-align: center;
}
</style>
