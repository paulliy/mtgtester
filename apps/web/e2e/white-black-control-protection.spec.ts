import { expect, test, type Page } from '@playwright/test';

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

function permanent(page: Page, name: string) {
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

async function targetAndConfirm(page: Page, targetName: string): Promise<void> {
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, targetName).click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}

async function chooseBlue(page: Page): Promise<void> {
  await expect(page.getByText(/Choose a color/i)).toBeVisible({ timeout: 15_000 });
  const choice = page.getByRole('button', { name: 'Protection from U', exact: true });
  await expect(choice).toBeVisible();
  await choice.click();
}

async function castOnStack(page: Page, cardName: string, stackCardName: string): Promise<void> {
  const spell = handCard(page, cardName);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.stack').getByText(stackCardName, { exact: true }).click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
}

test('Mother of Runes taps and grants the chosen color protection to your creature', async ({
  page,
}) => {
  await runScenario(
    page,
    'Mother of Runes: tap to give your creature protection from a chosen color',
  );

  const mother = permanent(page, 'Mother of Runes');
  await expect(mother).toHaveClass(/actionable/, { timeout: 15_000 });
  await mother.click();
  await expect(page.getByText('Activate Mother of Runes', { exact: true })).toBeVisible();
  await targetAndConfirm(page, 'Lab P1 Protection Target');
  await chooseBlue(page);

  const target = permanent(page, 'Lab P1 Protection Target');
  await expect(target.locator('.keywords')).toContainText(/protection from blue/i);
  await expect(page.getByText(/Protection from U/).first()).toBeVisible();
  await expect(page.getByText(/Mother of Runes.*resolves/i).first()).toBeVisible();
});

test('Sejiri Shelter pays its normal cost, targets your creature, and grants chosen color protection', async ({
  page,
}) => {
  await runScenario(page, 'Sejiri Shelter: cast for {1}{W} and choose a protection color');
  const shelter = handCard(page, 'Sejiri Shelter // Sejiri Glacier');
  await expect(shelter).toHaveClass(/actionable/, { timeout: 15_000 });
  await shelter.click();
  const castSpell = page.getByRole('button', { name: 'Cast {1}{W}', exact: true });
  await expect(castSpell).toBeVisible();
  await castSpell.click();
  await targetAndConfirm(page, 'Lab P1 Protection Target');
  await chooseBlue(page);

  const target = permanent(page, 'Lab P1 Protection Target');
  await expect(target.locator('.keywords')).toContainText(/protection from blue/i);
  await expect(page.getByText(/Protection from U/).first()).toBeVisible();
  await expect(page.getByText(/Sejiri Shelter.*resolves/i).first()).toBeVisible();
});

test("Reprieve returns P2's targeted spell to their hand and draws", async ({ page }) => {
  await runScenario(page, "Reprieve: return P2's targeted spell to their hand and draw a card");
  const stack = page.locator('.stack');
  await expect(stack).toContainText('Lab P2 Targeted Growth Spell', { timeout: 15_000 });
  const initialHandSize = await page.locator('.hand-card:not(.hand-card-leave-active)').count();
  const p2Zone = page.locator('.opponent[data-seat="P2"]');
  const p2Before = (await p2Zone.textContent())?.match(/hand (\d+)/);
  expect(p2Before, 'P2 visible hand count before Reprieve resolves').not.toBeNull();
  await castOnStack(page, 'Reprieve', 'Lab P2 Targeted Growth Spell');

  await expect(stack).not.toContainText('Lab P2 Targeted Growth Spell', { timeout: 15_000 });
  await expect(p2Zone).toContainText(`hand ${Number(p2Before![1]) + 1}`);
  await expect(page.locator('.hand-card:not(.hand-card-leave-active)')).toHaveCount(
    initialHandSize,
    { timeout: 15_000 },
  );
  await expect(page.getByText(/Reprieve.*draws? a card/i).first()).toBeVisible();
  await expect(
    page.getByText(/returns? .*Lab P2 Targeted Growth Spell.*hand/i).first(),
  ).toBeVisible();
});

test("Rebuff the Wicked counters P2's spell targeting your creature", async ({ page }) => {
  await runScenario(page, "Rebuff the Wicked: counter P2's spell targeting your creature");
  const stack = page.locator('.stack');
  await expect(stack).toContainText('Lab P2 Targeted Growth Spell', { timeout: 15_000 });
  await castOnStack(page, 'Rebuff the Wicked', 'Lab P2 Targeted Growth Spell');

  await expect(stack).not.toContainText('Lab P2 Targeted Growth Spell', { timeout: 15_000 });
  await expect(page.getByText(/Lab P2 Targeted Growth Spell.*counter/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await expect(permanent(page, 'Lab P1 Protection Target')).toContainText('2/2');
});
