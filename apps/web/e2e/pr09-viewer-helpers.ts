import { expect, type Locator, type Page } from '@playwright/test';
import type { ServerToClientMessage } from '../../../packages/shared/src/index';

export function hand(page: Page, name: string): Locator {
  return page.locator('.hand-card:not(.hand-card-leave-active)', { hasText: name });
}
export function permanent(page: Page, seat: string, name: string): Locator {
  const zone = seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`;
  return page
    .locator(`${zone} .object:not(.board-card-leave-active)`)
    .filter({ has: page.getByRole('img', { name, exact: true }) });
}
export function seatZone(page: Page, seat: string, name: string): Locator {
  const area = seat === 'P1' ? '.human-zone' : `.opponent[data-seat="${seat}"]`;
  return page
    .locator(`${area} .zone`)
    .filter({ has: page.getByRole('heading', { name: new RegExp(`^${name} \\(`) }) });
}

/** Keep decision IDs live: passing twice for one request can advance a later empty stack. */
export function priorityHelpers(
  frontiers: WeakMap<Page, { requestId: string; stackSize: number }>,
  timeout: number,
  dismissReminder = false,
) {
  async function advanceUntil(page: Page, target: Locator, stackOnly: boolean): Promise<void> {
    const frontier = frontiers.get(page)!;
    const pass = page
      .getByRole('button', { name: 'Pass priority', exact: true })
      .and(page.locator('button:enabled'));
    const reminder = page.getByRole('button', { name: 'Pass anyway', exact: true });
    let submitted = '';
    await expect
      .poll(
        async () => {
          if (dismissReminder && (await reminder.isVisible())) await reminder.click();
          if (await target.isVisible()) return true;
          if (
            (!stackOnly || (frontier.stackSize > 0 && frontier.requestId !== submitted)) &&
            (await pass.isVisible())
          ) {
            const requestId = frontier.requestId;
            try {
              await pass.click({ timeout: 1_000 });
              submitted = requestId;
            } catch {
              // A new decision can replace the button between observing and clicking it.
            }
          }
          return false;
        },
        { timeout },
      )
      .toBe(true);
  }
  const passUntil = (page: Page, target: Locator) => advanceUntil(page, target, false);
  const passStackUntil = (page: Page, target: Locator) => advanceUntil(page, target, true);
  async function attack(page: Page, attacker: string): Promise<void> {
    const declare = page.getByRole('button', { name: /Declare attackers/ });
    await passUntil(page, declare);
    await declare.click();
    await page
      .locator('.combat-assignment-row')
      .filter({ hasText: attacker })
      .getByRole('button', { name: 'P2', exact: true })
      .click();
    await page.getByRole('button', { name: 'Confirm attacks', exact: true }).click();
  }
  return { passUntil, passStackUntil, attack };
}

/** Observe the real socket without replacing the application's transport. */
export function observePriority(page: Page): { requestId: string; stackSize: number } {
  const frontier = { requestId: '', stackSize: 0 };
  page.on('websocket', (socket) =>
    socket.on('framereceived', ({ payload }) => {
      try {
        const frame = JSON.parse(payload.toString()) as ServerToClientMessage;
        if (frame.type === 'playerActionRequired') {
          frontier.requestId = frame.payload.request.requestId;
          frontier.stackSize = frame.payload.request.state.stack.length;
        } else if (frame.type === 'playerStateSnapshot') {
          frontier.stackSize = frame.payload.state.stack.length;
        }
      } catch {
        /* Ignore non-JSON websocket frames. */
      }
    }),
  );
  return frontier;
}

export async function selectScenario(page: Page, id: string, title: string): Promise<void> {
  await page.goto('/card-test-lab');
  await expect(page.getByRole('heading', { name: 'Card Test Lab' })).toBeVisible();
  const picker = page.locator('#scenario-select');
  await picker.selectOption({ label: title });
  expect(await picker.inputValue()).toBe(id);
}

export async function launchScenario(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'Run scenario' }).click();
  await expect(page).toHaveURL(/\/game$/);
  await expect(page.getByText(title).first()).toBeVisible();
}
