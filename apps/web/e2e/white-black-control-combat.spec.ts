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

function permanent(page: Page, name: string) {
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}

async function castAndResolve(page: Page, name: string): Promise<void> {
  const before = await page.getByText(`${name} resolves`).count();
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect
    .poll(async () => (await page.getByText(`${name} resolves`).count()) > before, {
      timeout: 15_000,
    })
    .toBe(true);
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

async function attackWithBothWitnesses(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Declare attackers/ }).click({ timeout: 20_000 });
  for (const name of ['Lab Attack Witness Alpha', 'Lab Attack Witness Beta']) {
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: name })
      .getByRole('button', { name: 'P2' })
      .click();
  }
  await page.getByRole('button', { name: 'Confirm attacks' }).click();
}

test('Breena: aggregate attacks and compare defending-opponent life', async ({ page }) => {
  const title = 'Breena: aggregate attacks and compare defending-opponent life';
  await runScenario(page, title);
  await castAndResolve(page, 'Breena, the Demagogue');
  await expect(permanent(page, 'Breena, the Demagogue')).toBeVisible();
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await attackWithBothWitnesses(page);

  // The counters are not targeted: Breena's ability asks for a creature as it resolves.
  await expect(page.getByText(/choose a creature you control/i).first()).toBeVisible({
    timeout: 15_000,
  });
  await page
    .locator('div')
    .filter({ has: page.getByRole('img', { name: 'Lab Attack Witness Alpha', exact: true }) })
    .filter({ has: page.getByRole('button', { name: 'Choose' }) })
    .last()
    .getByRole('button', { name: 'Choose' })
    .click();

  // The two attacks on P2 produced one draw and one counter placement. P2 began at 45 life,
  // while P3 and P4 began at 40, satisfying Breena's defending-opponent comparison.
  await expect(handCard(page, 'Lab Breena Draw')).toBeVisible({ timeout: 15_000 });
  await expect(handCard(page, 'Lab Breena Draw')).toHaveCount(1);
  await expect(permanent(page, 'Lab Attack Witness Alpha').getByText('+1/+1×2')).toBeVisible();
  await expect(permanent(page, 'Lab Attack Witness Beta').getByText('+1/+1')).toHaveCount(0);
  const p2Life = page.locator(
    '.opponent[data-seat="P2"] .life-badge, .seat[data-seat="P2"] .life-badge',
  );
  await passUntil(page, p2Life.filter({ hasText: '39' }));
  await expect(p2Life).toHaveText('39');
});

test("Duelist's Heritage: one optional double-strike target", async ({ page }) => {
  const title = "Duelist's Heritage: one optional double-strike target";
  await runScenario(page, title);
  await castAndResolve(page, "Duelist's Heritage");
  await expect(permanent(page, "Duelist's Heritage")).toBeVisible();
  await passUntil(page, page.getByRole('button', { name: /Declare attackers/ }));
  await attackWithBothWitnesses(page);

  await expect(
    page.getByText('Target 1 of 1: click a highlighted card or player.', { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await permanent(page, 'Lab Attack Witness Alpha').click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Yes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Yes', exact: true }).click();

  // Only the chosen attacker receives double strike; together the two attackers deal six.
  await expect(permanent(page, 'Lab Attack Witness Alpha')).toContainText(/double strike/i);
  await expect(permanent(page, 'Lab Attack Witness Beta')).not.toContainText(/double strike/i);
  const p2Life = page.locator(
    '.opponent[data-seat="P2"] .life-badge, .seat[data-seat="P2"] .life-badge',
  );
  await passUntil(page, p2Life.filter({ hasText: '39' }));
  await expect(p2Life).toHaveText('39');
});
