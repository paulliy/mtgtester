/**
 * `bun run dev` — the server and the web dev server together, one command instead of two
 * terminals. Any args after `--` are forwarded to the server only (e.g. `--port 3005 --no-db`),
 * matching what `bun run serve` already accepts.
 *
 * Plain `Bun.spawn` rather than a `concurrently`-style dependency: two child processes with
 * prefixed output and coordinated shutdown is little enough code not to need one.
 */

const serverArgs = process.argv.slice(2);

function spawnTagged(name: string, cmd: string[]): ReturnType<typeof Bun.spawn> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
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

const server = spawnTagged('server', ['bun', 'run', 'packages/server/src/cli/serve.ts', ...serverArgs]);
const web = spawnTagged('web', ['bun', 'run', '--cwd', 'apps/web', 'dev']);

let shuttingDown = false;
function shutdown(exitCode: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill();
  web.kill();
  process.exit(exitCode);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

// If either side dies on its own (crash, port in use), take the other down with it rather than
// leaving one half running silently.
void server.exited.then((code) => shutdown(code ?? 1));
void web.exited.then((code) => shutdown(code ?? 1));
