import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ENTRY = 'packages/server/src/cli/serve-table.ts';

function run(args: string[], env: Record<string, string> = {}) {
  const cleaned: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(cleaned)) if (name.startsWith('TABLE_')) delete cleaned[name];
  return spawnSync('bun', ['run', ENTRY, ...args], {
    encoding: 'utf8',
    env: { ...cleaned, ...env },
    timeout: 30_000,
  });
}

describe('serve:table startup', () => {
  it('refuses to start without --dev', () => {
    const result = run([]);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('refused to start');
    expect(result.stderr).toContain('--dev');
    // It stopped before printing a host secret or listening.
    expect(result.stdout).not.toContain('Host secret');
  });

  it('refuses to start in dev mode with a proxy or allowlist setting', () => {
    const result = run(['--dev'], { TABLE_ALLOWED_HOSTS: 'tables.example.com' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TABLE_ALLOWED_HOSTS');
    expect(result.stdout).not.toContain('Host secret');
  });

  it('refuses an unknown argument', () => {
    const result = run(['--dev', '--insecure-lan']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--insecure-lan');
  });
});
