<script setup lang="ts">
/**
 * Create a table (plan M6 task 4; Decktank redesign phase 8). The host secret goes in the request
 * header only; the host token that comes back is kept for this table, and the browser moves to
 * the table's page with the invite in the address fragment, which no request ever carries.
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { useTableStore } from '../stores/table';

const router = useRouter();
const table = useTableStore();
const secret = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

const STEPS = [
  { num: 'I.', title: 'Create', text: 'Open a table with the host secret.' },
  { num: 'II.', title: 'Invite', text: 'Send friends the invite link. It carries its own code.' },
  {
    num: 'III.',
    title: 'Seat',
    text: 'Each player pastes a decklist and asks for a seat. You approve, deny, or fill a seat with a bot.',
  },
  {
    num: 'IV.',
    title: 'Play',
    text: 'Start when every seat is filled. After the game, step through the replay.',
  },
] as const;

async function create(): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    const response = await fetch('/tables', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret.value.trim()}` },
    });
    const body = (await response.json()) as {
      tableId?: string;
      hostToken?: string;
      inviteUrl?: string;
      error?: string;
    };
    if (!response.ok || body.tableId === undefined || body.hostToken === undefined) {
      error.value = body.error ?? 'The table could not be created.';
      return;
    }
    // Kept in this tab even when storage is blocked, so the table's page can still claim host.
    table.storeHostToken(body.tableId, body.hostToken);
    const invite = body.inviteUrl?.split('#')[1] ?? '';
    secret.value = '';
    await router.push({ name: 'table', params: { id: body.tableId }, hash: `#${invite}` });
  } catch {
    error.value = 'The server could not be reached.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="table-home">
    <div class="lead dt-rise">
      <p class="dt-kicker">Commander, four seats, one table</p>
      <h1 class="dt-title">Host a table</h1>
      <div class="dt-ornament" aria-hidden="true"><span class="star" /></div>
      <p class="intro">
        Paste the host secret that <code>serve:table</code> printed when it started, or the one set
        in <code>TABLE_HOST_SECRET</code>. Friends join with the invite link you get next.
      </p>

      <form class="create dt-plate" @submit.prevent="create">
        <label class="dt-field">
          <span>Host secret</span>
          <input
            v-model="secret"
            type="password"
            autocomplete="off"
            spellcheck="false"
            data-testid="host-secret"
          />
        </label>
        <button
          type="submit"
          class="dt-btn-primary"
          :disabled="busy || secret.trim() === ''"
          data-testid="create-table"
        >
          {{ busy ? 'Creating…' : 'Create table' }}<span class="dt-arr" aria-hidden="true" />
        </button>
      </form>
      <p v-if="error" class="dt-note danger" role="alert">{{ error }}</p>
      <p class="hint">Joining a table? Open the invite link your host sent you.</p>
    </div>

    <ol class="steps" aria-label="How a table works">
      <li
        v-for="(step, i) in STEPS"
        :key="step.num"
        class="step dt-rise"
        :style="{ animationDelay: `${0.12 + i * 0.08}s` }"
      >
        <span class="num" aria-hidden="true">{{ step.num }}</span>
        <span class="body">
          <strong>{{ step.title }}</strong>
          <span>{{ step.text }}</span>
        </span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.table-home {
  max-width: 68rem;
  margin: 0 auto;
  padding: 3rem 2rem 4rem;
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(16rem, 0.9fr);
  gap: 3rem;
  align-items: start;
}
.lead {
  display: grid;
  gap: 1.1rem;
}
.lead .dt-kicker {
  margin: 0;
}
.intro {
  margin: 0;
  max-width: 34rem;
  font-family: var(--font-body);
  font-size: 0.95rem;
  line-height: 1.55;
}
.create {
  display: flex;
  align-items: flex-end;
  gap: 1rem;
  padding: 1.1rem 1.25rem 1.25rem;
}
.create .dt-field {
  flex: 1;
}
.hint {
  margin: 0;
  font-size: 0.85rem;
  color: var(--muted);
}
.steps {
  list-style: none;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--ink);
}
.step {
  display: grid;
  grid-template-columns: 3rem minmax(0, 1fr);
  gap: 0.8rem;
  padding: 1rem 0;
  border-bottom: 1px solid var(--rule);
}
.step .num {
  font-family: var(--font-display);
  font-size: 1.6rem;
  line-height: 1;
}
.step .body {
  display: grid;
  gap: 0.25rem;
}
.step strong {
  font-family: var(--font-ui);
  font-weight: 500;
  font-size: 0.75rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.step .body > span {
  font-family: var(--font-body);
  font-size: 0.85rem;
  line-height: 1.45;
  color: var(--muted);
}
@media (max-width: 860px) {
  .table-home {
    grid-template-columns: 1fr;
    padding: 2rem 1rem 3rem;
    gap: 2rem;
  }
  .create {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
