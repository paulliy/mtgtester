import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type {
  DecisionRequest,
  PlayerBoardState,
  ServerToClientMessage,
  SpectatorState,
} from '@mtg/shared';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const permanent = (page: Page, name: string) =>
  page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
const pins = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/combat-trigger-oracle.json', 'utf8'),
) as {
  cards: { sha256: string; card: { name: string } }[];
};
function sourceHashes() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n');
  return Object.fromEntries(
    files
      .filter((file) =>
        /^(packages\/(engine|server|shared)\/|apps\/web\/|scripts\/card-evidence-input\.ts|playwright\.config\.ts)/.test(
          file,
        ),
      )
      .map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}

async function verify(page: Page, info: TestInfo, id: string) {
  const sourcesBefore = sourceHashes();
  const snapshots: (PlayerBoardState | SpectatorState)[] = [];
  let request: DecisionRequest | undefined;
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
      if (
        frame.type === 'playerStateSnapshot' ||
        frame.type === 'stateSnapshot' ||
        frame.type === 'replayUnlocked'
      )
        snapshots.push(frame.payload.state);
      if (frame.type === 'playerActionRequired') {
        request = frame.payload.request;
        snapshots.push(frame.payload.state);
      }
    }),
  );
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  await page.locator('#scenario-select').selectOption(id);
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  const over = page.getByText(/game over/i).first();
  let castScriv = false;
  let castBolt = false;
  let attacked = false;
  for (let count = 0; count < 80; count++) {
    await expect.poll(async () => request !== undefined || (await over.isVisible())).toBe(true);
    if (await over.isVisible()) break;
    const current = request!;
    const beforeId = current.requestId;
    const state = snapshots.at(-1)!;
    if (
      id.startsWith('scriv') &&
      !castScriv &&
      current.legalActions.some((a) => a.description.startsWith('Cast Scriv'))
    ) {
      await page
        .locator('.hand-card:not(.hand-card-leave-active)', { hasText: 'Scriv, the Obligator' })
        .click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      castScriv = true;
    } else if (
      id === 'scriv-viewer-departed-attacker' &&
      !castBolt &&
      current.phase === 'combat' &&
      state.stack.length > 0 &&
      current.legalActions.some((a) => a.description.includes('Cast Lightning Bolt'))
    ) {
      await page
        .locator('.hand-card:not(.hand-card-leave-active)', { hasText: 'Lightning Bolt' })
        .click();
      await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
      await permanent(page, 'Lab Bear').click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      castBolt = true;
    } else if (current.decisionType === 'declareAttackers') {
      await page.getByRole('button', { name: /Declare attackers/ }).click();
      const names = id.startsWith('marchesa')
        ? ['Marchesa, the Black Rose']
        : id.startsWith('namor')
          ? ['Namor, Atlantean King', 'Lab Bear']
          : [];
      for (const name of names)
        await page
          .locator('.combat-assignment-row')
          .filter({ hasText: name })
          .getByRole('button', { name: 'P2', exact: true })
          .click();
      await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
      attacked = names.length > 0;
    } else if (current.decisionType === 'declareBlockers') {
      await page.getByRole('button', { name: /Declare blockers/ }).click();
      await page.getByRole('button', { name: 'Confirm blocks', exact: true }).click();
    } else if (current.decisionType === 'chooseTargets') {
      await page.getByRole('button', { name: 'Target Lab Bear', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
      const passAnyway = page.getByRole('button', { name: 'Pass anyway', exact: true });
      await expect
        .poll(
          async () =>
            request?.requestId !== beforeId ||
            (await over.isVisible()) ||
            (await passAnyway.isVisible()),
        )
        .toBe(true);
      if (await passAnyway.isVisible()) await passAnyway.click();
    }
    await expect
      .poll(async () => request?.requestId !== beforeId || (await over.isVisible()))
      .toBe(true);
  }
  await expect(over).toBeVisible();
  const final = snapshots.at(-1)!;
  const p2 = final.seats.find((seat) => seat.seat === 'P2')!;
  if (id.startsWith('marchesa')) {
    expect(attacked).toBe(true);
    const positive = id.endsWith('response');
    expect(
      final.battlefield.find((p) => p.name === 'Marchesa, the Black Rose')!.counters['+1/+1'] ?? 0,
    ).toBe(positive ? 1 : 0);
    expect(p2.life).toBe(positive ? 34 : 36);
    await expect(permanent(page, 'Marchesa, the Black Rose')).toContainText(
      positive ? '4/4' : '3/3',
    );
    if (positive)
      expect(
        final.seats
          .find((seat) => seat.seat === 'P3')!
          .graveyard.some((c) => c.name === 'Lightning Bolt'),
      ).toBe(true);
  } else if (id.startsWith('namor')) {
    expect(attacked).toBe(true);
    const removed = id.endsWith('removed');
    expect(p2.life).toBe(removed ? 37 : 35);
    expect(final.battlefield.some((p) => p.name === 'Namor, Atlantean King')).toBe(!removed);
    await expect(permanent(page, 'Lab Bear')).toContainText('4/2');
    if (removed)
      expect(
        final.seats
          .find((seat) => seat.seat === 'P3')!
          .graveyard.some((c) => c.name === 'Lightning Bolt'),
      ).toBe(true);
  } else {
    expect(castScriv).toBe(true);
    const removed = id.includes('departed');
    expect(castBolt).toBe(removed);
    expect(p2.life).toBe(removed ? 40 : 38);
    if (removed) {
      expect(p2.graveyard.some((c) => c.name === 'Lab Bear')).toBe(true);
      await expect(permanent(page, 'Lab Bear')).toHaveCount(0);
    } else await expect(permanent(page, 'Contract')).toBeVisible();
  }
  expect(sourceHashes()).toEqual(sourcesBefore);
  await info.attach('combat-trigger-evidence', {
    contentType: 'application/json',
    body: JSON.stringify({
      scenarioId: id,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      oraclePins: pins.cards.map((p) => ({ name: p.card.name, sha256: p.sha256 })),
      sourceHashes: sourcesBefore,
      final,
    }),
  });
}

test('Marchesa: keep dethrone after a life-total response', async ({ page }, info) =>
  verify(page, info, 'marchesa-viewer-dethrone-response'));
test('Marchesa: ignore a non-leading defender', async ({ page }, info) =>
  verify(page, info, 'marchesa-viewer-dethrone-negative'));
test('Namor: boost allies attacking the defender', async ({ page }, info) =>
  verify(page, info, 'namor-viewer-defender-bonus'));
test('Namor: keep the bonus after source removal', async ({ page }, info) =>
  verify(page, info, 'namor-viewer-source-removed'));
test('Scriv: no life loss after the attacker dies', async ({ page }, info) =>
  verify(page, info, 'scriv-viewer-departed-attacker'));
test('Scriv: lose life when attacking the Contract controller', async ({ page }, info) =>
  verify(page, info, 'scriv-viewer-attacks-controller'));
