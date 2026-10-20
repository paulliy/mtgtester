import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  parseReviewManifest,
  verifyPrimitiveReviewPromotions,
} from '../../../../scripts/contracts/primitive-promotions';
import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { CardDefinition } from '../../../engine/src/cards/definition';
import type { Value } from '../../../engine/src/cards/value';
import { bear, oracle } from '../../../engine/tests/fixtures';
import { interpretCard } from '../../../engine/src/cards/interpret';
import { PRIMITIVE_CONTRACTS } from '../../../../scripts/contracts/primitive-contracts';
import {
  cardPrimitiveEligibility,
  cardPrimitiveEligibilityBatch,
  loadPrimitiveEvidence,
  validateCurrentPrimitiveEvidence,
  validatePrimitiveReport,
  type PrimitiveEvidence,
  primitiveCapabilityLifecycle,
  requireReviewedPrimitiveEligibility,
} from '../../../../scripts/contracts/primitive-evidence';

vi.mock('node:fs', async (original) => ({ ...(await original<typeof import('node:fs')>()) }));
const root = resolve(import.meta.dirname, '../../../..');
let runDirectory: string;
let actualReport: Record<string, unknown>;
let actualImpact: {
  modeled: number;
  primitiveEvidence: { eligible: number; blocked: number; engineProven: string[] };
};
const scratch: string[] = [];
const expectedCapabilities = [
  'Ability.activated',
  'Ability.effects',
  'Ability.modes',
  'Ability.optional',
  'Ability.spell',
  'Ability.targets',
  'Ability.trigger',
  'Ability.triggered',
  'AbilityCost.discardSelf',
  'AbilityCost.mana',
  'AbilityCost.removeCounters',
  'AbilityCost.sacrificeSelf',
  'AbilityCost.tap',
  'ActivatedAbility',
  'ActivatedAbility.ability',
  'ActivatedAbility.costs',
  'ActivatedAbility.timing',
  'ActivatedAbility.zone',
  'AlternativeCast.ability',
  'AlternativeCast.manaCost',
  'AlternativeCast.overload',
  'CardDefinition',
  'CardDefinition.activatedAbilities',
  'CardDefinition.alternativeCasts',
  'CardDefinition.entersWithCounters',
  'CardDefinition.keywords',
  'CardDefinition.manaAbilities',
  'CardDefinition.manaCost',
  'CardDefinition.ruleStatics',
  'CardDefinition.spellAbility',
  'CardDefinition.staticEffects',
  'CardDefinition.triggers',
  'Condition.castSpellThisTurn',
  'Condition.eventObjectDefendingPlayerIsYou',
  'Condition.sourceHasCounters',
  'ContinuousOp.6',
  'ContinuousOp.setMustAttackEachCombat',
  'Effect.attackingCreaturesToOwnerLibraries',
  'Effect.choosePermanentTypesThenSacrificeOthers',
  'Effect.createToken',
  'Effect.createTokenForPlayer',
  'Effect.destroyTargetAndControllerMaySearchBasicTypedLand',
  'Effect.discardTarget',
  'Effect.draw',
  'Effect.drawForEachOpponent',
  'Effect.drawTarget',
  'Effect.druidPurification',
  'Effect.eachOpponentCreatesTokens',
  'Effect.eachPlayerMayPutCountersAndGoad',
  'Effect.exileCreatureAndControllerSearchBasicLand',
  'Effect.exileEachCreatureAndControllersSearchBasicLands',
  'Effect.gainControl',
  'Effect.gainControlTarget',
  'Effect.gainLife',
  'Effect.loseLifeTarget',
  'Effect.moveCounters',
  'Effect.putCountersOnCreaturesTargetPlayerControls',
  'Effect.regainControlOfOwnCreatures',
  'Effect.removeCounters',
  'Effect.revealHandAndDiscard',
  'Effect.rotateSourceAtUpkeep',
  'Effect.sacrificeGreatestEachOpponent',
  'Effect.sacrificeTargetPlayerCreature',
  'Effect.schemingSymmetry',
  'Effect.searchLibrary',
  'Effect.shareCreatureLifeWithChosenOpponent',
  'Effect.shareTokensWithChosenOpponent',
  'Effect.shuffle',
  'Effect.swapCreatureControlUntilEot',
  'Effect.unlessPays',
  'Effect.voteAndExileMost',
  'Keyword.defender',
  'Keyword.double strike',
  'Keyword.flying',
  'Keyword.lifelink',
  'Keyword.menace',
  'Keyword.trample',
  'ManaAbilitySpec',
  'ManaAbilitySpec.costs',
  'ManaAbilitySpec.units',
  'ParsedManaCost',
  'RuleStatic.attackRestriction',
  'RuleStatic.cantAttackOwner',
  'RuleStatic.cantBeSacrificed',
  'RuleStatic.cantBlockMatching',
  'RuleStatic.costReduction',
  'SearchDestination',
  'Selector.allOf',
  'Selector.anyOf',
  'Selector.controller',
  'Selector.hasCounter',
  'Selector.not',
  'Selector.other',
  'Selector.powerAtLeast',
  'Selector.powerAtMost',
  'Selector.self',
  'Selector.subtype',
  'Selector.supertype',
  'Selector.type',
  'StaticEffect',
  'StaticEffect.affects',
  'StaticEffect.op',
  'TargetSpec.creature',
  'TargetSpec.permanent',
  'TargetSpec.player',
  'TokenSpec',
  'TokenSpec.keywords',
  'TokenSpec.manaAbilities',
  'TriggerSpec.attacks',
  'TriggerSpec.beginningOfCombat',
  'TriggerSpec.dealsCombatDamageToPlayer',
  'TriggerSpec.dies',
  'TriggerSpec.endStep',
  'TriggerSpec.enters',
  'TriggerSpec.leavesBattlefield',
  'TriggerSpec.upkeep',
  'TriggerSubject.permanent',
  'TriggerSubject.self',
  'Value.const',
  'Value.countPermanents',
  'Value.damageDealt',
];

