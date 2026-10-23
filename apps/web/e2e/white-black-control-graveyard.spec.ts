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

function opponentGraveyard(page: Page, seat = 'P2') {
  return page
    .locator(`.opponent[data-seat="${seat}"] .opponent-zones .zone`)
    .filter({ hasText: 'Graveyard' });
}

function opponentExile(page: Page, seat = 'P2') {
  return page
    .locator(`.opponent[data-seat="${seat}"] .opponent-zones .zone`)
    .filter({ hasText: 'Exile' });
}

function humanZone(page: Page, zoneName: 'Graveyard' | 'Exile') {
  return page.locator('.human-zone .zones-strip .zone').filter({ hasText: zoneName });
}

async function castAndResolve(page: Page, name: string): Promise<void> {
  const before = await page.getByText(`${name} resolves`).count();
  const spell = handCard(page, name);
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Auto-pay/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect
    .poll(
      async () => {
        if (await permanent(page, name).isVisible()) return true;
        if ((await page.getByText(`${name} resolves`).count()) > before) return true;
        const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      {
        timeout: 15_000,
      },
    )
    .toBe(true);
}

async function castDestroyTarget(page: Page): Promise<void> {
  const spell = handCard(page, 'Lab Prepared Doom');
  await expect(spell).toHaveClass(/actionable/, { timeout: 15_000 });
  await spell.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await permanent(page, 'Lab P2 Creature to Destroy').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect
    .poll(
      async () => {
        if (await page.getByText('Lab Prepared Doom resolves', { exact: true }).isVisible())
          return true;
        const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
        if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
        return false;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(page.getByText('Lab Prepared Doom resolves', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

test('Rest in Peace casts normally, clears both existing graveyards, and replaces a later destruction', async ({
  page,
}) => {
  await runScenario(
    page,
    'Rest in Peace: exile existing graveyards, then exile a creature destroyed later',
  );
  await expect(page.getByRole('img', { name: 'Lab P1 Existing Graveyard Card' })).toBeVisible();
  await expect(
    opponentGraveyard(page).getByRole('img', { name: 'Lab P2 Existing Graveyard Card' }),
  ).toBeVisible();

  await castAndResolve(page, 'Rest in Peace');
  await expect(permanent(page, 'Rest in Peace')).toBeVisible();
  await expect
    .poll(async () => {
      if ((await opponentGraveyard(page).count()) === 0) return true;
      const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
      if (await pass.isVisible()) await pass.click();
      return false;
    })
    .toBe(true);
  await expect(
    page.locator('.human-zone .meta-item').filter({ hasText: 'Graveyard' }),
  ).toContainText('Graveyard 0');
  await expect(opponentGraveyard(page)).toHaveCount(0);
  await expect(
    humanZone(page, 'Exile').getByRole('img', { name: 'Lab P1 Existing Graveyard Card' }),
  ).toBeVisible();

  await castDestroyTarget(page);
  await expect(permanent(page, 'Lab P2 Creature to Destroy')).toHaveCount(0);
  await expect(opponentGraveyard(page)).toHaveCount(0);
  await expect(
    opponentExile(page).getByRole('img', { name: 'Lab P2 Creature to Destroy' }),
  ).toBeVisible();
  await expect(page.getByText(/Lab Prepared Doom.*resolves/i).first()).toBeVisible();
});

test('Stone of Erech casts normally, pays {2}, sacrifices, exiles P2’s graveyard, and draws', async ({
  page,
}) => {
  await runScenario(
    page,
    'Stone of Erech: cast, pay {2}, sacrifice it, exile P2’s graveyard, and draw',
  );
  await expect(
    opponentGraveyard(page).getByRole('img', { name: 'Lab P2 Existing Graveyard Card' }),
  ).toBeVisible();
  await castAndResolve(page, 'Stone of Erech');

  const stone = permanent(page, 'Stone of Erech');
  await expect(stone).toHaveClass(/actionable/, { timeout: 15_000 });
  await stone.click();
  await expect(page.getByText(/Target 1 of 1/)).toBeVisible();
  await page.locator('.opponent[data-seat="P2"] > header').click();
  await expect(page.getByText(/All 1 target selected/)).toBeVisible();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();

  await expect(permanent(page, 'Stone of Erech')).toHaveCount(0);
  await expect(
    humanZone(page, 'Graveyard').getByRole('img', { name: 'Stone of Erech', exact: true }),
  ).toBeVisible();
  await expect(opponentGraveyard(page)).toHaveCount(0);
  await expect(
    opponentExile(page).getByRole('img', { name: 'Lab P2 Existing Graveyard Card' }),
  ).toBeVisible();
  await expect(handCard(page, 'Lab P1 Known Draw')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Stone of Erech.*draws? a card/i).first()).toBeVisible();
});

test('Stone of Erech replaces a normally cast destruction of an opponent creature', async ({
  page,
}) => {
  await runScenario(
    page,
    'Stone of Erech: a normally cast destroy spell exiles P2’s creature instead',
  );
  await castAndResolve(page, 'Stone of Erech');
  await expect(
    opponentGraveyard(page).getByRole('img', { name: 'Lab P2 Existing Graveyard Card' }),
  ).toBeVisible();

  await castDestroyTarget(page);
  await expect(permanent(page, 'Lab P2 Creature to Destroy')).toHaveCount(0);
  await expect(
    opponentGraveyard(page).getByRole('img', { name: 'Lab P2 Existing Graveyard Card' }),
  ).toBeVisible();
  await expect(
    opponentGraveyard(page).getByRole('img', { name: 'Lab P2 Creature to Destroy' }),
  ).toHaveCount(0);
  await expect(
    opponentExile(page).getByRole('img', { name: 'Lab P2 Creature to Destroy' }),
  ).toBeVisible();
  await expect(page.getByText(/Lab Prepared Doom.*resolves/i).first()).toBeVisible();
});
