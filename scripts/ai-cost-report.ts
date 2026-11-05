/**
 * Where the AI provider's money goes, from the call log every AI game writes.
 *
 *   bun run scripts/ai-cost-report.ts [--db data/mtg.sqlite] [--games N]
 *
 * Reads `ai_attempts` (one row per HTTP attempt, failed ones included) and reports, by role:
 * attempts per logical request, how many attempts ended at the output-token cap
 * (`finish_reason: length`, or a response that used the whole `max_tokens`), what the attempts
 * that produced no usable answer cost, and spend by upstream provider. Then the most recent games,
 * each with its cost and the strategist's share. Costs are what the provider reported; attempts
 * with no reported cost are counted but add nothing.
 */
import { Database } from 'bun:sqlite';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const dbPath = flag('--db') ?? 'data/mtg.sqlite';
const recentGames = Number(flag('--games') ?? 15);

interface Row {
  game_id: string;
  logical_request_id: string;
  requested_model: string;
  backend: string | null;
  status: string;
  cost_usd: number | null;
  attempt_json: string;
}

type Role = 'strategist' | 'tactician' | 'reflection' | 'deal-draft' | 'archetype';

function roleOf(requestId: string): Role {
  if (requestId.endsWith('-strategy')) return 'strategist';
  if (requestId.endsWith('-reflection')) return 'reflection';
  if (requestId.includes('-deal-draft-')) return 'deal-draft';
  if (requestId.startsWith('archetype-')) return 'archetype';
  return 'tactician';
}

interface Attempt {
  game: string;
  request: string;
  role: Role;
  model: string;
  backend: string;
  status: string;
  cost: number;
  costReported: boolean;
  promptTokens: number;
  responseTokens: number;
  maxTokens: number | null;
  finishReason: string | null;
}

const db = new Database(dbPath, { readonly: true });
const rows = db
  .query<Row, []>(
    `SELECT game_id, logical_request_id, requested_model, backend, status, cost_usd, attempt_json
       FROM ai_attempts ORDER BY game_id, sequence`,
  )
  .all();
if (rows.length === 0) {
  console.log(`No rows in ai_attempts in ${dbPath}.`);
  process.exit(0);
}

const attempts: Attempt[] = rows.map((row) => {
  let parsed: {
    finishReason?: string;
    effectiveConfig?: { maxTokens?: unknown };
    usage?: { promptTokens?: number; responseTokens?: number };
  } = {};
  try {
    parsed = JSON.parse(row.attempt_json) as typeof parsed;
  } catch {
    // A malformed row still counts as an attempt.
  }
  const maxTokens = parsed.effectiveConfig?.maxTokens;
  return {
    game: row.game_id,
    request: row.logical_request_id,
    role: roleOf(row.logical_request_id),
    model: row.requested_model,
    backend: row.backend ?? '(unknown)',
    status: row.status,
    cost: row.cost_usd ?? 0,
    costReported: row.cost_usd !== null,
    promptTokens: parsed.usage?.promptTokens ?? 0,
    responseTokens: parsed.usage?.responseTokens ?? 0,
    maxTokens: typeof maxTokens === 'number' ? maxTokens : null,
    finishReason: parsed.finishReason ?? null,
  };
});

/** Ended at the output cap: the provider said so, or the response used the whole budget. */
const atCap = (a: Attempt): boolean =>
  a.finishReason === 'length' || (a.maxTokens !== null && a.responseTokens >= a.maxTokens * 0.98);

const usd = (n: number): string => `$${n.toFixed(n >= 1 ? 2 : 4)}`;
const pct = (part: number, whole: number): string =>
  whole === 0 ? '-' : `${((part / whole) * 100).toFixed(0)}%`;
const totalCost = attempts.reduce((sum, a) => sum + a.cost, 0);
const games = new Set(attempts.map((a) => a.game));

console.log(
  `${dbPath}: ${attempts.length} attempts in ${games.size} games, ${usd(totalCost)} reported` +
    ` (${attempts.filter((a) => !a.costReported).length} attempts without a reported cost)\n`,
);

