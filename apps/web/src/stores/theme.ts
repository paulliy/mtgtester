/**
 * Day, night, or follow the system (ADR 0052 decision 3). The choice is the player's, kept in
 * `localStorage`; the colours themselves live in `styles/tokens.css`, keyed off `data-theme` on
 * `<html>`. With no choice stored ("system"), the attribute is absent and the CSS follows
 * `prefers-color-scheme`.
 *
 * `applyStoredTheme()` runs from `main.ts` before the app mounts, so a stored choice is on the
 * page before anything paints. It is a plain function rather than inline script in
 * `index.html` because the table page's Content Security Policy runs only bundled scripts.
 */
import { ref } from 'vue';
import { defineStore } from 'pinia';

export type ThemeChoice = 'system' | 'day' | 'night';

export const THEME_STORAGE_KEY = 'decktank.theme';
export const THEME_CHOICES: readonly ThemeChoice[] = ['day', 'night', 'system'];

export function parseThemeChoice(value: unknown): ThemeChoice {
  return value === 'day' || value === 'night' ? value : 'system';
}

/** Storage can be missing or throw (private windows, blocked site data): treat that as "system". */
export function readThemeChoice(storage: Pick<Storage, 'getItem'> | undefined): ThemeChoice {
  try {
    return parseThemeChoice(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function writeThemeChoice(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined,
  choice: ThemeChoice,
): void {
  try {
    if (choice === 'system') storage?.removeItem(THEME_STORAGE_KEY);
    else storage?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // The choice still applies for this page; it just won't survive a reload.
  }
}

export function applyThemeChoice(root: HTMLElement, choice: ThemeChoice): void {
  if (choice === 'system') delete root.dataset['theme'];
  else root.dataset['theme'] = choice;
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function applyStoredTheme(): void {
  if (typeof document === 'undefined') return;
  applyThemeChoice(document.documentElement, readThemeChoice(safeLocalStorage()));
}

export const useThemeStore = defineStore('theme', () => {
  const choice = ref<ThemeChoice>(readThemeChoice(safeLocalStorage()));

  function setChoice(next: ThemeChoice): void {
    choice.value = next;
    writeThemeChoice(safeLocalStorage(), next);
    if (typeof document !== 'undefined') applyThemeChoice(document.documentElement, next);
  }

  return { choice, setChoice };
});