function runCommand(command: string, args: string[], options: ExecFileOptionsWithStringEncoding) {
  return new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    error: Error | null;
  }>((done) => {
    execFile(
      command,
      args,
      { ...options, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        done({
          status: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
          stdout,
          stderr,
          error,
        });
      },
    );
  });
}

beforeAll(async () => {
  runDirectory = mkdtempSync(resolve(tmpdir(), 'mtg-primitive-actual-run-'));
  scratch.push(runDirectory);
  const run = await runCommand(
    'bun',
    ['run', 'test:primitive-contracts', '--output', runDirectory],
    {
      cwd: root,
      encoding: 'utf8',
      // The registry now executes over 950 tests, including paid multiplayer compositions.
      timeout: 120_000,
    },
  );
  if (run.status !== 0)
    throw new Error(`Actual primitive execution failed: ${run.stdout}\n${run.stderr}`);
  actualReport = JSON.parse(readFileSync(resolve(runDirectory, 'report.json'), 'utf8'));
  const impact = await runCommand(
    'bun',
    ['run', 'card-capabilities', '--primitive-evidence', runDirectory],
    { cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024 },
  );
  if (impact.status !== 0)
    throw new Error(
      `Actual eligibility inventory failed: ${impact.error?.message ?? impact.status}\n${impact.stderr}`,
    );
  actualImpact = JSON.parse(impact.stdout);
}, 155_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await yieldToEventLoop();
});

function copyReceipt(): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'mtg-primitive-receipt-'));
  scratch.push(directory);
  for (const file of ['manifest.json', 'report.json'])
    writeFileSync(resolve(directory, file), readFileSync(resolve(runDirectory, file)));
  return directory;
}
function definition(count: number | Value = 1): CardDefinition {
  return {
    ...interpretCard(bear()),
    spellAbility: {
      kind: 'spell',
      targets: [{ kind: 'permanent' }],
      effects: [{ op: 'removeCounters', target: 0, counter: 'charge', count }],
    },
  };
}

