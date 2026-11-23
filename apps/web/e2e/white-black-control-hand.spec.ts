import { expect, test, type Locator, type Page } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: title });
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
}

function handCard(page: Page, name: string) {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}

function opponent(page: Page, seat: string): Locator {
  return page.locator(`.opponent[data-seat="${seat}"]`);
}

async function cast(page: Page, name: string, targetOpponent = false): Promise<void> {
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  if (targetOpponent) {
    await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
    await opponent(page, 'P2').locator('> header').click();
    await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}

test('Duress: reveal P2’s hand and choose a noncreature, nonland card', async ({ page }) => {
  const title = 'Duress: reveal P2’s hand and choose a noncreature, nonland card';
  await runScenario(page, title);
  await cast(page, 'Duress', true);

  await expect(
    page.getByText("Choose a card from P2's revealed hand to discard.", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  const artifactChoice = page
    .locator('.decision-panel .panel-group')
    .filter({ hasText: 'Lab P2 Artifact' });
  const enchantmentChoice = page
    .locator('.decision-panel .panel-group')
    .filter({ hasText: 'Lab P2 Enchantment' });
  await expect(artifactChoice).toBeVisible();
  await expect(enchantmentChoice).toBeVisible();
  for (const name of ['Lab P2 Artifact', 'Lab P2 Enchantment', 'Lab P2 Creature', 'Lab P2 Land'])
    await expect(page.getByText(`reveals ${name}`, { exact: true }).first()).toBeVisible();
  await expect(
    page.locator('.decision-panel .panel-group').filter({ hasText: 'Lab P2 Creature' }),
  ).toHaveCount(0);
  await expect(
    page.locator('.decision-panel .panel-group').filter({ hasText: 'Lab P2 Land' }),
  ).toHaveCount(0);
  await artifactChoice.getByRole('button', { name: 'Discard', exact: true }).click();

  await expect(opponent(page, 'P2')).toContainText('hand 3');
  await expect(opponent(page, 'P2').getByText('Graveyard')).toBeVisible();
  await expect(opponent(page, 'P2').getByRole('img', { name: 'Lab P2 Artifact' })).toBeVisible();
  await expect(page.getByText('Lab Private Library Card')).toHaveCount(0);
});

test('Thoughtseize: discard a nonland card and lose 2 life', async ({ page }) => {
  const title = 'Thoughtseize: discard a nonland card and lose 2 life';
  await runScenario(page, title);
  await cast(page, 'Thoughtseize', true);

  await expect(opponent(page, 'P2')).toContainText('hand 1');
  await expect(opponent(page, 'P2').getByRole('heading', { name: 'Graveyard (1)' })).toBeVisible();
  await expect(page.locator('.human-zone .life-badge')).toHaveText('38');
  await expect(page.getByText(/discards Lab P2 Creature/i).first()).toBeVisible();
});

test('Dark Confidant: reveal the top card at your upkeep', async ({ page }) => {
  const title = 'Dark Confidant: reveal the top card at your upkeep';
  await runScenario(page, title);
  await cast(page, 'Dark Confidant');

  await expect(page.getByText('Dark Confidant resolves').first()).toBeVisible({ timeout: 15_000 });
  await expect(handCard(page, 'Lab Confidant Reveal')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('.human-zone .life-badge')).toHaveText('37');
  await expect(page.getByText('reveals Lab Confidant Reveal', { exact: true })).toBeVisible();
  await expect(page.getByText(/draws Lab Confidant Reveal/i)).toHaveCount(0);
  await expect(page.getByText('Lab Private Library Card')).toHaveCount(0);
});
