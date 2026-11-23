import { expect, test, type Locator, type Page } from '@playwright/test';

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

async function passUntil(page: Page, target: Locator): Promise<void> {
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  await expect
    .poll(
      async () => {
        if (await target.isVisible()) return true;
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
}

// Opponent lands are a line of names. Dropping a source on one must target that land, not the
// opponent: the drop used to bubble to the panel and pick the seat, which no land ability takes.
test("dragging Wasteland onto an opponent's land name targets that land", async ({ page }) => {
  await runScenario(page, 'Wasteland: sacrificed, it destroys target nonbasic land');
  const wasteland = page
    .locator('.human-zone .lands .object')
    .filter({ has: page.getByRole('img', { name: 'Wasteland', exact: true }) });
  const p2 = page.locator('.opponent[data-seat="P2"]');
  const dual = p2.locator('.land-name', { hasText: 'Scenario Dual' });
  await expect(wasteland).toHaveClass(/actionable/, { timeout: 15_000 });
  await expect(dual).toBeVisible();

  await wasteland.dragTo(dual);
  await expect(dual).toHaveClass(/chosen-target/);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();

  await passUntil(page, p2.locator('.foot-label', { hasText: /^Lands 1 ·/ }));
  await expect(dual).toHaveCount(0);
  await expect(p2.locator('.land-name', { hasText: 'Forest' })).toHaveCount(1);
});
