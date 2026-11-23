import { describe, expect, it } from 'vitest';
import {
  THEME_STORAGE_KEY,
  applyThemeChoice,
  parseThemeChoice,
  readThemeChoice,
  writeThemeChoice,
} from './theme';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

describe('theme choice', () => {
  it('accepts day and night and treats anything else as system', () => {
    expect(parseThemeChoice('day')).toBe('day');
    expect(parseThemeChoice('night')).toBe('night');
    expect(parseThemeChoice('dark')).toBe('system');
    expect(parseThemeChoice(null)).toBe('system');
  });

  it('reads the stored choice, and falls back to system when storage is missing or throws', () => {
    expect(readThemeChoice(memoryStorage({ [THEME_STORAGE_KEY]: 'night' }))).toBe('night');
    expect(readThemeChoice(undefined)).toBe('system');
    expect(
      readThemeChoice({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toBe('system');
  });

  it('stores day and night, and clears the key for system', () => {
    const storage = memoryStorage();
    writeThemeChoice(storage, 'day');
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe('day');
    writeThemeChoice(storage, 'system');
    expect(storage.data.has(THEME_STORAGE_KEY)).toBe(false);
  });

  it('does not throw when storage refuses a write', () => {
    const refusing = {
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => writeThemeChoice(refusing, 'night')).not.toThrow();
  });

  it('sets data-theme for day and night and removes it for system', () => {
    const root = { dataset: {} as Record<string, string> } as unknown as HTMLElement;
    applyThemeChoice(root, 'night');
    expect(root.dataset['theme']).toBe('night');
    applyThemeChoice(root, 'system');
    expect(root.dataset['theme']).toBeUndefined();
  });
});
