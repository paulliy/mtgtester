import { expect, test, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(90_000);

const scenarioTitle = 'Perch Protection: gift P2 an extra turn, then phase in with four Birds';

async function runScenario(page: Page): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  await page.locator('#scenario-select').selectOption({ label: scenarioTitle });
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(scenarioTitle).first()).toBeVisible();
}

function handCard(page: Page, name: string) {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}

function p1(page: Page) {
  return page.locator('.human-zone');
}

test('Perch Protection gifts P2 an extra turn, phases P1 out, then returns the same board', async ({
  page,
}) => {
  await runScenario(page);

  const spell = handCard(page, 'Perch Protection');
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();

  const gift = page.getByRole('button', { name: /Promise P2 a gift \(extraTurn\)/i });
  await expect(gift).toBeVisible();
  await gift.click();

  // Five real turn beginnings consume P2's extra turn, P2's normal turn, P3, P4, and P1.
  // Ending in P1's next main phase demonstrates the gift affected turn order and that the
  // phased-out objects returned before P1's untap.
  await expect(page.locator('.turn-badge')).toContainText('Turn 6 · Your turn', {
    timeout: 45_000,
  });
  await expect(page.getByText('Main phase 1', { exact: true })).toBeVisible();

  const board = p1(page);
  await expect(board.getByRole('img', { name: 'Lab Visible P1 Bear', exact: true })).toBeVisible();
  await expect(board.getByRole('img', { name: 'Plains', exact: true })).toHaveCount(1);
  const plainsTile = board.locator('.tile', {
    has: page.getByRole('img', { name: 'Plains', exact: true }),
  });
  await expect(plainsTile.locator('.stack-count-badge')).toHaveText('×6');
  await expect(board.getByRole('img', { name: 'Bird', exact: true })).toHaveCount(1);
  const birds = board.locator('.tile', {
    has: page.getByRole('img', { name: 'Bird', exact: true }),
  });
  await expect(birds).toContainText('2/2');
  await expect(birds).toContainText('flying');
  await expect(birds.locator('.stack-count-badge')).toHaveText('×4');

  // The real player view shows the exiled object and the public cast/gift/resolution sequence.
  const exiledPerch = board.locator('.zone', {
    has: page.getByRole('heading', { name: 'Exile (1)' }),
  });
  await expect(
    exiledPerch.getByRole('img', { name: 'Perch Protection', exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Cast Perch Protection \(\{4\}\{W\}\{W\}\)/)).toBeVisible();
  await expect(page.getByText('Promise P2 a gift (extraTurn)', { exact: false })).toBeVisible();
  await expect(page.getByText('Perch Protection resolves', { exact: false })).toBeVisible();
});
