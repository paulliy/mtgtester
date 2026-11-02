import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectLabCoverage } from './lab-selection';
import { PR02_FOLLOW_UP_SCENARIO_IDS } from '../../../packages/server/src/cards/pr02-follow-up-scenarios';

test.describe.configure({ mode: 'serial' });
test.use({ trace: 'on', screenshot: 'on' });
test.setTimeout(60_000);

const exercised = new Set<string>();
test.afterAll(() => expectLabCoverage(exercised, PR02_FOLLOW_UP_SCENARIO_IDS));

async function runScenario(page: Page, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: title });
  const id = await picker.inputValue();
  expect(PR02_FOLLOW_UP_SCENARIO_IDS).toContain(id);
  expect(exercised.has(id), `${id} was run more than once`).toBe(false);
  exercised.add(id);
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
}

function permanent(page: Page, name: string) {
  return page
    .locator('.object:not(.board-card-leave-active), .seat .tile')
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}
function handCard(page: Page, name: string) {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}
async function confirm(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Confirm' }).click();
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
      { timeout: 15_000 },
    )
    .toBe(true);
}

test('Conclave Tribunal: convoke alongside Illuminor Szeras stateful mana', async ({ page }) => {
  await runScenario(page, 'Conclave Tribunal: convoke beside Illuminor Szeras mana');
  const tribunal = handCard(page, 'Conclave Tribunal');
  await expect(tribunal).toHaveClass(/actionable/);
  await tribunal.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Conclave Tribunal')).toBeVisible();
  await expect(permanent(page, 'Illuminor Szeras').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Lab Convoke Bear').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Plains').locator('.tap-badge')).toHaveText('TAP');
  await expect(page.getByText(/Conclave Tribunal.*resolves/i).first()).toBeVisible();
});

test('Lab Killian contract: zero counted creature targets get no discount', async ({ page }) => {
  await runScenario(page, 'Lab contract: Killian receives no discount with zero counted targets');
  await handCard(page, 'Lab Counted Target Contract').click();
  const fullCast = page.getByRole('button', {
    name: 'Cast {4}{R}',
    exact: true,
  });
  await fullCast.click();
  await confirm(page);
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
  await expect(permanent(page, 'Lab Convoke Bear')).toBeVisible();
  await expect(permanent(page, 'Mountain').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Forest').filter({ has: page.locator('.tap-badge') })).toContainText(
    '×4',
  );
});

test('Lab Killian contract: two counted creature targets receive one discount', async ({
  page,
}) => {
  await runScenario(page, 'Lab contract: Killian discounts once for two counted creature targets');
  await handCard(page, 'Lab Counted Target Contract').click();
  await page
    .getByRole('button', {
      name: /Cast.*reduced for target slot 1.*\{2\}\{R\}/i,
    })
    .click();
  await confirm(page);
  await page.getByRole('button', { name: 'Target Lab Ox' }).click();
  await page.getByRole('button', { name: 'Target Lab Convoke Bear' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  await expect(permanent(page, 'Lab Convoke Bear')).toHaveCount(0);
  await expect(permanent(page, 'Mountain').locator('.tap-badge')).toHaveText('TAP');
  await expect(permanent(page, 'Forest').filter({ has: page.locator('.tap-badge') })).toContainText(
    '×2',
  );
});

test('Changing Loyalty: replicate twice, counter the original, keep both copies', async ({
  page,
}) => {
  await runScenario(
    page,
    'Changing Loyalty: replicate twice, counter the original, keep both copies',
  );
  await handCard(page, 'Changing Loyalty').click();
  await page.getByRole('button', { name: /Cast with replicate 2 \{5\}\{B\}/ }).click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab Ox').click();
  await confirm(page);
  await passUntil(page, page.getByRole('button', { name: 'Keep Lab Ox as the target' }));
  await page.getByRole('button', { name: 'Keep Lab Ox as the target' }).click();
  await page.getByRole('button', { name: 'Target Lab Convoke Bear' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(page.getByText(/Changing Loyalty is countered by Arcane Denial/i)).toBeVisible();
  await expect(page.getByText(/Copy of Changing Loyalty resolves/i)).toHaveCount(2);
});

test('Lab replicate contract: counted targets survive original countering', async ({ page }) => {
  await runScenario(
    page,
    'Lab contract: replicate preserves two counted targets after the original is countered',
  );
  await handCard(page, 'Lab Replicate Count Contract').click();
  await page.getByRole('button', { name: /Cast with replicate 1 \{3\}\{R\}/ }).click();
  await confirm(page);
  await page.getByRole('button', { name: 'Target Lab Ox' }).click();
  await page.getByRole('button', { name: 'Target Lab Convoke Bear' }).click();
  await passUntil(page, page.getByRole('button', { name: 'Target Lab Deer' }));
  await page.getByRole('button', { name: 'Target Lab Deer' }).click();
  await page.getByRole('button', { name: 'Target Lab Wolf' }).click();
  await passUntil(page, page.getByText(/game over/i).first());
  await expect(
    page.getByText(/Lab Replicate Count Contract is countered by Arcane Denial/i),
  ).toBeVisible();
  await expect(permanent(page, 'Lab Ox')).toBeVisible();
  await expect(permanent(page, 'Lab Convoke Bear')).toBeVisible();
  await expect(permanent(page, 'Lab Deer')).toHaveCount(0);
  await expect(permanent(page, 'Lab Wolf')).toHaveCount(0);
});
