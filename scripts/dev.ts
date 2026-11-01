/**
 * `bun run dev` - the server and the web dev server together, one command instead of two
 * terminals. Any args after `--` are forwarded to the server only (e.g. `--port 3005 --no-db`),
 * matching what `bun run serve` already accepts.
 *
 * `bun run dev --table` runs `serve:table --dev` and the table app's dev server instead (plan M6);
 * the remaining args go to the table server (e.g. `--oracle-fixture <file>`).
 *
 * Plain `Bun.spawn` rather than a `concurrently`-style dependency: two child processes with
 * prefixed output and coordinated shutdown is little enough code not to need one.
 */

const table = process.argv.includes('--table');
const serverArgs = process.argv.slice(2).filter((arg) => arg !== '--table');

function parseServerPort(args: string[]): number {
  const fallback = table ? 3002 : 3001;
  const portIndex = args.indexOf('--port');
  if (portIndex === -1) return fallback;

  const port = Number.parseInt(args[portIndex + 1] ?? '', 10);
  return Number.isFinite(port) ? port : fallback;
}

function spawnTagged(
  name: string,
  cmd: string[],
  env: Record<string, string | undefined> = process.env,
): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe', env });
  void pipeTagged(proc.stdout, name, false);
  void pipeTagged(proc.stderr, name, true);
  return proc;
}

async function pipeTagged(
  stream: ReadableStream<Uint8Array>,
  name: string,
  isError: boolean,
): Promise<void> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) (isError ? console.error : console.log)(`[${name}] ${line}`);
  }
  if (buffer.length > 0) (isError ? console.error : console.log)(`[${name}] ${buffer}`);
}

async function waitForServer(port: number, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  const healthUrl = `http://localhost:${port}/health`;

  for (;;) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // The server is still loading oracle data or has not bound the port yet.
    }

    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for server health at ${healthUrl}`);
    }

    await Bun.sleep(250);
  }
}

const serverPort = parseServerPort(serverArgs);
const server = spawnTagged(
  'server',
  table
    ? ['bun', 'run', 'packages/server/src/cli/serve-table.ts', '--dev', ...serverArgs]
    : ['bun', 'run', 'packages/server/src/cli/serve.ts', ...serverArgs],
);
let web: ReturnType<typeof Bun.spawn> | undefined;

let shuttingDown = false;
function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill();
  web?.kill();
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

void (async () => {
  await Promise.race([
    waitForServer(serverPort),
    server.exited.then((code) => {
      throw new Error(`Server exited before becoming healthy with code ${code ?? 1}`);
    }),
  ]);

  web = spawnTagged(
    'web',
    ['bun', 'run', '--cwd', 'apps/web', 'dev', ...(table ? ['--mode', 'table'] : [])],
    {
      ...process.env,
      ...(table
        ? { TABLE_SERVER_PORT: String(serverPort) }
        : { GAME_SERVER_PORT: String(serverPort) }),
    },
  );

  void web.exited.then((code) => shutdown(code ?? 1));
})().catch((error: unknown) => {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
});

// If either side dies on its own (crash, port in use), take the other down with it rather than
// leaving one half running silently.
void server.exited.then((code) => shutdown(code ?? 1));
