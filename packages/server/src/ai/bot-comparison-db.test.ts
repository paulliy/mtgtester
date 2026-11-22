import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/**
 * `ai_calls.bot_json` is additive: a database from before it gains the column as null, and the
 * logger writes a `BotComparison` onto the row of the decision it describes. Real SQLite, run
 * under Bun, because the migration list swallows "duplicate column" errors.
 */
it('migrates ai_calls.bot_json and stores a comparison on its decision row', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mtg-bot-comparison-'));
  try {
    const result = execFileSync(
      'bun',
      [
        '-e',
        `
    import { Database } from 'bun:sqlite';
    import { GameStore } from './packages/server/src/db/index.ts';
    import { AiCallLogger, localCallMeta } from './packages/server/src/ai/logger.ts';
    const path = process.argv[1];

    const old = new Database(path);
    old.exec(\`CREATE TABLE ai_calls (
      game_id TEXT NOT NULL, sequence INTEGER NOT NULL, seat INTEGER, model TEXT,
      prompt_tokens INTEGER, response_tokens INTEGER, request_json TEXT, response_json TEXT,
      was_retry INTEGER, was_fallback INTEGER, latency_ms INTEGER, PRIMARY KEY (game_id, sequence))\`);
    old.close();
    new GameStore(path).close();

    const db = new Database(path);
    db.exec('PRAGMA foreign_keys = OFF');
    const columns = db.query('PRAGMA table_info(ai_calls)').all().map((c) => c.name);
    const logger = new AiCallLogger(db, 'g1');
    const request = { requestId: 'r1', gameId: 'g1', turn: 3, activePlayer: 'P2', decidingPlayer: 'P1',
      phase: 'beginning', step: 'upkeep', decisionType: 'priority', prompt: '', legalActions: [] };
    logger.log(request, { response: { requestId: 'r1', actionId: 0 }, meta: localCallMeta() }, false, false, 'primary');
    logger.recordBotComparison({ schemaVersion: 1, requestId: 'r1', seat: 'P1', turn: 3,
      decisionType: 'priority', kind: 'shadow', playedBy: 'primary', playedActionId: 0,
      botActionId: 2, botTop: [{ actionId: 2, score: 4, description: 'Cast X' }], sameAction: false });
    const row = db.query("SELECT bot_json FROM ai_calls WHERE game_id = 'g1'").get();
    db.close();
    console.log(JSON.stringify({ columns, row }));
  `,
        join(dir, 'db.sqlite'),
      ],
      { encoding: 'utf8' },
    );
    const out = JSON.parse(result.trim().split('\n').pop()!) as {
      columns: string[];
      row: { bot_json: string };
    };
    expect(out.columns).toContain('bot_json');
    expect(JSON.parse(out.row.bot_json)).toMatchObject({ kind: 'shadow', botActionId: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
