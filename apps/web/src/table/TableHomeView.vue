<script setup lang="ts">
/**
 * Create a table (plan M6 task 4). The host secret printed by `serve:table` goes in the request
 * header only; the host token that comes back is kept for this table, and the browser moves to
 * the table's page with the invite in the address fragment, which no request ever carries.
 */
import { ref } from 'vue';
import { useRouter } from 'vue-router';

const router = useRouter();
const secret = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

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
    try {
      localStorage.setItem(`mtg-table-host:${body.tableId}`, body.hostToken);
    } catch {
      // Storage blocked: the host role lasts as long as this tab.
    }
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
    <h1>Host a table</h1>
    <p>
      Paste the host secret that <code>serve:table</code> printed when it started. Friends join with
      the invite link you get next.
    </p>
    <form @submit.prevent="create">
      <label>
        Host secret
        <input
          v-model="secret"
          type="password"
          autocomplete="off"
          spellcheck="false"
          data-testid="host-secret"
        />
      </label>
      <button type="submit" :disabled="busy || secret.trim() === ''" data-testid="create-table">
        Create table
      </button>
    </form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p class="hint">Joining a table? Open the invite link your host sent you.</p>
  </section>
</template>

<style scoped>
.table-home {
  max-width: 36rem;
  margin: 3rem auto;
  display: grid;
  gap: 1rem;
}
form {
  display: flex;
  gap: 0.5rem;
  align-items: end;
}
label {
  display: grid;
  gap: 0.25rem;
  flex: 1;
}
.error {
  color: var(--danger, #e05a5a);
}
.hint {
  opacity: 0.75;
}
</style>
