import type { Dimension, Feature } from './types';

export const WEIGHTS: Readonly<Record<Dimension, number>> = Object.freeze({
  W: 0.25,
  E: 0.2,
  C: 0.15,
  M: 0.12,
  H: 0.1,
  R: 0.1,
  D: 0.05,
  L: 0.03,
});
export const TIE_BAND = 5;
export const SWITCH_MARGIN = 5;
export function score(components: Record<Dimension, Feature>): {
  value: number;
  range: [number, number];
} {
  let value = 0,
    low = 0,
    high = 0;
  for (const key of Object.keys(WEIGHTS) as Dimension[]) {
    const f = components[key];
    // Missing dimensions remain intervals. Midpoint is an explicitly uncertain placeholder,
    // not zero, confidence discount, or renormalization of the remaining weights.
    value += WEIGHTS[key] * (f.value ?? (f.range[0] + f.range[1]) / 2);
    low += WEIGHTS[key] * f.range[0];
    high += WEIGHTS[key] * f.range[1];
  }
  return {
    value: Math.round(value * 10000) / 100,
    range: [Math.round(low * 10000) / 100, Math.round(high * 10000) / 100],
  };
}
