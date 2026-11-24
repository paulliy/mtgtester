import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useGameStore } from '../stores/game';

/**
 * How long the game may go quiet at the present, beyond the chosen pace between plays, before
 * the board says the bots are thinking.
 */
export const THINKING_AFTER_MS = 800;

/**
 * True while a running game, viewed at the present and playing on its own, has sent nothing for a
 * while: a bot is working out a slow step. On a phone a local game's bot can take a second or
 * more (ADR 0053), and a board that just stops looks broken. Manual playback and a view of the
 * past are excluded, since the board is still there on purpose.
 */
export function useBotsThinking() {
  const store = useGameStore();
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  onMounted(() => {
    timer = setInterval(() => {
      now.value = Date.now();
    }, 250);
  });
  onBeforeUnmount(() => {
    if (timer !== null) clearInterval(timer);
  });
  return computed(
    () =>
      store.isRunning &&
      store.atFrontier &&
      store.playbackMode !== 'manual' &&
      store.playerAction === null &&
      store.lastFrameAt > 0 &&
      now.value - store.lastFrameAt >= store.paceMs + THINKING_AFTER_MS,
  );
}
