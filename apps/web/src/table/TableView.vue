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
  <div class="table-view" :class="{ playing: playing && table.phase !== 'finished' }">
    <p v-if="stoppedText" class="banner dt-note danger" role="alert" data-testid="stopped">
      {{ stoppedText }}
    </p>
    <p v-else-if="table.connection !== 'open'" class="connecting" aria-live="polite">
      <span class="pulse" aria-hidden="true" />
      {{ table.connection === 'closed' ? 'Reconnecting…' : 'Connecting…' }}
    </p>

    <template v-if="table.phase === 'finished'">
      <TablePostGame />
    </template>

    <template v-else-if="playing">
      <TableStatusBar />
      <PlayerGameView v-if="game.gameId !== null" />
      <p v-else class="connecting">
        <span class="pulse" aria-hidden="true" />The game is starting…
      </p>
    </template>

    <template v-else-if="table.state !== null && inTable">
      <TableStatusBar v-if="table.insecureLan" />
      <TableLobby />
    </template>

    <form
      v-if="table.connection === 'open' && !joined && (table.phase ?? 'open') === 'open'"
      class="join dt-rise"
      data-testid="join-form"
      @submit.prevent="join"
    >
      <p class="dt-kicker">{{ table.isHost ? 'You host this table' : 'You are invited' }}</p>
      <h1 class="dt-title">{{ table.isHost ? 'Play at your table' : 'Join the table' }}</h1>
      <div class="dt-ornament" aria-hidden="true"><span class="star" /></div>
      <p class="intro">
        {{
          table.isHost
            ? 'Join by name like everyone else to take a seat. You can run the table without one.'
            : 'Pick the name the table will see. You choose a seat and a deck next.'
        }}
      </p>
      <p v-if="inviteCode === ''" class="dt-note danger">
        This link has no invite code. Ask the host for the full link.
      </p>
      <div class="row">
        <label class="dt-field">
          <span>Your name</span>
          <input v-model="name" maxlength="24" autocomplete="nickname" data-testid="display-name" />
        </label>
        <button
          type="submit"
          class="dt-btn-primary"
          :disabled="name.trim() === '' || inviteCode === ''"
          data-testid="join"
        >
          Join<span class="dt-arr" aria-hidden="true" />
        </button>
      </div>
    </form>

    <ul v-if="table.errors.length > 0 && !playing" class="errors dt-note danger" role="alert">
      <li v-for="error in table.errors" :key="error">{{ error }}</li>
    </ul>
  </div>
</template>

<style scoped>
/* In play the board fills the window under the table bar. */
.table-view.playing {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.table-view.playing > :deep(.player-game) {
  flex: 1;
  min-height: 0;
}
.join {
  max-width: 34rem;
  margin: 4rem auto 2rem;
  padding: 0 1.5rem;
  display: grid;
  gap: 1rem;
}
.join .dt-kicker,
.intro {
  margin: 0;
}
.intro {
  font-family: var(--font-body);
  font-size: 0.95rem;
  line-height: 1.55;
}
.row {
  display: flex;
  align-items: flex-end;
  gap: 1rem;
}
.row .dt-field {
  flex: 1;
}
.banner,
.errors {
  max-width: 48rem;
  margin: 1rem auto;
}
.errors {
  list-style: none;
}
.connecting {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.6rem;
  margin: 1rem auto;
  font-family: var(--font-ui);
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--muted);
}
.pulse {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--warm);
  animation: tablePulse 1.2s var(--ease) infinite alternate;
}
@keyframes tablePulse {
  from {
    opacity: 0.3;
  }
  to {
    opacity: 1;
  }
}
@media (max-width: 560px) {
  .join {
    margin-top: 2rem;
    padding: 0 1rem;
  }
  .row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
