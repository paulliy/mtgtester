/**
 * Answer compiler prompts through a coding-agent CLI instead of the Claude API: Claude Code
 * (`claude -p`), Codex (`codex exec`) or Antigravity (`agy -p`). Each prompt is one headless run
 * with tools off (or a read-only sandbox where the CLI has no switch for that), started in a fresh
 * empty directory so no project instructions (CLAUDE.md, AGENTS.md) reach the model. The agent
 * uses its own login; no API key is read here.
 *
 *   bun run scripts/card-compiler/run.ts exec <trial> <stage> --executor claude|codex|antigravity
 *
 * Settings:
 *   CARD_COMPILER_MODEL        model for every call; for claude the default is claude-haiku-5-5,
 *                              for codex and antigravity the CLI's own default when unset
 *   CARD_COMPILER_RETRY_MODEL  model for compile rounds 2 and later; for claude the default is
 *                              claude-sonnet-5-5, otherwise CARD_COMPILER_MODEL
 *   CARD_COMPILER_CONCURRENCY  parallel runs, default 4
 *   CARD_COMPILER_AGENT_BIN    the CLI's path, when it is not `claude`, `codex` or `agy` on PATH
 *   CARD_COMPILER_AGENT_TIMEOUT_MS  per-prompt limit, default 600000 (10 minutes)
 *
 * Claude Code reports its cost, so its runs are priced in usage.jsonl; codex and antigravity runs
 * are logged with `costUsd: null` and `report` falls back to its size-based estimate for them.
 */
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const AGENT_KINDS = ['claude', 'codex', 'antigravity'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as readonly string[]).includes(value);
}

const DEFAULT_BIN: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex',
  antigravity: 'agy',
};

/** What one run produced, once the CLI has exited 0. */
export interface AgentReply {
  /** The answer text, or null when the run did not finish with an answer. */
  text: string | null;
  /** Why `text` is null. */
  error?: string;
  costUsd: number | null;
  usage?: unknown;
}

export interface Invocation {
  args: string[];
  stdin: string;
  /** Reads the reply from the CLI's stdout and the run directory. */
  read: (stdout: string, runDir: string) => AgentReply;
}

/**
 * The command line for one prompt. `prefixFile` holds the stage's fixed instructions and
 * `prompt` the per-card text. Pure, so the argument shapes can be checked without the CLIs.
 */
export function buildInvocation(
  kind: AgentKind,
  options: { prefixFile: string; prefix: string; prompt: string; model: string | undefined },
): Invocation {
  const { prefixFile, prefix, prompt, model } = options;
  const modelArgs = model === undefined ? [] : ['--model', model];
  // Codex and Antigravity take no separate system prompt, so the prefix goes first in the message.
  const combined = `${prefix}\n\n---\n\n${prompt}`;
  switch (kind) {
    case 'claude':
      return {
        args: [
          '-p',
          '--output-format',
          'json',
          '--system-prompt-file',
          prefixFile,
          '--tools',
          '',
          '--strict-mcp-config',
          '--no-session-persistence',
          ...modelArgs,
        ],
        stdin: prompt,
        read: (stdout) => {
          let result: {
            is_error?: boolean;
            subtype?: string;
            result?: string;
            total_cost_usd?: number;
            usage?: unknown;
          };
          try {
            result = JSON.parse(stdout.slice(stdout.indexOf('{'))) as typeof result;
          } catch {
            return { text: null, error: 'claude printed no JSON result', costUsd: null };
          }
          const costUsd = typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null;
          if (
            result.is_error === true ||
            result.subtype !== 'success' ||
            typeof result.result !== 'string'
          )
            return {
              text: null,
              error: `claude ended with ${result.subtype ?? 'an error'}`,
              costUsd,
              usage: result.usage,
            };
          return { text: result.result, costUsd, usage: result.usage };
        },
      };
    case 'codex':
      return {
        args: [
          'exec',
          '--ephemeral',
          '--sandbox',
          'read-only',
          '--skip-git-repo-check',
          '--json',
          '--output-last-message',
          'answer.txt',
          ...modelArgs,
          '-',
        ],
        stdin: combined,
        read: (stdout, runDir) => {
          // --json prints one event per line; turn.completed carries the token usage.
          let usage: unknown;
          for (const line of stdout.split('\n')) {
            if (!line.trim().startsWith('{')) continue;
            try {
              const event = JSON.parse(line) as { type?: string; usage?: unknown };
              if (event.type === 'turn.completed') usage = event.usage;
              if (event.type === 'turn.failed')
                return { text: null, error: 'codex turn failed', costUsd: null, usage };
            } catch {
              // Not an event line.
            }
          }
          const file = join(runDir, 'answer.txt');
          if (!existsSync(file))
            return { text: null, error: 'codex wrote no final message', costUsd: null, usage };
          return { text: readFileSync(file, 'utf8'), costUsd: null, usage };
        },
      };
    case 'antigravity':
      // Headless (print) mode: stdin is the request and -p adds the instruction after it.
      return {
        args: [
          '-p',
          'Answer the request above exactly as it instructs. Print only the answer.',
          ...modelArgs,
        ],
        stdin: combined,
        read: (stdout) =>
          stdout.trim().length === 0
            ? { text: null, error: 'agy printed nothing', costUsd: null }
            : { text: stdout, costUsd: null },
      };
  }
}

