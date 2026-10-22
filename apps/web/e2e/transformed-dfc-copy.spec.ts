import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import type { PlayerBoardState, ServerToClientMessage, SpectatorState } from '@mtg/shared';
import { TRANSFORMED_DFC_CASES } from '../../../packages/server/src/cards/transformed-dfc-scenarios';

// Real Vue viewer, production WebSocket transport, lab backend and production engine.
test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/transformed-dfc-copy-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: { name: string } }[] };
const sha = (content: string) => createHash('sha256').update(content).digest('hex');
function engineSourceHashes() {
  const options = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'ignore'] as const };
  const modified = execFileSync(
    'git',
    ['-c', 'core.autocrlf=false', 'diff', '--name-only', 'HEAD', '--', 'packages/engine/src'],
    options,
  );
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', 'packages/engine/src'],
    options,
  );
  return Object.fromEntries(
    [...new Set(`${modified}\n${untracked}`.split(/\r?\n/).filter(Boolean))]
      .sort()
      .map((path) => [path, sha(readFileSync(path, 'utf8'))]),
  );
}
const permanent = (page: Page, name: string) =>
  page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });

async function passUntil(page: Page, done: () => boolean | Promise<boolean>) {
  await expect
    .poll(
      async () => {
        if (await done()) return true;
        const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

for (const entry of TRANSFORMED_DFC_CASES) {
  test(`${entry.id}: copies the active face through the real viewer`, async ({ page }, info) => {
    const snapshots: (PlayerBoardState | SpectatorState)[] = [];
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
        if (frame.type === 'playerStateSnapshot' || frame.type === 'stateSnapshot')
          snapshots.push(frame.payload.state);
        if (frame.type === 'playerActionRequired') snapshots.push(frame.payload.state);
      }),
    );
    await page.goto('/card-test-lab');
    await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
    const picker = page.locator('#scenario-select');
    for (const scenario of TRANSFORMED_DFC_CASES)
      await expect(picker.locator(`option[value="${scenario.id}"]`)).toHaveCount(1);
    await picker.selectOption(entry.id);
    await page.getByRole('button', { name: 'Run scenario' }).click();
    await expect(page).toHaveURL(/\/game$/);
    const face = entry.transformed ? "Brigid, Doun's Mind" : "Brigid, Clachan's Heart";
    await expect(permanent(page, face)).toBeVisible();
    await expect.poll(() => snapshots.length).toBeGreaterThan(0);
    const originalId = snapshots
      .at(-1)!
      .battlefield.find((permanent) => permanent.name === face)!.id;
    const spell = entry.token ? 'Quantum Misalignment' : "Dack's Duplicate";
    const hand = page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: spell });
    await expect(hand).toHaveClass(/actionable/);
    await hand.click();
    if (entry.token) {
      await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
      await permanent(page, face).click();
    }
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    if (!entry.token) {
      const copy = page
        .locator('.panel-group')
        .filter({ hasText: face })
        .getByRole('button', { name: 'Copy', exact: true });
      await passUntil(page, () => copy.isVisible());
      await copy.click();
    }
    await passUntil(page, () =>
      snapshots.some((state) =>
        state.battlefield.some(
          (permanent) => permanent.id !== originalId && permanent.name === face,
        ),
      ),
    );
    const copy = snapshots
      .at(-1)!
      .battlefield.find((permanent) => permanent.id !== originalId && permanent.name === face)!;
    expect(copy.controller).toBe('P1');
    expect(copy.typeLine).toContain(
      `Creature — Kithkin ${entry.transformed ? 'Soldier' : 'Warrior'}`,
    );
    expect(copy.power).toBe(3);
    expect(copy.imageFace).toBe(entry.transformed ? 'back' : 'front');
    expect(copy.toughness).toBe(2);
    expect(copy.oracleText).toContain(
      entry.transformed ? '{T}: Add X {G} or X {W}' : 'create a 1/1 green and white Kithkin',
    );
    expect(copy.oracleText).not.toContain(
      entry.transformed ? 'create a 1/1 green and white Kithkin' : '{T}: Add X {G} or X {W}',
    );
    if (!entry.token) expect(copy.keywords).toContain('haste');
    for (const chip of await permanent(page, face).all()) {
      await expect(chip).toContainText('3/2');
      await expect(chip.locator('.frame img')).toHaveAttribute(
        'src',
        new RegExp(`/${entry.transformed ? 'back' : 'front'}/`),
      );
      await chip.hover();
      await expect(page.locator('.preview .card-image img')).toHaveAttribute(
        'src',
        new RegExp(`/${entry.transformed ? 'back' : 'front'}/`),
      );
    }
    await page.mouse.move(0, 0);
    if (!entry.token) {
      const defense = page.locator('.hand-card:not(.hand-card-leave-active)', {
        hasText: 'Blossoming Defense',
      });
      await expect(defense).toHaveClass(/actionable/);
      await defense.click();
      await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
      await permanent(page, 'Copy Companion').click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await passUntil(page, () =>
        snapshots.some((state) =>
          state.battlefield.some(
            (permanent) =>
              permanent.name === 'Copy Companion' &&
              permanent.power === 3 &&
              permanent.toughness === 3,
          ),
        ),
      );
      await expect(permanent(page, 'Copy Companion')).toContainText('3/3');
      const paid = snapshots.at(-1)!.battlefield.find((permanent) => permanent.id === copy.id)!;
      expect(paid.tapped).toBe(true);
      expect(
        snapshots.at(-1)!.battlefield.find((permanent) => permanent.name === 'Copy Companion')!
          .keywords,
      ).toContain('hexproof');
    }
    await passUntil(page, () =>
      page
        .getByText(/game over/i)
        .first()
        .isVisible(),
    );
    const final = snapshots.at(-1)!;
    expect(final.battlefield.filter((permanent) => permanent.name === 'Kithkin')).toHaveLength(
      entry.transformed ? 0 : 1,
    );
    await info.attach('transformed-dfc-viewer-evidence', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify(
          {
            scenarioId: entry.id,
            revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
            workingTreeDiffSha256: sha(
              execFileSync('git', ['-c', 'core.autocrlf=false', 'diff', '--binary', 'HEAD'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                maxBuffer: 64 * 1024 * 1024,
              }),
            ),
            engineSourceSha256: engineSourceHashes(),
            pinFileSha256: sha(
              readFileSync(
                'packages/engine/tests/fixtures/transformed-dfc-copy-oracle.json',
                'utf8',
              ),
            ),
            viewerTestSha256: sha(
              readFileSync('apps/web/e2e/transformed-dfc-copy.spec.ts', 'utf8'),
            ),
            scenarioSourceSha256: sha(
              readFileSync('packages/server/src/cards/transformed-dfc-scenarios.ts', 'utf8'),
            ),
            pins: pins.cards.map(({ sha256, card }) => ({ name: card.name, oracleSha256: sha256 })),
            finalCopy: final.battlefield.find((permanent) => permanent.id === copy.id),
            finalBattlefield: final.battlefield,
          },
          null,
          2,
        ),
      ),
    });
  });
}
