import { expect, test } from '@playwright/test';
import type { ServerToClientMessage } from '@mtg/shared';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });

test('smart yield crosses quiet windows and a declined combat stop without extra passes', async ({
  page,
}) => {
  const requests: Extract<ServerToClientMessage, { type: 'playerActionRequired' }>[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', (frame) => {
      const message = JSON.parse(String(frame.payload)) as ServerToClientMessage;
      if (message.type === 'playerActionRequired') requests.push(message);
    }),
  );
  await page.goto('/card-test-lab');
  await page
    .locator('#scenario-select')
    .selectOption({ label: 'Kogla, the Titan Ape: bounce a Human, then attack' });
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Skip confirm step').check();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Smart yield Kogla, the Titan Ape', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.payload.request.step).toBe('beginCombat');
  await expect(page.locator('.ignored-abilities')).toContainText('Smart yield');
  // The relevant combat opportunity is offered once. Passing leaves the preference active.
  await page.getByRole('button', { name: 'Pass priority', exact: true }).click();
  await page.getByRole('button', { name: /Declare attackers/ }).click();
  await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  expect(
    requests
      .filter((message) => message.payload.request.decisionType === 'priority')
      .map((message) => message.payload.request.step),
  ).toEqual([null, 'beginCombat']);
  expect(
    requests.some((message) => message.payload.request.decisionType === 'declareAttackers'),
  ).toBe(true);
  await expect(
    page
      .locator('.object, .seat .tile')
      .filter({ has: page.getByRole('img', { name: 'Lab Squire', exact: true }) }),
  ).toBeVisible();
});

test('smart yield on a live opponent spell declines it immediately without a confirm or pass', async ({
  page,
}) => {
  await page.goto('/card-test-lab');
  await page
    .locator('#scenario-select')
    .selectOption({ label: 'Arcane Denial: next-upkeep draw 0' });
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page.locator('.stack li').filter({ hasText: 'Lab Pending Spell' })).toBeVisible();
  await page.getByRole('button', { name: 'Smart yield Arcane Denial', exact: true }).click();
  await expect(page.getByText(/game over/i).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Pass priority', exact: true })).toHaveCount(0);
  await expect(page.getByText(/is countered by Arcane Denial/i)).toHaveCount(0);
});
