import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0052 decision 3: text and colour-pip letters clear WCAG AA (4.5:1) in both themes. Reads
 * the real stylesheet, so a colour changed in tokens.css is checked here without a second copy.
 */
const css = readFileSync(fileURLToPath(new URL('./tokens.css', import.meta.url)), 'utf8');

/** The `--name: #hex;` declarations inside the first block that opens with `selector {`. */
function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`tokens.css has no "${selector}" block`);
  const body = css.slice(start, css.indexOf('}', start));
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)) {
    out[match[1]!] = match[2]!.toLowerCase();
  }
  return out;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

const day = block(':root');
const night = block(":root[data-theme='night']");
const systemNight = block(":root:not([data-theme='day'])");

/** [foreground token, background token]: every pairing the viewer draws as text. */
const TEXT_PAIRS: readonly (readonly [string, string])[] = [
  ['--ink', '--paper'],
  ['--ink', '--paper-2'],
  ['--muted', '--paper'],
  ['--muted', '--paper-2'],
  ['--ok', '--paper'],
  ['--warn', '--paper'],
  ['--danger', '--paper'],
  ['--ok', '--paper-2'],
  ['--warn', '--paper-2'],
  ['--danger', '--paper-2'],
  // "Selected" is an inversion: paper text on an ink fill, and on status fills.
  ['--paper', '--ink'],
  ['--paper', '--danger'],
  ['--paper', '--warn'],
  ['--mana-letter', '--mana-w'],
  ['--mana-letter', '--mana-u'],
  ['--mana-letter', '--mana-r'],
  ['--mana-letter', '--mana-g'],
  ['--mana-letter', '--mana-c'],
  ['--mana-b-letter', '--mana-b'],
];

describe('Decktank tokens', () => {
  it.each([
    ['day', day],
    ['night', night],
  ] as const)('%s text pairs clear 4.5:1', (_name, theme) => {
    for (const [fg, bg] of TEXT_PAIRS) {
      expect(theme[fg], `${fg} is defined`).toBeDefined();
      expect(theme[bg], `${bg} is defined`).toBeDefined();
      expect(contrast(theme[fg]!, theme[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('defines every day colour again for night', () => {
    expect(Object.keys(night).sort()).toEqual(Object.keys(day).sort());
  });

  it('gives the system-dark night the same values as the chosen night', () => {
    expect(systemNight).toEqual(night);
  });
});
