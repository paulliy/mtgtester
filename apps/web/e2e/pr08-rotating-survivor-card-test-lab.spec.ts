import { expect, test, type Page, type Locator } from '@playwright/test';
import { ROTATING_SURVIVOR_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-rotating-survivor-scenarios';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
for (const [index, id] of ROTATING_SURVIVOR_SCENARIO_IDS.entries()) {
  test(id, async ({ page }) => {
    let requestId = '',
      submitted = '';
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === 'playerActionRequired') requestId = frame.payload.request.requestId;
      }),
    );
    async function passUntil(target: Locator) {
      const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
      await expect
        .poll(
          async () => {
            if (await target.isVisible()) return true;
            if (requestId !== submitted && (await pass.isVisible()) && (await pass.isEnabled())) {
              submitted = requestId;
              await pass.click();
            }
            return false;
          },
          { timeout: 20000 },
        )
        .toBe(true);
    }
    await page.goto('/card-test-lab');
    await page.locator('#scenario-select').selectOption(id);
    await page.getByRole('button', { name: 'Run scenario' }).click();
    await expect(page).toHaveURL(/\/game$/);
    if (index < 2) {
      const source = page.locator('.hand-card:not(.hand-card-leave-active)', {
        hasText: index === 0 ? 'Alexios' : 'Varchild',
      });
      await expect(source).toHaveClass(/actionable/);
      await source.click();
      await expect(page.getByText(/Auto-pay/)).toBeVisible();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      if (index === 0) {
        const rotated = permanent(page, 'P2', 'Alexios, Deimos of Kosmos');
        await passUntil(rotated);
        await expect(rotated).toContainText('+1/+1×1');
        await expect(rotated).toContainText('5/5');
        await expect(rotated.locator('.tile')).not.toHaveClass(/tapped/);
        await expect(rotated).toContainText(/haste/i);
      } else {
        const survivor = permanent(page, 'P1', 'Lab Survivor');
        await passUntil(survivor);
        await expect(survivor.locator('.stack-count-badge')).toHaveText('×2');
        await expect(permanent(page, 'P2', 'Lab Survivor')).toHaveCount(0);
        await expect(
          page.locator('.human-zone .resource').filter({ hasText: 'Graveyard' }),
        ).toContainText('1');
      }
    } else {
      const attackers = page.getByRole('button', { name: /Declare attackers/ });
      await passUntil(attackers);
      await attackers.click();
      await page
        .locator('.combat-assignment-row')
        .filter({ hasText: 'Varchild' })
        .getByRole('button', { name: 'P2', exact: true })
        .click();
      await page.getByRole('button', { name: 'Confirm attacks' }).click();
      const created = permanent(page, 'P2', 'Survivor');
      await passUntil(created);
      await expect(created.locator('.stack-count-badge')).toHaveText('×3');
      await expect(page.locator('.opponent[data-seat="P2"] .life-badge')).toHaveText('37');
      await expect(permanent(page, 'P1', 'Varchild, Betrayer of Kjeldor')).toBeVisible();
      await expect(permanent(page, 'P2', 'Lab Survivor')).toBeVisible();
    }
  });
}
function permanent(page: Page, seat: string, name: string) {
  return page
    .locator(
      `${seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`} .object:not(.board-card-leave-active)`,
    )
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}