function run(
  bin: string,
  invocation: Invocation,
  cwd: string,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, invocation.args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {
      // The CLI exited before reading stdin; its exit code reports the failure.
    });
    child.stdin.end(invocation.stdin);
  });
}

export async function answerPromptsWithAgent(
  kind: AgentKind,
  stage: string,
  prefixFile: string,
  pending: { prompt: string; answer: string }[],
  usageLog: string,
): Promise<void> {
  const env = process.env;
  const bin = env['CARD_COMPILER_AGENT_BIN'] ?? DEFAULT_BIN[kind];
  const base = env['CARD_COMPILER_MODEL'] ?? (kind === 'claude' ? 'claude-haiku-5-5' : undefined);
  const retry =
    env['CARD_COMPILER_RETRY_MODEL'] ?? (kind === 'claude' ? 'claude-sonnet-5-5' : base);
  const concurrency = Number(env['CARD_COMPILER_CONCURRENCY'] ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error(
      `CARD_COMPILER_CONCURRENCY must be a positive integer, got "${env['CARD_COMPILER_CONCURRENCY']}"`,
    );
  const timeoutMs = Number(env['CARD_COMPILER_AGENT_TIMEOUT_MS'] ?? 600_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error(
      `CARD_COMPILER_AGENT_TIMEOUT_MS must be a positive number, got "${env['CARD_COMPILER_AGENT_TIMEOUT_MS']}"`,
    );
  // Runs start in a temporary directory, so the prefix path must not be relative.
  const prefixPath = resolve(prefixFile);
  const prefix = readFileSync(prefixPath, 'utf8');
  let failed = 0;
  const queue = [...pending];
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      const name = job.prompt.split('/').pop();
      const round = /\.r(\d+)\.md$/.exec(job.prompt)?.[1];
      const model = stage === 'compile' && round !== undefined && Number(round) > 1 ? retry : base;
      const invocation = buildInvocation(kind, {
        prefixFile: prefixPath,
        prefix,
        prompt: readFileSync(job.prompt, 'utf8'),
        model,
      });
      const runDir = mkdtempSync(join(tmpdir(), 'card-compiler-'));
      try {
        let result;
        try {
          result = await run(bin, invocation, runDir, timeoutMs);
        } catch (error) {
          // The binary is missing or not executable: every other prompt would fail the same way.
          throw new Error(
            `could not start ${bin} for --executor ${kind}: ${(error as Error).message}` +
              ' (set CARD_COMPILER_AGENT_BIN to its path)',
          );
        }
        const label = `${stage} ${name} ${kind}${model === undefined ? '' : ` ${model}`}`;
        if (result.timedOut || result.code !== 0) {
          failed++;
          const why = result.timedOut ? `timed out after ${timeoutMs} ms` : `exited ${result.code}`;
          console.error(`${label} failed: ${why}\n${result.stderr.trim().slice(-2000)}`);
          continue;
        }
        const reply = invocation.read(result.stdout, runDir);
        appendFileSync(
          usageLog,
          `${JSON.stringify({ stage, prompt: job.prompt, executor: kind, model: model ?? null, usage: reply.usage ?? null, costUsd: reply.costUsd, error: reply.error })}\n`,
        );
        // Like the API path: an unfinished answer says nothing about the card, so the prompt stays
        // pending instead of spending one of the card's compile rounds.
        if (reply.text === null) {
          failed++;
          console.error(`${label} failed: ${reply.error}`);
          continue;
        }
        console.log(`${label} ok`);
        mkdirSync(job.answer.slice(0, job.answer.lastIndexOf('/')), { recursive: true });
        writeFileSync(job.answer, reply.text);
      } finally {
        rmSync(runDir, { recursive: true, force: true });
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  if (failed > 0)
    console.warn(
      `${failed} prompts left pending (agent error or incomplete answer); run exec again`,
    );
}
