import type {
  BatchFailure,
  BatchListItem,
  BatchResults,
  BatchScenarioSpec,
  BatchSpec,
} from '@mtg/shared';
import { MAX_BATCH_NAME_LENGTH } from '@mtg/shared';
import type { OracleIndex } from '../cards/oracle-index';
import type { SupportedPool } from '../cards/pool';
import type { BannedList } from '../decks/banned';
import type { GameStore } from '../db';
import { testerPolicy } from '../match/disclosure';
import { MatchSession } from '../match/session';
import { setupSeats } from '../match/setup';

export const MAX_BATCH_SCENARIOS = 20;
export const MAX_BATCH_GAMES = 100;

export interface BatchManagerDeps {
  pool: SupportedPool;
  index: OracleIndex;
  banned: BannedList;
  store: GameStore;
}
export type BatchValidation = { ok: true; spec: BatchSpec } | { ok: false; message: string };

function validSeatSource(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  if (item['kind'] === 'pool')
    return item['seed'] === undefined || typeof item['seed'] === 'string';
  if (item['kind'] === 'url')
    return (
      typeof item['url'] === 'string' &&
      (item['archetypeTag'] === undefined || typeof item['archetypeTag'] === 'string')
    );
  if (item['kind'] === 'plaintext')
    return (
      typeof item['text'] === 'string' &&
      (item['name'] === undefined || typeof item['name'] === 'string') &&
      (item['archetypeTag'] === undefined || typeof item['archetypeTag'] === 'string')
    );
  return false;
}
function validScenario(value: unknown): value is BatchScenarioSpec {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item['id'] === 'string' &&
    item['id'].trim().length > 0 &&
    typeof item['name'] === 'string' &&
    item['name'].trim().length > 0 &&
    Array.isArray(item['seats']) &&
    item['seats'].length === 4 &&
    item['seats'].every(validSeatSource) &&
    (item['providerKind'] === 'random' || item['providerKind'] === 'ai') &&
    Number.isInteger(item['games']) &&
    Number(item['games']) >= 1 &&
    Number(item['games']) <= MAX_BATCH_GAMES &&
    (item['reflectionEnabled'] === undefined || typeof item['reflectionEnabled'] === 'boolean')
  );
}

export function validateBatch(value: unknown): BatchValidation {
  if (typeof value !== 'object' || value === null)
    return { ok: false, message: 'Batch body must be an object.' };
  const body = value as Record<string, unknown>;
  if (
    !Array.isArray(body['scenarios']) ||
    body['scenarios'].length < 1 ||
    body['scenarios'].length > MAX_BATCH_SCENARIOS
  )
    return { ok: false, message: `Batch must contain 1-${MAX_BATCH_SCENARIOS} scenarios.` };
  if (
    body['seed'] !== undefined &&
    (typeof body['seed'] !== 'string' || body['seed'].trim().length === 0)
  )
    return { ok: false, message: 'seed must be a non-empty string when supplied.' };
  let name: string | undefined;
  if (body['name'] !== undefined && body['name'] !== null) {
    if (typeof body['name'] !== 'string')
      return { ok: false, message: 'name must be a string when supplied.' };
    const trimmed = body['name'].trim();
    if (trimmed.length > MAX_BATCH_NAME_LENGTH)
      return {
        ok: false,
        message: `name cannot be longer than ${MAX_BATCH_NAME_LENGTH} characters.`,
      };
    if (trimmed.length > 0) name = trimmed;
  }
  const scenarios = body['scenarios'];
  if (!scenarios.every(validScenario))
    return {
      ok: false,
      message:
        'Each scenario needs an id, name, exactly four seats, providerKind, and a positive games count.',
    };
  const ids = new Set(scenarios.map((item) => (item as BatchScenarioSpec).id));
  if (ids.size !== scenarios.length) return { ok: false, message: 'Scenario ids must be unique.' };
  const total = scenarios.reduce((sum, item) => sum + Number((item as BatchScenarioSpec).games), 0);
  if (total > MAX_BATCH_GAMES)
    return { ok: false, message: `Batch cannot contain more than ${MAX_BATCH_GAMES} games.` };
  const normalizedScenarios = scenarios as BatchScenarioSpec[];
  return {
    ok: true,
    spec: {
      ...(name === undefined ? {} : { name }),
      ...(typeof body['seed'] === 'string' ? { seed: body['seed'] } : {}),
      scenarios: normalizedScenarios,
    },
  };
}

export function deriveBatchGameSeed(
  batchSeed: string,
  scenarioIndex: number,
  gameIndex: number,
): string {
  return `${batchSeed}:s${scenarioIndex + 1}:g${gameIndex + 1}`;
}

export class BatchManager {
  private running: Promise<void> | null = null;
  private currentSession: MatchSession | null = null;
  private cancelled = false;
  constructor(private readonly deps: BatchManagerDeps) {}

  /** Await completion, including durable failure cleanup. */
  async settled(): Promise<void> {
    await this.running;
  }