describe('primitive evidence and eligibility', { timeout: 30_000 }, () => {
  it('loads evidence from actual independent execution and freezes generated facts', () => {
    const evidence = loadPrimitiveEvidence(root, runDirectory);
    expect(evidence.capabilities).toEqual(expectedCapabilities);
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.capabilities)).toBe(true);
    validateCurrentPrimitiveEvidence(evidence);
  });

  it('keeps uncontracted dependencies experimental despite a passing primitive', () => {
    const probe = definition();
    probe.spellAbility!.effects.push({ op: 'mill', count: { kind: 'const', n: 1 } });
    const result = cardPrimitiveEligibility(probe, loadPrimitiveEvidence(root, runDirectory));
    expect(result.eligible).toBe(false);
    expect(result.dependencies).toContain('Effect.removeCounters');
    expect(result.blocked.some((entry) => entry.capability === 'Effect.removeCounters')).toBe(
      false,
    );
    expect(result.blocked.some((entry) => entry.reason.includes('experimental'))).toBe(true);
  });

  it('binds actual capability CLI eligibility to current primitive evidence', () => {
    expect(actualImpact.primitiveEvidence.engineProven).toEqual(expectedCapabilities);
    expect(actualImpact.primitiveEvidence.blocked + actualImpact.primitiveEvidence.eligible).toBe(
      actualImpact.modeled,
    );
    expect(actualImpact.modeled).toBeGreaterThan(600);
  });

  it('validates batch eligibility with the same fail-closed result', () => {
    const evidence = loadPrimitiveEvidence(root, runDirectory);
    const def = definition();
    expect(cardPrimitiveEligibilityBatch([def], evidence)).toEqual([
      cardPrimitiveEligibility(def, evidence),
    ]);
    expect(() => cardPrimitiveEligibilityBatch([def], {} as PrimitiveEvidence)).toThrow(
      'loader-validated',
    );
  });

  it('blocks dynamic amounts outside the proven scope', () => {
    const result = cardPrimitiveEligibility(
      definition({ kind: 'countOpponents' }),
      loadPrimitiveEvidence(root, runDirectory),
    );
    expect(result.blocked).toContainEqual({
      capability: 'Effect.removeCounters',
      reason: 'outside proven contract scope',
    });
  });

  it('generates eligibility for the complete bounded life-spell composition', () => {
    const def = interpretCard({
      ...bear(),
      types: ['Sorcery'],
      typeLine: 'Sorcery',
      manaCost: '{0}',
      power: null,
      toughness: null,
      oracleText: 'You gain 3 life.',
    });
    const evidence = loadPrimitiveEvidence(root, runDirectory);
    const result = cardPrimitiveEligibility(def, evidence);
    expect(result.eligible).toBe(true);
    expect(result.blocked).toEqual([]);
    expect(result.dependencies).toEqual([
      'Ability.effects',
      'Ability.spell',
      'CardDefinition',
      'CardDefinition.manaCost',
      'CardDefinition.spellAbility',
      'Effect.gainLife',
      'ParsedManaCost',
      'Value.const',
    ]);
  });

  it.each([
    'dynamic',
    'targeted',
    'hybrid',
    'additionalCost',
    'keyword',
    'amountOutsideScope',
    'manaOutsideScope',
    'contradictoryModeling',
  ] as const)('does not promote a life spell outside the composition scope: %s', (variant) => {
    const base = interpretCard({
      ...bear(),
      types: ['Sorcery'],
      typeLine: 'Sorcery',
      manaCost: '{0}',
      power: null,
      toughness: null,
      oracleText: 'You gain 3 life.',
    });
    const def = structuredClone(base);
    if (variant === 'dynamic')
      def.spellAbility!.effects = [{ op: 'gainLife', amount: { kind: 'countOpponents' } }];
    if (variant === 'targeted') def.spellAbility!.targets = [{ kind: 'player' }];
    if (variant === 'hybrid') def.manaCost!.hybrid = [['W', 'G']];
    if (variant === 'additionalCost') def.spellAdditionalCosts = [{ kind: 'payLife', amount: 1 }];
    if (variant === 'keyword') def.keywords = ['rebound'];
    if (variant === 'amountOutsideScope')
      def.spellAbility!.effects = [{ op: 'gainLife', amount: { kind: 'const', n: 1001 } }];
    if (variant === 'manaOutsideScope') def.manaCost!.colored.G = 2;
    if (variant === 'contradictoryModeling') def.unmodeledReasons = ['unresolved Oracle clause'];
    expect(cardPrimitiveEligibility(def, loadPrimitiveEvidence(root, runDirectory)).eligible).toBe(
      false,
    );
  });

  it('generates lifecycle from executable registrations and privately validated receipts', () => {
    const keys = ['Value.const', 'Effect.invented', 'Value.const'];
    expect(primitiveCapabilityLifecycle(keys)['Effect.invented']).toEqual({
      status: 'experimental',
    });
    expect(primitiveCapabilityLifecycle(keys)['Value.const']!.status).toBe('implemented');
    const evidence = loadPrimitiveEvidence(root, runDirectory);
    const facts = primitiveCapabilityLifecycle(keys, evidence);
    expect(facts['Value.const']).toMatchObject({
      status: 'engine-proven',
      testedTree: evidence.testedTree,
      reportSha256: evidence.reportSha256,
    });
    expect(facts['Effect.invented']).toEqual({ status: 'experimental' });
    expect(() => primitiveCapabilityLifecycle(keys, {} as PrimitiveEvidence)).toThrow(
      'loader-validated',
    );
  });

  it.each([
    'proven',
    'experimental',
    'outsideScope',
    'missing',
    'duplicateReview',
    'duplicateConsumer',
  ] as const)('enforces primitive review prerequisites: %s', (variant) => {
    const card = oracle({
      name: 'Primitive review probe',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: 'You gain 3 life.',
    });
    const definition = interpretCard(card);
    if (variant === 'experimental')
      definition.spellAbility!.effects = [{ op: 'mill', count: { kind: 'const', n: 1 } }];
    if (variant === 'outsideScope')
      definition.spellAbility!.effects = [{ op: 'gainLife', amount: { kind: 'const', n: 1001 } }];
    const consumer = { canonicalOracleId: card.oracleId, definition };
    const action = () =>
      requireReviewedPrimitiveEligibility(
        variant === 'duplicateConsumer' ? [consumer, consumer] : [consumer],
        variant === 'duplicateReview'
          ? [card.oracleId, card.oracleId]
          : [variant === 'missing' ? 'missing-card' : card.oracleId],
        loadPrimitiveEvidence(root, runDirectory),
      );
    if (variant === 'proven') expect(action).not.toThrow();
    else expect(action).toThrow();
  });

  it.each(['proven', 'experimental', 'oracleDrift', 'missingEvidence'] as const)(
    'runs the actual capability CLI at the review boundary: %s',
    async (variant) => {
      const directory = mkdtempSync(resolve(tmpdir(), 'mtg-review-cli-'));
      scratch.push(directory);
      const card = {
        ...oracle({
          name: 'Primitive review CLI probe',
          typeLine: 'Sorcery',
          manaCost: '{0}',
          oracleText: variant === 'experimental' ? 'Mill a card.' : 'You gain 3 life.',
        }),
        oracleId: 'ceca9ae4-c9ba-4018-b5f2-1288fe8792af',
      };
      const fixturePath = resolve(directory, 'oracle.json');
      const reviewPath = resolve(directory, 'review.json');
      writeFileSync(fixturePath, JSON.stringify([card]));
      const oracleSha256 = createHash('sha256').update(JSON.stringify(card)).digest('hex');
      writeFileSync(
        reviewPath,
        JSON.stringify({
          schemaVersion: 1,
          cards: {
            [card.oracleId]: {
              name: card.name,
              implementationStatus: 'implemented-reviewed',
              oracleSha256: variant === 'oracleDrift' ? '0'.repeat(64) : oracleSha256,
            },
          },
        }),
      );
      const run = await runCommand(
        'bun',
        [
          'run',
          'card-capabilities',
          '--oracle-fixture',
          fixturePath,
          '--review-manifest',
          reviewPath,
          ...(variant === 'missingEvidence' ? [] : ['--primitive-evidence', runDirectory]),
        ],
        { cwd: root, encoding: 'utf8', timeout: 60_000 },
      );
      if (variant === 'proven') {
        expect(run.status, run.stderr).toBe(0);
        const result = JSON.parse(run.stdout);
        expect(result.primitiveReviewPrerequisites.requiredOracleIds).toEqual([card.oracleId]);
        expect(result.primitiveEvidence.eligible).toBe(1);
        expect(result.primitiveLifecycle['Value.const'].status).toBe('engine-proven');
      } else {
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain(
          variant === 'experimental'
            ? 'reviewed primitives are not proven'
            : variant === 'oracleDrift'
              ? 'current pinned Oracle'
              : 'current primitive evidence',
        );
      }
    },
    65_000,
  );

  it('executes the actual CI promotion entrypoint against its committed baseline', async () => {
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const run = await runCommand(
      'bun',
      ['run', 'primitive-promotions', '--base', base, '--primitive-evidence', runDirectory],
      { cwd: root, encoding: 'utf8', timeout: 60_000 },
    );
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.promotions).toEqual([]);
    expect(result.testedTree).toBe(loadPrimitiveEvidence(root, runDirectory).testedTree);
    expect(result.scope).toContain('historical declarations are not current evidence');
  }, 65_000);

  it('rejects an exact canonical reviewed pin whose primitives are experimental', () => {
    const manifest = parseReviewManifest(
      readFileSync(
        resolve(root, 'packages/server/fixtures/card-verification-manifest.json'),
        'utf8',
      ),
    );
    const evidence = loadPrimitiveEvidence(root, runDirectory);
    expect(() =>
      verifyPrimitiveReviewPromotions(
        root,
        manifest,
        ['0c85b8f7-0bd0-4680-9ec5-d4b110460a54'],
        evidence,
      ),
    ).toThrow('reviewed primitives are not proven');
  }, 30_000);

  it('rejects promotion input routed to a different repository', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'mtg-other-review-root-'));
    scratch.push(directory);
    expect(() =>
      verifyPrimitiveReviewPromotions(
        directory,
        { schemaVersion: 1, cards: {} },
        [],
        loadPrimitiveEvidence(root, runDirectory),
      ),
    ).toThrow('validated repository changed');
  });

  it('requires a privately loader-validated context', () => {
    expect(() => cardPrimitiveEligibility(definition(), {} as PrimitiveEvidence)).toThrow(
      'loader-validated',
    );
  });

  it.each([
    ['state', 'skipped'],
    ['state', 'failed'],
    ['completions', 0],
    ['completions', 2],
    ['retryCount', 1],
    ['repeatCount', 1],
    ['flaky', true],
    ['retryCount', null],
  ])('rejects report execution diagnostic %s=%s', (field, value) => {
    // Mutated copies test the parser boundary; they never provide passing execution evidence.
    const report = structuredClone(actualReport);
    const cases = report['cases'] as Record<string, unknown>[];
    cases[0]![field as string] = value;
    expect(() => validatePrimitiveReport(report)).toThrow('case failed');
  });

  it('rejects an omitted required negative case', () => {
    const report = structuredClone(actualReport);
    report['cases'] = (report['cases'] as Record<string, unknown>[]).filter(
      (test) =>
        !(test['titlePath'] as string[]).includes(
          'does not remove counters from an illegal target',
        ),
    );
    expect(() => validatePrimitiveReport(report)).toThrow('missing case');
  });

  it('rejects duplicated cases and missing modules', () => {
    const report = structuredClone(actualReport);
    const cases = report['cases'] as Record<string, unknown>[];
    cases.push(cases[0]!);
    expect(() => validatePrimitiveReport(report)).toThrow('duplicate case');
    report['cases'] = actualReport['cases'];
    report['modules'] = [];
    expect(() => validatePrimitiveReport(report)).toThrow('module set');
  });

  it.each(['testedTree', 'framework', 'executionRuntime'])('rejects stale capture %s', (field) => {
    const directory = copyReceipt();
    const path = resolve(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.capture[field] = 'stale';
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => loadPrimitiveEvidence(root, directory)).toThrow('stale or incomplete');
  });

  it('rejects an incomplete source union', () => {
    const directory = copyReceipt();
    const path = resolve(directory, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest.capture.files['packages/engine/src/cards/capabilities.ts'];
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => loadPrimitiveEvidence(root, directory)).toThrow('stale or incomplete');
  });

  it('rejects report bytes changed before and after load', () => {
    const directory = copyReceipt();
    const evidence = loadPrimitiveEvidence(root, directory);
    const path = resolve(directory, 'report.json');
    writeFileSync(path, readFileSync(path, 'utf8') + ' ');
    expect(() => validateCurrentPrimitiveEvidence(evidence)).toThrow('receipt bytes changed');
    expect(() => loadPrimitiveEvidence(root, directory)).toThrow('report bytes changed');
  });

  it('rejects source-byte drift even when primitive tags are unchanged', () => {
    const evidence = loadPrimitiveEvidence(root, runDirectory);
    const original = fs.readFileSync;
    const changed = resolve(root, 'packages/engine/src/effects/resolve.ts');
    vi.spyOn(fs, 'readFileSync').mockImplementation(((path: unknown, ...args: unknown[]) => {
      const bytes = Reflect.apply(original, fs, [path, ...args]);
      return path === changed && Buffer.isBuffer(bytes)
        ? Buffer.concat([bytes, Buffer.from('\n// semantic drift simulation')])
        : bytes;
    }) as typeof fs.readFileSync);
    expect(() => validateCurrentPrimitiveEvidence(evidence)).toThrow('sources changed');
  });

  it('rejects duplicate JSON keys and extra manifest claims', () => {
    const directory = copyReceipt();
    const path = resolve(directory, 'manifest.json');
    const bytes = readFileSync(path, 'utf8');
    writeFileSync(path, bytes.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
    expect(() => loadPrimitiveEvidence(root, directory)).toThrow();
    const manifest = JSON.parse(bytes);
    manifest.lifecycle = 'engine-proven';
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => loadPrimitiveEvidence(root, directory)).toThrow('fields');
  });

  it('keeps the registry immutable and requires real permanent-slot scope', () => {
    const contract = PRIMITIVE_CONTRACTS.find(
      (entry) => entry.capability === 'Effect.removeCounters',
    )!;
    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.cases)).toBe(true);
    const def = definition();
    def.spellAbility!.targets = [{ kind: 'player' }];
    expect(contract.supports(def)).toBe(false);
  });
});

afterAll(() => {
  for (const path of scratch) rmSync(path, { recursive: true, force: true });
});
