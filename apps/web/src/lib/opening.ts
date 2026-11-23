/**
 * The New game screen's opening (Decktank `Main.dc.html`): the first visit shows only the compass
 * and "Where to?", with the site header and the setup panel out of the way, until a mode is
 * picked. Picking one remembers that the opening was seen; "Replay opening" forgets it.
 *
 * `openingScreen` is how the setup view tells the app shell to tuck its header away while the
 * opening shows. Storage can be blocked (private windows, previews), so every read and write is
 * guarded and a failed read counts as "seen": the menu is never hidden behind an opening that
 * cannot be dismissed for good.
 */
import { ref } from 'vue';

export const OPENED_KEY = 'decktank.opened';

/** True while the opening plate is on screen; the shell hides its header meanwhile. */
export const openingScreen = ref(false);

export function hasOpened(): boolean {
  try {
    return localStorage.getItem(OPENED_KEY) === 'true';
  } catch {
    return true;
  }
}

export function markOpened(): void {
  try {
    localStorage.setItem(OPENED_KEY, 'true');
  } catch {
    // Storage blocked: the opening shows again next visit, which is harmless.
  }
}

export function clearOpened(): void {
  try {
    localStorage.removeItem(OPENED_KEY);
  } catch {
    // Storage blocked: nothing was remembered.
  }
}
