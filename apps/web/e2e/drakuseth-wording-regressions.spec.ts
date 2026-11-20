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

const DRAKUSETH_WORDING_SCENARIO_IDS = [
  'drakuseth-wording-viewer-three-targets',
  'drakuseth-wording-viewer-decline-others',
] as const;

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(90_000);

const pinFixture = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/drakuseth-wording-oracle.json', 'utf8'),
) as { cards: { card: { name: string; oracleText: string }; sha256: string }[] };
const currentPin = pinFixture.cards.find((entry) =>
  entry.card.oracleText.includes('Drakuseth deals'),
)!;

for (const id of DRAKUSETH_WORDING_SCENARIO_IDS) {
  test(drakuTitle(id), async ({ page }, info) => runScenario(page, info, id));
}

async function runScenario(
  page: Page,
  info: TestInfo,
  id: (typeof DRAKUSETH_WORDING_SCENARIO_IDS)[number],
): Promise<void> {
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
  await expect(page.getByRole('heading', { name: drakuTitle(id) })).toBeVisible();
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  const over = page.getByText(/game over/i).first();
  let cast = false;
  let castDescription = '';
  let attacked = false;
  let p2LifeBeforeAttack: number | undefined;
  let declinedDraw = false;
  let selectedOtherTargets = 0;

  for (let count = 0; count < 100; count++) {
    await expect.poll(async () => request !== undefined || (await over.isVisible())).toBe(true);
    if (await over.isVisible()) break;
    const current = request!;
    const beforeId = current.requestId;
    const castAction = !cast
      ? current.legalActions.find((action) => action.description.startsWith('Cast Drakuseth'))
      : undefined;
    if (castAction) {
      await page
        .locator('.hand-card:not(.hand-card-leave-active)', { hasText: 'Drakuseth, Maw of Flames' })
        .click();
      await expect(page.getByText(/Auto-pay/)).toBeVisible();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      castDescription = castAction.description;
      cast = true;
    } else if (
      current.decisionType === 'optionalTrigger' &&
      current.legalActions.some((a) => a.description === 'No')
    ) {
      await page.getByRole('button', { name: 'No', exact: true }).click();
      declinedDraw = true;
    } else if (current.decisionType === 'declareAttackers') {
      p2LifeBeforeAttack = snapshots
        .at(-1)!
        .seats.find((candidate) => candidate.seat === 'P2')!.life;
      await page.getByRole('button', { name: /Declare attackers/ }).click();
      await page
        .locator('.combat-assignment-row')
        .filter({ hasText: 'Drakuseth, Maw of Flames' })
        .getByRole('button', { name: 'P2', exact: true })
        .click();
      await page.getByRole('button', { name: 'Confirm attacks' }).click();
      attacked = true;
    } else if (current.decisionType === 'chooseTargets') {
      // The fixed 4-damage target is a regular target choice announced for the attack trigger.
      const target = page.locator('.opponent[data-seat="P2"]');
      await expect(target).toHaveClass(/targetable/);
      await target.click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    } else if (current.decisionType === 'general' && current.prompt.includes('Drakuseth')) {
      if (id.endsWith('three-targets') && selectedOtherTargets < 2) {
        const seat = selectedOtherTargets === 0 ? 'P3' : 'P4';
        const targetAction = current.legalActions.find(
          (action) => action.description === `Target ${seat}`,
        );
        expect(targetAction, `expected a distinct optional target ${seat}`).toBeDefined();
        await page.getByRole('button', { name: `Target ${seat}`, exact: true }).click();
        selectedOtherTargets++;
      } else {
        expect(
          current.legalActions.some((action) => action.description === 'Choose no more targets'),
        ).toBe(true);
        await page.getByRole('button', { name: 'Choose no more targets', exact: true }).click();
      }
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
  const seat = (id: string) => final.seats.find((candidate) => candidate.seat === id)!;
  const p2 = seat('P2');
  const p3 = seat('P3');
  const p4 = seat('P4');
  const expectedOthers = id.endsWith('three-targets');
  expect(cast).toBe(true);
  expect(castDescription).toContain('{4}{R}{R}{R}');
  expect(castDescription).not.toContain('without paying');
  expect(attacked).toBe(true);
  expect(p2LifeBeforeAttack).toBe(40);
  expect(declinedDraw).toBe(true);
  expect(currentPin.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(p2.life).toBe(29);
  expect(p3.life).toBe(expectedOthers ? 37 : 40);
  expect(p4.life).toBe(expectedOthers ? 37 : 40);
  const drakuseth = final.battlefield.find(
    (permanent) => permanent.name === 'Drakuseth, Maw of Flames',
  );
  expect(drakuseth).toBeDefined();
  expect(drakuseth!.power).toBe(7);
  expect(drakuseth!.toughness).toBe(7);
  expect(sourceHashes()).toEqual(sourcesBefore);
  await info.attach('drakuseth-wording-evidence', {
    contentType: 'application/json',
    body: JSON.stringify({
      scenarioId: id,
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      oraclePin: { name: currentPin.card.name, sha256: currentPin.sha256 },
      sourceHashes: sourcesBefore,
      final,
    }),
  });
}

function drakuTitle(id: string): string {
  return id.endsWith('three-targets')
    ? 'Drakuseth: current wording hits three distinct targets'
    : 'Drakuseth: current wording allows declining other targets';
}

function sourceHashes() {
  // The repository's file list passed Node's 1 MB default buffer (ENOBUFS); match card-gate.ts.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
    .trim()
    .split('\n');
  return Object.fromEntries(
    files
      .filter((file) =>
        /^(packages\/(engine|server|shared)\/|apps\/web\/|playwright\.config\.ts)/.test(file),
      )
      .map((file) => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]),
  );
}