  isActive(): boolean {
    return this.running !== null;
  }
  start(spec: BatchSpec): string {
    if (this.running !== null || this.deps.store.batches().activeBatchExists())
      throw new Error('A batch is already running.');
    const batchId = `b-${crypto.randomUUID()}`;
    const seed = spec.seed?.trim() || crypto.randomUUID().slice(0, 12);
    const normalized: BatchSpec =
      spec.seed === undefined ? { scenarios: spec.scenarios, seed } : { ...spec, seed };
    this.deps.store.batches().create(batchId, seed, normalized.scenarios, spec.name ?? null);
    this.cancelled = false;
    this.running = this.run(batchId, normalized).finally(() => {
      this.running = null;
      this.currentSession = null;
    });
    return batchId;
  }

  cancel(batchId: string): boolean {
    const row = this.deps.store.batches().get(batchId);
    if (row === null || (row.status !== 'queued' && row.status !== 'running')) return false;
    this.cancelled = true;
    this.currentSession?.abandon();
    if (this.currentSession === null) this.deps.store.batches().markFinished(batchId, 'cancelled');
    return true;
  }

  list(limit?: number): BatchListItem[] {
    return this.deps.store.batches().list(limit);
  }
  progress(batchId: string) {
    return this.deps.store.batches().progress(batchId);
  }
  results(batchId: string): BatchResults | null {
    return this.deps.store.batches().results(batchId);
  }

  private async run(batchId: string, spec: BatchSpec): Promise<void> {
    const repo = this.deps.store.batches();
    let scenarioId = spec.scenarios[0]?.id ?? '';
    try {
      repo.markRunning(batchId);
      for (const [scenarioIndex, scenario] of spec.scenarios.entries()) {
        scenarioId = scenario.id;
        if (this.cancelled) {
          repo.markFinished(batchId, 'cancelled');
          return;
        }
        const setup = await setupSeats(
          scenario.seats,
          this.deps,
          `${spec.seed}:scenario:${scenarioIndex + 1}`,
        );
        if (!setup.ok) {
          const failure: BatchFailure = {
            scenarioId: scenario.id,
            gameIndex: null,
            reason: setup.problems
              .map((problem) => `${problem.seat}: ${problem.message}`)
              .join('\n'),
            kind: 'setup',
          };
          repo.markFinished(batchId, 'failed', failure);
          return;
        }
        for (let gameIndex = 0; gameIndex < scenario.games; gameIndex++) {
          if (this.cancelled) {
            repo.markFinished(batchId, 'cancelled');
            return;
          }
          const seed = deriveBatchGameSeed(spec.seed ?? '', scenarioIndex, gameIndex);
          const gameId = `${batchId}-${scenario.id}-${gameIndex + 1}`;
          repo.createGame(batchId, scenario.id, gameIndex, gameId, seed);
          try {
            const session = new MatchSession({
              gameId,
              seed,
              seats: setup.seats,
              providerKind: scenario.providerKind,
              disclosure: testerPolicy('spectator'),
              store: this.deps.store,
              // Optional chaining: test seams build a manager without a pool.
              ...(this.deps.pool?.provisional !== undefined && {
                provisional: this.deps.pool.provisional,
              }),
              playbackMode: 'live',
              livePaceMs: 0,
              ...(scenario.reflectionEnabled !== undefined
                ? { reflectionEnabled: scenario.reflectionEnabled }
                : {}),
              send: () => undefined,
            });
            this.currentSession = session;
            session.start();
            await session.settled();
            const status = session.runner.getStatus();
            if (status === 'finished') {
              repo.markGame(gameId, 'finished');
            } else if (status === 'abandoned' && this.cancelled) {
              repo.markGame(gameId, 'abandoned', 'Batch cancelled.');
              repo.markFinished(batchId, 'cancelled');
              return;
            } else {
              const reason =
                session.runner.getHalt()?.reason ?? `Game ended with status ${status}.`;
              repo.markGame(gameId, status === 'halted' ? 'halted' : 'failed', reason);
              const halt = session.runner.getHalt();
              const failure: BatchFailure = {
                scenarioId: scenario.id,
                gameIndex,
                gameId,
                reason,
                ...(halt?.kind === undefined ? {} : { kind: halt.kind }),
              };
              repo.markFinished(batchId, 'failed', failure);
              return;
            }
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            repo.markGame(gameId, 'failed', reason);
            repo.markFinished(batchId, 'failed', {
              scenarioId: scenario.id,
              gameIndex,
              gameId,
              reason,
              kind: 'exception',
            });
            return;
          } finally {
            this.currentSession = null;
          }
        }
      }
      repo.markFinished(batchId, 'completed');
    } catch (error) {
      repo.markFinished(batchId, this.cancelled ? 'cancelled' : 'failed', {
        scenarioId,
        gameIndex: null,
        reason: error instanceof Error ? error.message : String(error),
        kind: 'exception',
      });
    }
  }
}
