# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: pr02-limited-mechanics.spec.ts >> Lab Killian contract: two counted creature targets receive one discount
- Location: apps\web\e2e\pr02-limited-mechanics.spec.ts:82:1

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: locator.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for getByRole('button', { name: /Cast Lab Counted Target Contract \(\{2\}\{R\}\).*reduced for target slot 1/i })

```

```
Error: expect(received).toEqual(expected) // deep equality

- Expected  - 4
+ Received  + 0

  Array [
-   "changing-loyalty-viewer-replicate-two-original-countered",
-   "conclave-tribunal-viewer-convoke-szeras",
    "lab-killian-counted-target-creatures-contract",
-   "lab-killian-counted-target-zero-contract",
-   "lab-replicate-counted-targets-original-countered-contract",
  ]
```

# Test source

```ts
  1   | import { expect, test, type Locator, type Page } from '@playwright/test';
  2   | import { PR02_FOLLOW_UP_SCENARIO_IDS } from '../../../packages/server/src/cards/pr02-follow-up-scenarios';
  3   | 
  4   | test.describe.configure({ mode: 'default' });
  5   | test.use({ trace: 'on', screenshot: 'on' });
  6   | test.setTimeout(60_000);
  7   | 
  8   | const exercised = new Set<string>();
> 9   | test.afterAll(() => expect([...exercised].sort()).toEqual([...PR02_FOLLOW_UP_SCENARIO_IDS].sort()));
      |                                                   ^ Error: expect(received).toEqual(expected) // deep equality
  10  | 
  11  | async function runScenario(page: Page, title: string): Promise<void> {
  12  |   await page.goto('/card-test-lab');
  13  |   await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  14  |   const picker = page.locator('#scenario-select');
  15  |   await expect(picker).toBeVisible();
  16  |   await picker.selectOption({ label: title });
  17  |   const id = await picker.inputValue();
  18  |   expect(PR02_FOLLOW_UP_SCENARIO_IDS).toContain(id);
  19  |   expect(exercised.has(id), `${id} was run more than once`).toBe(false);
  20  |   exercised.add(id);
  21  |   await expect(page.getByRole('heading', { name: title })).toBeVisible();
  22  |   await page.getByRole('button', { name: 'Run scenario' }).click();
  23  |   await expect(page).toHaveURL(/\/game$/);
  24  |   await expect(page.getByText(title).first()).toBeVisible();
  25  | }
  26  | 
  27  | function permanent(page: Page, name: string) {
  28  |   return page
  29  |     .locator('.object:not(.board-card-leave-active), .seat .tile')
  30  |     .filter({ has: page.getByRole('img', { name, exact: true }) });
  31  | }
  32  | function handCard(page: Page, name: string) {
  33  |   return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
  34  | }
  35  | async function confirm(page: Page): Promise<void> {
  36  |   await page.getByRole('button', { name: 'Confirm' }).click();
  37  | }
  38  | async function passUntil(page: Page, target: Locator): Promise<void> {
  39  |   const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  40  |   await expect
  41  |     .poll(
  42  |       async () => {
  43  |         if (await target.isVisible()) return true;
  44  |         if (await pass.isVisible()) await pass.click({ timeout: 1_000 }).catch(() => undefined);
  45  |         return false;
  46  |       },
  47  |       { timeout: 15_000 },
  48  |     )
  49  |     .toBe(true);
  50  | }
  51  | 
  52  | test('Conclave Tribunal: convoke alongside Illuminor Szeras stateful mana', async ({ page }) => {
  53  |   await runScenario(page, 'Conclave Tribunal: convoke beside Illuminor Szeras mana');
  54  |   const tribunal = handCard(page, 'Conclave Tribunal');
  55  |   await expect(tribunal).toHaveClass(/actionable/);
  56  |   await tribunal.click();
  57  |   await expect(page.getByText(/Auto-pay/)).toBeVisible();
  58  |   await confirm(page);
  59  |   await passUntil(page, page.getByText(/game over/i).first());
  60  |   await expect(permanent(page, 'Conclave Tribunal')).toBeVisible();
  61  |   await expect(permanent(page, 'Illuminor Szeras').locator('.tap-badge')).toHaveText('TAP');
  62  |   await expect(permanent(page, 'Lab Convoke Bear').locator('.tap-badge')).toHaveText('TAP');
  63  |   await expect(permanent(page, 'Plains').locator('.tap-badge')).toHaveText('TAP');
  64  |   await expect(page.getByText(/Conclave Tribunal.*resolves/i).first()).toBeVisible();
  65  | });
  66  | 
  67  | test('Lab Killian contract: zero counted creature targets get no discount', async ({ page }) => {
  68  |   await runScenario(page, 'Lab contract: Killian receives no discount with zero counted targets');
  69  |   await handCard(page, 'Lab Counted Target Contract').click();
  70  |   const fullCast = page.getByRole('button', {
  71  |     name: 'Cast {4}{R}',
  72  |     exact: true,
  73  |   });
  74  |   await fullCast.click();
  75  |   await confirm(page);
  76  |   await page.getByRole('button', { name: 'Choose no more targets' }).click();
  77  |   await passUntil(page, page.getByText(/game over/i).first());
  78  |   await expect(permanent(page, 'Lab Ox')).toBeVisible();
  79  |   await expect(permanent(page, 'Lab Convoke Bear')).toBeVisible();
  80  |   await expect(permanent(page, 'Mountain').locator('.tap-badge')).toHaveText('TAP');
  81  |   await expect(permanent(page, 'Forest').locator('.tap-badge')).toHaveCount(4);
  82  | });
  83  | 
  84  | test('Lab Killian contract: two counted creature targets receive one discount', async ({
  85  |   page,
  86  | }) => {
  87  |   await runScenario(page, 'Lab contract: Killian discounts once for two counted creature targets');
  88  |   await handCard(page, 'Lab Counted Target Contract').click();
  89  |   await page
  90  |     .getByRole('button', {
  91  |       name: /Cast.*reduced for target slot 1.*\{2\}\{R\}/i,
  92  |     })
  93  |     .click();
  94  |   await confirm(page);
  95  |   await page.getByRole('button', { name: 'Target Lab Ox' }).click();
  96  |   await page.getByRole('button', { name: 'Target Lab Convoke Bear' }).click();
  97  |   await page.getByRole('button', { name: 'Choose no more targets' }).click();
  98  |   await passUntil(page, page.getByText(/game over/i).first());
  99  |   await expect(permanent(page, 'Lab Ox')).toHaveCount(0);
  100 |   await expect(permanent(page, 'Lab Convoke Bear')).toHaveCount(0);
  101 |   await expect(permanent(page, 'Mountain').locator('.tap-badge')).toHaveText('TAP');
  102 |   await expect(permanent(page, 'Forest').locator('.tap-badge')).toHaveCount(2);
  103 | });
  104 | 
  105 | test('Changing Loyalty: replicate twice, counter the original, keep both copies', async ({
  106 |   page,
  107 | }) => {
  108 |   await runScenario(
  109 |     page,
```