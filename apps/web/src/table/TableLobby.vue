<script setup lang="ts">
/**
 * The lobby (plan M6 task 4): the seat grid, asking for a seat with a pasted decklist (and its
 * problems, which only you see), and for the host the approval queue, a bot or an open seat per
 * seat, kicking, the invite link, starting and abandoning.
 */
import { computed, ref } from 'vue';
import type { PlayerId } from '@mtg/shared';
import { useTableStore } from '../stores/table';

const table = useTableStore();
const decklist = ref('');
const seat = ref<PlayerId>('P1');
const copied = ref(false);

const state = computed(() => table.state);
const openSeats = computed(() =>
  (state.value?.seats ?? []).filter((entry) => entry.controller === 'open').map((e) => e.seat),
);
const myClaim = computed(() => table.you?.claim ?? null);
const inviteLink = computed(() =>
  state.value?.inviteCode === undefined || table.tableId === null
    ? null
    : `${window.location.origin}/t/${table.tableId}#${state.value.inviteCode}`,
);

function request(): void {
  const target = openSeats.value.includes(seat.value) ? seat.value : openSeats.value[0];
  if (target === undefined) return;
  table.requestSeat(target, decklist.value);
}

async function copyInvite(): Promise<void> {
  if (inviteLink.value === null) return;
  try {
    await navigator.clipboard.writeText(inviteLink.value);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch {
    copied.value = false;
  }
}

const controllerLabel = (controller: string): string =>
  controller === 'human' ? 'Player' : controller === 'bot' ? 'Bot' : 'Open';
</script>

<template>
  <section v-if="state" class="lobby" data-testid="lobby">
    <h2>Table lobby</h2>
    <ul class="seats" data-testid="seat-grid">
      <li
        v-for="entry in state.seats"
        :key="entry.seat"
        :class="['seat', entry.controller, { you: entry.seat === table.mySeat }]"
        :data-testid="`seat-${entry.seat}`"
      >
        <strong>{{ entry.seat }}</strong>
        <span>{{ entry.displayName ?? controllerLabel(entry.controller) }}</span>
        <span v-if="entry.controller === 'human'" :class="['dot', { on: entry.connected }]" />
        <template v-if="table.isHost && state.phase === 'open'">
          <button
            v-if="entry.controller === 'open'"
            type="button"
            :data-testid="`make-bot-${entry.seat}`"
            @click="table.setSeat(entry.seat, 'bot')"
          >
            Bot
          </button>
          <button
            v-else-if="entry.controller === 'bot'"
            type="button"
            @click="table.setSeat(entry.seat, 'open')"
          >
            Open
          </button>
          <button
            v-else
            type="button"
            :data-testid="`kick-${entry.seat}`"
            @click="table.kick(entry.seat)"
          >
            Kick
          </button>
        </template>
      </li>
    </ul>

    <div v-if="table.mySeat" class="mine">
      You hold {{ table.mySeat }}.
      <button v-if="state.phase === 'open'" type="button" @click="table.leaveSeat()">
        Leave seat
      </button>
    </div>
    <div v-else-if="myClaim" class="mine" data-testid="claim-pending">
      Waiting for the host to approve {{ myClaim.seat }}. Your code:
      <strong>{{ myClaim.verificationCode }}</strong>
      <button type="button" @click="table.leaveSeat()">Withdraw</button>
    </div>
    <form v-else-if="state.phase === 'open'" class="claim" @submit.prevent="request">
      <label>
        Seat
        <select v-model="seat" data-testid="claim-seat">
          <option v-for="open in openSeats" :key="open" :value="open">{{ open }}</option>
        </select>
      </label>
      <label class="deck">
        Decklist
        <textarea
          v-model="decklist"
          rows="10"
          spellcheck="false"
          placeholder="Commander&#10;Atraxa, Praetors' Voice&#10;&#10;Deck&#10;1 Sol Ring&#10;…"
          data-testid="decklist"
        />
      </label>
      <button
        type="submit"
        :disabled="decklist.trim() === '' || openSeats.length === 0"
        data-testid="request-seat"
      >
        Ask for a seat
      </button>
    </form>
    <ul v-if="table.deckProblems.length > 0" class="problems" role="alert" data-testid="problems">
      <li v-for="(problem, index) in table.deckProblems" :key="index">{{ problem.message }}</li>
    </ul>

    <section v-if="table.isHost" class="host" data-testid="host-panel">
      <h3>Host</h3>
      <div v-if="inviteLink" class="invite">
        <input :value="inviteLink" readonly data-testid="invite-link" />
        <button type="button" @click="copyInvite">{{ copied ? 'Copied' : 'Copy invite' }}</button>
        <button v-if="state.phase === 'open'" type="button" @click="table.rotateInvite()">
          New invite
        </button>
      </div>
      <ul v-if="(state.pendingClaims ?? []).length > 0" class="claims" data-testid="claims">
        <li v-for="claim in state.pendingClaims" :key="claim.claimId">
          {{ claim.displayName }} asks for {{ claim.seat }} · code
          <strong>{{ claim.verificationCode }}</strong>
          <button
            type="button"
            :data-testid="`approve-${claim.seat}`"
            @click="table.approve(claim.claimId)"
          >
            Approve
          </button>
          <button type="button" @click="table.deny(claim.claimId)">Deny</button>
        </li>
      </ul>
      <p v-else-if="state.phase === 'open'" class="hint">No seat requests waiting.</p>
      <p v-if="state.clock" class="hint">Clock: {{ state.clock }}</p>
      <ul v-if="!state.canStart && state.startBlockers.length > 0" class="blockers">
        <li v-for="blocker in state.startBlockers" :key="blocker">{{ blocker }}</li>
      </ul>
      <div class="actions">
        <button
          v-if="state.phase === 'open'"
          type="button"
          :disabled="!state.canStart"
          data-testid="start"
          @click="table.start()"
        >
          Start
        </button>
        <button
          v-if="state.phase === 'starting' || state.phase === 'playing'"
          type="button"
          data-testid="abandon"
          @click="table.abandon()"
        >
          End the game
        </button>
      </div>
    </section>
  </section>
</template>

<style scoped>
.lobby {
  max-width: 48rem;
  margin: 1.5rem auto;
  display: grid;
  gap: 1rem;
}
.seats {
  list-style: none;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.5rem;
}
.seat {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  padding: 0.5rem;
  border: 1px solid var(--border, #444);
  border-radius: 6px;
}
.seat.you {
  border-color: var(--accent, #6aa0ff);
}
.dot {
  width: 0.6rem;
  height: 0.6rem;
  border-radius: 50%;
  background: #777;
}
.dot.on {
  background: #4caf50;
}
.claim {
  display: grid;
  gap: 0.5rem;
}
.claim label {
  display: grid;
  gap: 0.25rem;
}
textarea {
  font-family: ui-monospace, monospace;
}
.problems,
.blockers {
  color: var(--danger, #e05a5a);
}
.invite {
  display: flex;
  gap: 0.5rem;
}
.invite input {
  flex: 1;
}
.claims li {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.actions {
  display: flex;
  gap: 0.5rem;
}
.hint {
  opacity: 0.75;
}
</style>
