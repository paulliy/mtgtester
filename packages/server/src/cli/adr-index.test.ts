// The ADR index generator (`scripts/adr-index.ts`, run as `bun run adr:index`). Vitest only
// collects tests under packages/, so the script's test lives here.
import { describe, expect, it } from 'vitest';

import { buildTable, parseAdr, type AdrSource } from '../../../../scripts/adr-index';

const adr = (file: string, header: string): AdrSource => ({
  file,
  text: `# ${file.slice(0, 4)} — Title of ${file}\n\n${header}\n\n## Context\n\nSupersedes [0099](0099-x.md) in the body is not read.\n`,
});

describe('adr-index', () => {
  it('reads the status, date and title, also with CRLF line endings', () => {
    const { adr: parsed, errors } = parseAdr(
      '0007-thing.md',
      '# ADR 0007: A thing\r\n\r\nStatus: Accepted (2026-11-01)\r\nStatus note: in part\r\n\r\nDate: 2026-10-30\r\n',
    );
    expect(errors).toEqual([]);
    expect(parsed).toMatchObject({
      number: '0007',
      title: 'A thing',
      status: 'Accepted',
      statusDate: '2026-11-01',
      date: '2026-10-30',
    });
  });

  it('rejects a missing status line and a qualifier on the status line itself', () => {
    expect(parseAdr('0001-a.md', '# 0001 — A\n\nDate: 2026-01-01\n').errors).toHaveLength(1);
    const qualified = parseAdr(
      '0002-b.md',
      "# 0002 — B\n\nStatus: Proposed (2026-11-14). Waiting on Paul's answer.\n",
    );
    expect(qualified.errors[0]).toMatch(/Status note/);
  });

  it('fails on a duplicate number', () => {
    const { errors } = buildTable([
      adr('0003-a.md', 'Status: Accepted (2026-01-01)'),
      adr('0003-b.md', 'Status: Accepted (2026-01-02)'),
    ]);
    expect(errors).toEqual(['ADR number 0003 is used twice: 0003-a.md and 0003-b.md']);
  });

  it('follows a supersedes clause whose link Prettier wrapped onto the next line', () => {
    const { table, errors } = buildTable([
      adr('0010-old.md', 'Status: Completed (2026-01-01)'),
      adr(
        '0011-new.md',
        'Status: Accepted (2026-02-01)\n\n> Status in July: in progress. Supersedes the estimates in\n> [0010](0010-old.md) §3 with a plan.',
      ),
    ]);
    expect(errors).toEqual([]);
    expect(table).toMatch(/\| \[0010\]\(0010-old\.md\) .*\| 0011 \(in part\) \|/);
  });

  it('records amendments in both directions and a whole supersession from the status line', () => {
    const { table, errors } = buildTable([
      adr('0020-a.md', 'Status: Superseded by 0022 (2026-03-01)\nAmended by [0021](0021-b.md).'),
      adr('0021-b.md', 'Status: Accepted (2026-02-01)'),
      adr('0022-c.md', 'Status: Accepted (2026-03-01)\nSupersedes [0020](0020-a.md).'),
    ]);
    expect(errors).toEqual([]);
    expect(table).toContain('| 0021 (amends), 0022 (whole) |');
  });

  it('fails on a link to a missing ADR, a missing superseder, or an unrecorded whole supersession', () => {
    const { errors } = buildTable([
      adr('0030-a.md', 'Status: Superseded by 0099 (2026-01-01)'),
      adr('0031-b.md', 'Status: Accepted (2026-01-01)\nAmends [0098](0098-x.md).'),
      adr('0032-c.md', 'Status: Accepted (2026-01-01)'),
      adr('0033-d.md', 'Status: Accepted (2026-01-01)\nSupersedes [0032](0032-c.md).'),
    ]);
    expect(errors).toEqual([
      'ADR 0099 and 0030 are linked, but ADR 0099 does not exist',
      'ADR 0031 and 0098 are linked, but ADR 0098 does not exist',
      'ADR 0033 supersedes 0032 whole, but 0032-c.md does not say "Status: Superseded by 0033"; write "Supersedes in part" or update its status',
    ]);
  });
});