console.log('By role');
console.log(
  'role        attempts  requests  att/req  at cap  not accepted  avg out  avg in  cost      share  wasted',
);
for (const role of ['strategist', 'tactician', 'deal-draft', 'reflection', 'archetype'] as Role[]) {
  const mine = attempts.filter((a) => a.role === role);
  if (mine.length === 0) continue;
  const requests = new Set(mine.map((a) => a.request)).size;
  const cost = mine.reduce((sum, a) => sum + a.cost, 0);
  const wasted = mine.filter((a) => a.status !== 'accepted').reduce((sum, a) => sum + a.cost, 0);
  const avg = (f: (a: Attempt) => number): number =>
    Math.round(mine.reduce((sum, a) => sum + f(a), 0) / mine.length);
  console.log(
    [
      role.padEnd(11),
      String(mine.length).padStart(8),
      String(requests).padStart(9),
      (mine.length / requests).toFixed(2).padStart(8),
      `${mine.filter(atCap).length} (${pct(mine.filter(atCap).length, mine.length)})`.padStart(12),
      String(mine.filter((a) => a.status !== 'accepted').length).padStart(8),
      String(avg((a) => a.responseTokens)).padStart(12),
      String(avg((a) => a.promptTokens)).padStart(7),
      usd(cost).padStart(9),
      pct(cost, totalCost).padStart(6),
      usd(wasted).padStart(8),
    ].join(' '),
  );
}

const strategist = attempts.filter((a) => a.role === 'strategist');
if (strategist.length > 0) {
  console.log('\nStrategist attempts by model and provider');
  const groups = new Map<string, Attempt[]>();
  for (const a of strategist) {
    const key = `${a.model} via ${a.backend}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  for (const [key, list] of [...groups].sort((x, y) => y[1].length - x[1].length)) {
    const out = list.reduce((sum, a) => sum + a.responseTokens, 0);
    const cost = list.reduce((sum, a) => sum + a.cost, 0);
    console.log(
      `  ${key}: ${list.length} attempts, ${pct(list.filter(atCap).length, list.length)} at cap,` +
        ` ${Math.round(out / list.length)} output tokens each, ${usd(cost)}`,
    );
  }
  const byRequest = new Map<string, Attempt[]>();
  for (const a of strategist) byRequest.set(a.request, [...(byRequest.get(a.request) ?? []), a]);
  const unanswered = [...byRequest.values()].filter((list) =>
    list.every((a) => a.status !== 'accepted'),
  );
  console.log(
    `  ${byRequest.size} strategist requests; ${unanswered.length} (${pct(unanswered.length, byRequest.size)})` +
      ` got no accepted answer, costing ${usd(unanswered.flat().reduce((sum, a) => sum + a.cost, 0))}`,
  );
}

console.log(`\nMost recent ${recentGames} games`);
const order = db
  .query<{ id: string; started_at: string | null; turn_count: number | null }, []>(
    `SELECT id, started_at, turn_count FROM games ORDER BY started_at DESC`,
  )
  .all()
  .filter((game) => games.has(game.id))
  .slice(0, recentGames);
console.log('started              turns  attempts  at cap  cost      strategist  per turn');
for (const game of order) {
  const mine = attempts.filter((a) => a.game === game.id);
  const cost = mine.reduce((sum, a) => sum + a.cost, 0);
  const strategistCost = mine
    .filter((a) => a.role === 'strategist')
    .reduce((sum, a) => sum + a.cost, 0);
  const turns = game.turn_count ?? 0;
  console.log(
    [
      (game.started_at ?? '?').slice(0, 19).padEnd(19),
      String(turns).padStart(6),
      String(mine.length).padStart(9),
      String(mine.filter(atCap).length).padStart(7),
      usd(cost).padStart(9),
      pct(strategistCost, cost).padStart(11),
      (turns > 0 ? usd(cost / turns) : '-').padStart(9),
    ].join(' '),
  );
}
