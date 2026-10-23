import { expect, test } from '@playwright/test';
import { OLORIN_SCENARIO_IDS } from '../../../packages/server/src/cards/pr08-olorin-scenarios';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
for (const [index, id] of OLORIN_SCENARIO_IDS.entries()) {
  test(id, async ({ page }) => {
    let requestId = '',
      stackSize = 0;
    page.on('websocket', (socket) =>
      socket.on('framereceived', ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === 'playerActionRequired') {
          requestId = frame.payload.request.requestId;
          stackSize = frame.payload.state.stack.length;
        } else if (frame.type === 'playerStateSnapshot')
          stackSize = frame.payload.state.stack.length;
      }),
    );
    await page.goto('/card-test-lab');
    await page.locator('#scenario-select').selectOption(id);
    await page.getByRole('button', { name: 'Run scenario' }).click();
    await expect(page).toHaveURL(/\/game$/);
    const card = page.locator('.hand-card:not(.hand-card-leave-active)', {
      hasText: 'Searing Light',
    });
    await expect(card).toHaveClass(/actionable/);
    await card.click();
    await expect(page.getByText(/Auto-pay/)).toBeVisible();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    const resolved = page
      .locator('.log .line .text')
      .filter({ hasText: /Searing Light resolves$/ });
    let submitted = '';
    const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
    await expect
      .poll(
        async () => {
          if (await resolved.isVisible()) return true;
          if (
            stackSize > 0 &&
            requestId !== submitted &&
            (await pass.isVisible()) &&
            (await pass.isEnabled())
          ) {
            submitted = requestId;
            await pass.click();
          }
          return false;
        },
        { timeout: 15000 },
      )
      .toBe(true);
    const p2 = page.locator('.opponent[data-seat="P2"]');
    await expect(
      p2
        .locator('.object')
        .filter({ has: page.getByRole('img', { name: 'Lab Greatest Bear', exact: true }) }),
    ).toHaveCount(0, { timeout: 15000 });
    await expect(
      p2
        .locator('.object')
        .filter({ has: page.getByRole('img', { name: 'Lab Lesser Bear', exact: true }) }),
    ).toBeVisible();
    await expect(p2.locator('.life-badge')).toContainText(index === 0 ? '36' : '40');
    await expect(
      page.locator('.human-zone .resource').filter({ hasText: 'Graveyard' }),
    ).toContainText(index === 0 ? '3' : '2');
  });
}
