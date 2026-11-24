<script setup lang="ts">
import { ref } from 'vue';
import type { GameReport } from '@mtg/shared';
import { requestGameReport } from '../lib/api';
import { formatGameReport } from '../lib/gameReport';
import { useGameStore } from '../stores/game';

/**
 * "Copy game report": fetches the server-built report for this player's session and copies it
 * as text. The server builds it (it alone has the build id and exact decklists) and applies the
 * hidden-information rule; this only formats and copies. When the clipboard is refused, the text
 * is shown in a box to copy by hand rather than lost.
 */
const store = useGameStore();
const state = ref<'idle' | 'working' | 'copied' | 'failed'>('idle');
const message = ref('');
const fallbackText = ref<string | null>(null);
let resetTimer: ReturnType<typeof setTimeout> | null = null;

function settle(next: 'copied' | 'failed', text: string): void {
  state.value = next;
  message.value = text;
  if (resetTimer !== null) clearTimeout(resetTimer);
  resetTimer = setTimeout(() => {
    state.value = 'idle';
    message.value = '';
  }, 4000);
}

async function copyReport(): Promise<void> {
  const token = store.sessionToken;
  if (token === null) {
    settle('failed', 'No player session to report on.');
    return;
  }
  state.value = 'working';
  let text: string;
  try {
    const response = await requestGameReport({ sessionToken: token });
    const body = response.body as GameReport | { message?: string };
    if (!response.ok) {
      throw new Error(('message' in body && body.message) || 'The server refused the report.');
    }
    text = formatGameReport(body as GameReport);
  } catch (reason) {
    settle('failed', reason instanceof Error ? reason.message : String(reason));
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    settle('copied', 'Game report copied.');
  } catch {
    fallbackText.value = text;
    state.value = 'idle';
  }
}
</script>

<template>
  <span class="copy-report">
    <button
      type="button"
      :disabled="state === 'working'"
      aria-label="Copy game report"
      title="Copy build, seed, decks, position, pending choice and recent log for a bug report"
      @click="copyReport"
    >
      {{ state === 'working' ? 'Copying…' : state === 'copied' ? 'Copied' : 'Copy report' }}
    </button>
    <!-- Success is the button's own "Copied"; only a failure needs words, the header is full. -->
    <span v-if="state === 'failed'" class="copy-status failed" role="alert">{{ message }}</span>
    <span v-else-if="state === 'copied'" class="visually-hidden" role="status">{{ message }}</span>
    <div v-if="fallbackText !== null" class="scrim" @click.self="fallbackText = null">
      <div class="fallback" role="dialog" aria-modal="true" aria-labelledby="copy-report-title">
        <h2 id="copy-report-title">Copy game report</h2>
        <p>The browser blocked clipboard access. Select the text below and copy it.</p>
        <textarea
          readonly
          :value="fallbackText"
          aria-label="Game report text"
          @focus="($event.target as HTMLTextAreaElement).select()"
        />
        <button type="button" @click="fallbackText = null">Close</button>
      </div>
    </div>
  </span>
</template>

<style scoped>
.copy-report {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.copy-report > button {
  white-space: nowrap;
  font-size: 0.68rem;
  padding: 0.1rem 0.45rem;
}
.copy-status {
  font-size: 0.72rem;
}
.copy-status.failed {
  color: var(--danger);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.scrim {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: 1rem;
  background: rgb(0 0 0 / 0.45);
}
.fallback {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  width: min(720px, 100%);
  max-height: 90vh;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
}
.fallback h2 {
  margin: 0;
  font-size: 1rem;
}
.fallback p {
  margin: 0;
  font-size: 0.8rem;
  color: var(--muted);
}
.fallback textarea {
  min-height: 50vh;
  font-family: ui-monospace, monospace;
  font-size: 0.72rem;
}
.fallback button {
  align-self: flex-end;
}
</style>
