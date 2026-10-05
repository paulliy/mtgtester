import { ref, watch, type Ref } from 'vue';
import { PLAYER_IDLE_GRACE_MS } from '@mtg/shared';
import { useRouter } from 'vue-router';
import { useGameStore } from '../stores/game';

/**
 * The server's refusal when another browser holds the player seat, in player terms. The same
 * browser resumes its own game automatically, so this always means a different browser, window
 * profile, or cleared storage. The server abandons that game once its player has been away for
 * `PLAYER_IDLE_GRACE_MS`.
 */
const ACTIVE_SESSION_REFUSAL = 'Resume the active player session before replacing it.';

function describeStartError(message: string): string {
  return message === ACTIVE_SESSION_REFUSAL
    ? `Another player game is still in progress on this server, started from a different browser or window. Continue or abandon it there, then try again. If that browser is gone, the game ends on its own ${PLAYER_IDLE_GRACE_MS / 60_000} minutes after it disconnected.`
    : message;
}

/**
 * Start a game from Setup and move to the board only once the server confirms it.
 *
 * Pushing to the board straight away hid a refused start: the board bounced back to a freshly
 * mounted Setup after 1.5s, which dropped the preview and anything typed, and the server's reason
 * was rendered only inside the collapsed advanced setup. Staying here keeps the form and shows
 * the reason beside the button that was pressed.
 */
export function useConfirmedStart(): {
  starting: Ref<boolean>;
  startErrors: Ref<string[]>;
  begin: (send: () => void) => void;
  clearStartErrors: () => void;
} {
  const store = useGameStore();
  const router = useRouter();
  const starting = ref(false);
  const startErrors = ref<string[]>([]);

  function fail(errors: string[]): void {
    starting.value = false;
    startErrors.value = errors.map(describeStartError);
  }

  watch(
    () => store.gameId,
    (id, previous) => {
      if (!starting.value || id === null || id === previous) return;
      starting.value = false;
      void router.push('/game');
    },
  );
  watch(
    () => store.errors,
    (errors) => {
      if (starting.value && errors.length > 0) fail(errors);
    },
  );
  watch(
    () => store.connection,
    (connection) => {
      if (starting.value && connection === 'closed') {
        fail([
          'Lost the connection to the game server before the game started. Check that it is running, then try again.',
        ]);
      }
    },
  );

  return {
    starting,
    startErrors,
    /** `send` issues the store's start call; nothing is sent while a start is already pending. */
    begin(send: () => void): void {
      if (starting.value) return;
      startErrors.value = [];
      starting.value = true;
      send();
    },
    clearStartErrors(): void {
      startErrors.value = [];
    },
  };
}
