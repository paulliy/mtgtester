// Viewer evidence input, group: trace ZIP validation. Split from card-evidence-input.test.ts.
// Shared fixtures live in card-evidence-input.fixtures.ts.
// Parser-boundary mocks are opt-in per test; all other calls use the real filesystem and git.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));
vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
}));

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as nodeModule from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadViewerEvidence, validateCurrentEvidenceSources } from '../../../../scripts/card-evidence-input';

import { repoRoot, scratch, hash, withFixture } from './card-evidence-input.fixtures';

describe('viewer evidence input: trace ZIP validation', { timeout: 120_000 }, () => {
  // CPU-heavy discovery plus immediately rejected promises can starve worker IPC callbacks.
  afterEach(() => yieldToEventLoop());
  it('owns exact mutable ZIP bytes across both validators and the recorded hash', async () => {
    await withFixture(async (f) => {
      const returned = Buffer.from(f.zip);
      const read = fs.readFileSync;
      let supplied = false;
      const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
        path: string,
        ...args: unknown[]
      ) => {
        if (path === f.tracePath && !supplied) {
          supplied = true;
          return returned;
        }
        return Reflect.apply(read, fs, [path, ...args]);
      }) as typeof read);
      const exec = childProcess.execFileSync;
      let input: Buffer | undefined;
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockImplementation(((
        command: string,
        args: string[],
        options: { input?: Buffer; timeout?: number; maxBuffer?: number },
      ) => {
        if (command === 'python') {
          input = options.input;
          expect(options.timeout).toBeGreaterThan(0);
          expect(options.timeout).toBeLessThanOrEqual(30_000);
          expect(options.maxBuffer).toBe(1024 * 1024);
        }
        return Reflect.apply(exec, childProcess, [command, args, options]);
      }) as typeof exec);
      try {
        const pending = loadViewerEvidence(f.paths, f.options);
        returned.fill(0); // Change the caller's original while asynchronous drainage is pending.
        const context = await pending;
        expect(input).not.toBe(returned);
        expect(input).toEqual(f.zip);
        expect(context.traces['war-room-viewer-colorless-mana']!.sha256).toBe(hash(f.zip));
      } finally {
        execSpy.mockRestore();
        readSpy.mockRestore();
      }
    });
  });

  it('rejects the compressed input limit before invoking Python', async () => {
    await withFixture(async (f) => {
      fs.truncateSync(f.tracePath, 128 * 1024 * 1024 + 1);
      await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/compressed byte limit/);
    });
  });

  it('rejects unavailable bundled reader without accepting a Python-only fallback', async () => {
    await withFixture(async (f) => {
      const spy = vi.spyOn(nodeModule, 'createRequire').mockImplementation(() => {
        throw new Error('synthetic unavailable');
      });
      try {
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(
          /validator unavailable/,
        );
      } finally {
        spy.mockRestore();
      }
    });
  });

  it.each(['success', 'error', 'deadline', 'entry-limit', 'member-limit', 'total-limit'] as const)(
    'closes synthetic reader and active streams on %s',
    async (kind) => {
      await withFixture(async (f) => {
        const reader = new EventEmitter();
        const close = vi.fn();
        const streams: PassThrough[] = [];
        let entries = 0;
        const fake = Object.assign(reader, {
          entryCount: kind === 'entry-limit' ? 20_001 : kind === 'total-limit' ? 3 : 2,
          close,
          readEntry() {
            if (entries === fake.entryCount) {
              reader.emit('end');
              return;
            }
            reader.emit('entry', {
              fileName: `${entries++}.trace`,
              generalPurposeBitFlag: 0,
              compressionMethod: 0,
              uncompressedSize:
                kind === 'member-limit'
                  ? 512 * 1024 * 1024 + 1
                  : kind === 'total-limit'
                    ? 512 * 1024 * 1024
                    : 0,
            });
          },
          openReadStream(_entry: unknown, callback: (error: null, stream: PassThrough) => void) {
            const stream = new PassThrough();
            streams.push(stream);
            callback(null, stream);
            queueMicrotask(() => {
              if (kind === 'error')
                stream.emit('error', new Error('synthetic decompression failure'));
              else if (kind === 'total-limit') {
                // Synthetic chunk lengths exercise the actual counters without allocating GiB.
                stream.emit('data', { length: 512 * 1024 * 1024 });
                stream.end();
              } else if (kind !== 'deadline') stream.end();
              else vi.advanceTimersByTime(30_001);
            });
          },
        });
        const requireFake = Object.assign(
          () => ({
            yauzl: {
              fromBuffer(
                _bytes: Buffer,
                _options: unknown,
                callback: (error: null, zip: typeof fake) => void,
              ) {
                callback(null, fake);
              },
            },
          }),
          { resolve: () => resolve(scratch, 'synthetic-bundle/package.json') },
        );
        const spy = vi
          .spyOn(nodeModule, 'createRequire')
          .mockReturnValue(requireFake as unknown as ReturnType<typeof nodeModule.createRequire>);
        if (kind === 'deadline') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
          if (kind === 'success')
            await expect(loadViewerEvidence(f.paths, f.options)).resolves.toBeDefined();
          else
            await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(
              /ZIP|limit|deadline/,
            );
          expect(close).toHaveBeenCalledOnce();
          for (const stream of streams) expect(stream.destroyed).toBe(true);
        } finally {
          vi.useRealTimers();
          spy.mockRestore();
        }
      });
    },
  );

  it.each([
    'duplicate',
    'unsafe',
    'unsupported',
    'nontarget-size',
    'overdeclared',
    'hidden-nontarget',
  ] as const)('rejects synthetic ZIP member %s through the actual loader', async (kind) => {
    await withFixture(async (f) => {
      const zip = execFileSync('python', [
        '-c',
        `
import io,sys,zipfile,struct,zlib
b=io.BytesIO()
with zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z:
 z.writestr(zipfile.ZipInfo('0-trace.trace',(2020,1,1,0,0,0)),b'{"version":8,"type":"context-options"}\\n{"type":"before"}\\n')
 z.writestr(zipfile.ZipInfo(${kind === 'duplicate' ? "'0-trace.trace'" : kind === 'unsafe' ? "'../unsafe'" : "'resource.bin'"},(2020,1,1,0,0,0)),b'non-target unit member')
data=bytearray(b.getvalue()); first=data.index(b'PK\\x01\\x02'); second=data.index(b'PK\\x01\\x02',first+4)
local=struct.unpack_from('<I',data,second+42)[0]
kind='${kind}'
if kind=='unsupported': struct.pack_into('<H',data,second+10,99); struct.pack_into('<H',data,local+8,99)
if kind in ('nontarget-size','overdeclared'):
 size=struct.unpack_from('<I',data,second+24)[0]+(1 if kind=='overdeclared' else -1)
 struct.pack_into('<I',data,second+24,size); struct.pack_into('<I',data,local+22,size)
if kind=='hidden-nontarget':
 end=data.index(b'PK\\x05\\x06'); struct.pack_into('<HH',data,end+8,1,1)
sys.stdout.buffer.write(data)
`,
      ]);
      writeFileSync(f.tracePath, zip);
      await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/ZIP|member|path/);
    });
  });

  it('rejects synthetic underdeclared member size with valid prefix CRC', async () => {
    await withFixture(async (f) => {
      // Positive control uses the real loader, not a mocked ZIP boundary.
      await expect(loadViewerEvidence(f.paths, f.options)).resolves.toBeDefined();
      const malformed = execFileSync('python', [
        '-c',
        `
import io,sys,zipfile,struct,zlib
prefix=b'{"version":8,"type":"context-options"}\\n{"type":"before"}\\n'
prefix+=b' '*(97-len(prefix))
payload=prefix+b'x'*29
assert len(prefix)==97 and len(payload)==126
b=io.BytesIO()
info=zipfile.ZipInfo("0-trace.trace",(2020,1,1,0,0,0)); info.compress_type=zipfile.ZIP_DEFLATED
with zipfile.ZipFile(b,"w") as z: z.writestr(info,payload)
data=bytearray(b.getvalue()); central=data.index(b'PK\\x01\\x02')
struct.pack_into('<I',data,14,zlib.crc32(prefix)); struct.pack_into('<I',data,22,len(prefix))
struct.pack_into('<I',data,central+16,zlib.crc32(prefix)); struct.pack_into('<I',data,central+24,len(prefix))
with zipfile.ZipFile(io.BytesIO(data)) as z:
 assert z.testzip() is None and z.read("0-trace.trace")==prefix
assert len(zlib.decompress(data[30+data[26]:central],-15))>len(prefix)
sys.stdout.buffer.write(data)
`,
      ]);
      writeFileSync(f.tracePath, malformed);
      if (process.env['MTG_EVIDENCE_TEST_SCRATCH'])
        writeFileSync(resolve(scratch, 'synthetic-underdeclared-97-126.zip'), malformed);
      await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(/ZIP|size|bytes/);
    });
  });

  it.each(['source', 'tree', 'validator-unavailable'] as const)(
    'checks %s using mocked parser boundaries only',
    async (kind) => {
      await withFixture(async (f) => {
        const context = await loadViewerEvidence(f.paths, f.options);
        if (kind === 'source') {
          const original = fs.readFileSync;
          const target = fs.realpathSync(resolve(repoRoot, '.prettierrc'));
          const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((
            path: string,
            ...args: unknown[]
          ) => {
            if (path === target) return Buffer.from('changed');
            return Reflect.apply(original, fs, [path, ...args]);
          }) as typeof original);
          try {
            expect(() => validateCurrentEvidenceSources(context, repoRoot)).toThrow(
              /source bytes drift/,
            );
          } finally {
            spy.mockRestore();
          }
        } else {
          const original = childProcess.execFileSync;
          const spy = vi.spyOn(childProcess, 'execFileSync');
          if (kind === 'tree') {
            spy.mockImplementation(((command: string, args: string[], options: unknown) => {
              if (command === 'git' && args.includes('HEAD^{tree}')) return '0'.repeat(40);
              return Reflect.apply(original, childProcess, [command, args, options]);
            }) as typeof original);
            try {
              expect(() => validateCurrentEvidenceSources(context, repoRoot)).toThrow(/tree drift/);
            } finally {
              spy.mockRestore();
            }
          } else {
            spy.mockImplementation(((command: string, ...args: unknown[]) => {
              if (command === 'python')
                throw Object.assign(new Error('missing executable'), { code: 'ENOENT' });
              return Reflect.apply(original, childProcess, [command, ...args]);
            }) as typeof original);
            try {
              await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow(
                /validator unavailable/,
              );
            } finally {
              spy.mockRestore();
            }
          }
        }
      });
    },
  );

  it.each([
    'corrupt',
    'truncated',
    'empty',
    'nontrace',
    'traversal',
    'outside',
    'drive-relative',
    'root-relative',
  ] as const)('rejects %s trace input', async (kind) => {
    await withFixture(async (f) => {
      const target = f.report.suites[0]!.specs.find(
        (s) => s.title === 'War Room: colorless mana pays a spell cost',
      )!.tests[0]!.results[0]!.attachments[0]!;
      if (kind === 'corrupt') {
        const zip = Buffer.from(f.zip);
        const nameLength = zip.readUInt16LE(26);
        zip[30 + nameLength + 5] = zip[30 + nameLength + 5]! ^ 0xff;
        writeFileSync(f.tracePath, zip);
      }
      if (kind === 'truncated') writeFileSync(f.tracePath, f.zip.subarray(0, 60));
      if (kind === 'empty' || kind === 'nontrace')
        writeFileSync(
          f.tracePath,
          execFileSync('python', [
            '-c',
            `import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w") as z:\n ${kind === 'nontrace' ? 'z.writestr("readme.txt","not a trace")' : 'pass'}\nsys.stdout.buffer.write(b.getvalue())`,
          ]),
        );
      if (kind === 'traversal') target.path = 'output/../output/synthetic.zip';
      if (kind === 'outside') {
        target.path = resolve(f.root, 'outside.zip');
        writeFileSync(target.path, f.zip);
      }
      if (kind === 'drive-relative') target.path = 'C:synthetic.zip';
      if (kind === 'root-relative') target.path = '\\synthetic.zip';
      f.seal();
      await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow();
    });
  });

  it.each(['missing', 'duplicate', 'corrupt'] as const)(
    'requires a valid retained trace for a new untap execution: %s',
    async (variant) => {
      await withFixture(async (f) => {
        const spec = f.report.suites[0]!.specs.find(
          (entry) => entry.title === 'Soldier On: affect and untap one target',
        );
        expect(spec).toBeDefined();
        const result = spec!.tests[0]!.results[0]!;
        if (variant === 'missing') result.attachments = [];
        if (variant === 'duplicate') result.attachments.push({ ...result.attachments[0]! });
        if (variant === 'corrupt') {
          const corrupt = resolve(f.paths.outputRoot, 'corrupt-new-trace.zip');
          writeFileSync(corrupt, 'not a trace archive');
          result.attachments[0]!.path = corrupt;
        }
        f.seal();
        await expect(loadViewerEvidence(f.paths, f.options)).rejects.toThrow();
      });
    },
  );
});
