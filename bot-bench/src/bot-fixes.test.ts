/**
 * ADR 0043's bot fixes, pinned to the positions each one fixes. bot-bench is the bot's regression
 * suite: each fix alone must solve its positions (on two of the gate's seeds, so a tie cannot
 * pass by luck), the bot without the fixes must not, and the production bot must solve them all.
 */
import { describe, expect, it } from 'vitest';
import { POLICY_FIXES, type PolicyFix } from '../../packages/bot/src';
import { loadCases } from './case';
import { parseLineup } from './models';
import { runLineup, type RunOptions } from './run';

const options: RunOptions = {
  mode: 'raw',
  trials: 1,
  concurrency: 4,
  spendCapUsd: null,
  env: {},
  fetchImpl: (() => Promise.reject(new Error('no network'))) as unknown as typeof fetch,
  sleepImpl: () => Promise.resolve(),
};

const FIXED_BY: Record<PolicyFix, string[]> = {
  ownStack: ['two-bolts-two-kills'],
  neverYield: ['firebreathing-for-exact', 'growth-after-attacks'],
  lethalTargets: [
    'removal-on-the-lethal-attacker',
    'removal-on-the-lethal-attacker-reordered',
    'pump-the-unblocked-attacker',
    'pump-the-unblocked-attacker-reordered',
    'clear-the-blocker-and-pump',
    'bolt-the-unblocked-lions',
  ],
  lethalValue: ['overrun-for-the-kill', 'proportions-for-the-kill'],
  castOrder: ['ramp-with-every-mana', 'rock-before-the-draw'],
  landColors: [
    'land-for-the-angel',
    'land-for-the-angel-reordered',
    'land-for-the-turn',
    'land-for-the-turn-reordered',
    'temple-for-next-turn',
  ],
  attackReserve: ['keep-blockers-home', 'hold-the-ground-at-five', 'two-home-to-live'],
  scarceAnswer: [
    'hold-negate-for-a-threat',
    'hold-the-counter',
    'hold-the-swords-for-a-threat',
    // The hold's own exemptions: lethal burn on the stack, and a counter war over our spell.
    'counter-the-lethal-bolt',
    'win-the-counter-war',
  ],
  faceDamage: ['shock-the-other-threat'],
  costChoices: ['altar-the-bears-not-the-angel'],
  commanderValue: ['altar-the-beast-not-the-commander', 'swords-the-commander'],
};

/**
 * Fixes whose positions also need an earlier fix. `scarceAnswer` keeps the last counterspell, and
 * only `neverYield` stops the bot yielding the turn away with it, which would waste the hold.
 * `faceDamage` keeps Shock off a player, and only `ownStack` sees that the Bolt already on the
 * stack kills the Bears, so the Lions are the target. `commanderValue` keeps Kiki-Jiki off Ashnod's
 * Altar, and only `costChoices` scores the Altar's sacrifice at all.
 */
const BUILDS_ON: Partial<Record<PolicyFix, PolicyFix[]>> = {
  scarceAnswer: ['neverYield'],
  faceDamage: ['ownStack'],
  commanderValue: ['costChoices'],
};

const SEEDS = ['gate-1', 'gate-2'];

async function scores(fixes: PolicyFix[] | undefined, caseIds: string[]) {
  const cases = loadCases().filter((benchCase) => caseIds.includes(benchCase.id));
  expect(cases.map((c) => c.id).sort()).toEqual([...caseIds].sort());
  const results = await runLineup(
    cases,
    parseLineup({
      seeds: SEEDS,
      models: [
        { id: 'bot', kind: 'local', policy: 'heuristic', ...(fixes !== undefined && { fixes }) },
      ],
    }),
    options,
  );
  // The seed is part of the case label, so a failure names the seed that lost.
  return results.flatMap((result) =>
    result.cases.map((entry) => ({
      caseId: `${entry.caseId} @ ${String(result.model['seed'])}`,
      baseCase: entry.caseId,
      score: entry.score.score,
    })),
  );
}

describe('ADR 0043 bot fixes', () => {
  it('names every fix', () => {
    expect(Object.keys(FIXED_BY).sort()).toEqual([...POLICY_FIXES].sort());
  });

  for (const fix of POLICY_FIXES) {
    const base = BUILDS_ON[fix] ?? [];
    const label = base.length === 0 ? 'alone' : `with ${base.join(', ')}`;
    it(`${fix} ${label} solves its positions on every seed`, async () => {
      for (const { caseId, score } of await scores([fix, ...base], FIXED_BY[fix]))
        expect({ caseId, score }).toEqual({ caseId, score: 1 });
    });
  }

  it('a fix that builds on another is still needed: the base alone fails its positions', async () => {
    for (const [fix, base] of Object.entries(BUILDS_ON) as [PolicyFix, PolicyFix[]][]) {
      const own = await scores(base, FIXED_BY[fix]);
      expect({ fix, failed: own.some((entry) => entry.score < 1) }).toEqual({ fix, failed: true });
    }
  });

  it('the card-aware bot before the fixes fails on at least one seed of every fix', async () => {
    const all = await scores([], Object.values(FIXED_BY).flat());
    for (const fix of POLICY_FIXES) {
      const own = all.filter((entry) => FIXED_BY[fix].includes(entry.baseCase));
      expect({ fix, failed: own.some((entry) => entry.score < 1) }).toEqual({ fix, failed: true });
    }
  });

  it('the production bot solves them all', async () => {
    for (const { caseId, score } of await scores(undefined, Object.values(FIXED_BY).flat()))
      expect({ caseId, score }).toEqual({ caseId, score: 1 });
  });
});
