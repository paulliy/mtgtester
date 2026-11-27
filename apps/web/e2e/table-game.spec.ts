import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { TABLE_HOST_SECRET, TABLE_PORTS, TABLE_TEST_KEY } from './table-env';

/**
 * Tables in the browser (plan M6), against `serve:table --dev` serving the built table bundle
 * from its own origin (`playwright.table.config.ts`). Each scenario creates a table with the
 * host secret, seats people through the lobby, and plays through the table board.
 */

const DECKS = {
  P1: readFileSync('apps/web/e2e/fixtures/table-deck-p1.txt', 'utf8'),
  P2: readFileSync('apps/web/e2e/fixtures/table-deck-p2.txt', 'utf8'),
};

/**
 * Content Security Policy refusals seen by any table page. The served policy allows only the
 * bundle's own scripts and Scryfall's image and search hosts; a refusal means the app needs
 * something the policy blocks, or the policy has a gap the app relies on.
 */
const cspViolations: string[] = [];
const watchCsp = (page: Page): void => {
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy/i.test(message.text()))
      cspViolations.push(message.text());
  });
};

test.afterEach(() => {
  expect(cspViolations).toEqual([]);
  cspViolations.length = 0;
});

/** Every board starts with the log, piles and opponents' zones open, as in the tester specs. */
async function openPage(browser: Browser, origin: string): Promise<Page> {
  const context = await browser.newContext({ baseURL: origin });
  context.on('page', watchCsp);
  await context.addInitScript(() => {
    try {
      localStorage.setItem('mtg.playerGameInfoOpen', 'true');
      localStorage.setItem('mtg.playerOpponentZonesOpen', 'true');
      for (const pile of ['lands', 'graveyard', 'exile']) {
        localStorage.setItem(`mtg.playerPile.${pile}`, 'true');
      }
    } catch {
      // Storage blocked: the specs that read the log say so.
    }
  });
  return context.newPage();
}

/** The host creates a table, joins it by name, and takes P1 with the first fixture deck. */
async function hostTable(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('host-secret').fill(TABLE_HOST_SECRET);
  await page.getByTestId('create-table').click();
  await expect(page).toHaveURL(/\/multiplayer\/[\w-]+#/);
  await page.getByTestId('display-name').fill(name);
  await page.getByTestId('join').click();
  await expect(page.getByTestId('lobby')).toBeVisible();
  await page.getByTestId('claim-seat').selectOption('P1');
  await page.getByTestId('decklist').fill(DECKS.P1);
  await page.getByTestId('request-seat').click();
  await page.getByTestId('approve-P1').click();
  await expect(page.getByTestId('seat-P1')).toContainText(name);
  return page.getByTestId('invite-link').inputValue();
}

/** A guest opens the invite, joins by name, and asks for P2; the host approves. */
async function joinAsGuest(guest: Page, host: Page, invite: string, name: string): Promise<void> {
  await guest.goto(invite);
  await guest.getByTestId('display-name').fill(name);
  await guest.getByTestId('join').click();
  await guest.getByTestId('claim-seat').selectOption('P2');
  await guest.getByTestId('decklist').fill(DECKS.P2);
  await guest.getByTestId('request-seat').click();
  await expect(guest.getByTestId('claim-pending')).toBeVisible();
  await host.getByTestId('approve-P2').click();
  await expect(guest.getByTestId('seat-P2')).toContainText(name);
}

async function fillWithBotsAndStart(host: Page, seats: readonly string[]): Promise<void> {
  for (const seat of seats) await host.getByTestId(`make-bot-${seat}`).click();
  await expect(host.getByTestId('start')).toBeEnabled();
  await host.getByTestId('start').click();
}

interface Plan {
  /** Play a basic land whenever one is offered. */
  lands: boolean;
  /** Lands this player has played. */
  played?: number;
  /** Tried first on each step; returns what it did, or null to fall through. */
  custom?: (page: Page) => Promise<string | null>;
}

/**
 * Click `target` if it is still there. A decision panel can show a moment longer than its
 * decision lasts: the next frame moves the decision on (to another seat, or past this step) and
 * takes the button away. A click on it would wait out its whole timeout while the other players
 * go undriven, so a button that leaves the page counts as nothing done this step.
 */
async function clickIfStill(target: Locator): Promise<boolean> {
  try {
    await target.click({ timeout: 2_000 });
    return true;
  } catch (error) {
    if (await target.isVisible()) throw error;
    return false;
  }
}

/**
 * One step for a player: keep the opening hand, run the plan's own action, play a basic land,
 * answer combat with no attackers or blockers, and otherwise pass. Returns what it did, or null
 * when nothing is being asked of this player.
 */
async function step(page: Page, plan: Plan): Promise<string | null> {
  const keep = page.getByRole('button', { name: /^Keep \d+$/ });
  if ((await keep.isVisible()) && (await clickIfStill(keep))) return 'keep';
  if (!(await page.locator('.decision').isVisible())) return null;
  const custom = await plan.custom?.(page);
  if (custom !== null && custom !== undefined) return custom;
  // Cleanup with more than seven cards (CR 514.1): these plans only play lands and pass, so a
  // long game fills a hand. Discard the first card offered, by clicking it in the hand.
  if (
    await page
      .getByText(/^Discard down to seven cards/)
      .first()
      .isVisible()
  ) {
    const discard = page.locator('.hand-card.actionable').first();
    if (await clickIfStill(discard)) {
      const confirm = page.locator('.tray-actions').getByRole('button', { name: 'Confirm' });
      if (await confirm.isVisible({ timeout: 500 }).catch(() => false)) await confirm.click();
      return 'discard';
    }
  }
  if (plan.lands) {
    const land = page
      .locator('.playable-now')
      .getByRole('button', { name: /^Play (Plains|Island|Swamp|Mountain|Forest)\b/ })
      .first();
    if ((await land.isVisible()) && (await clickIfStill(land))) {
      await expect(land).toBeHidden();
      plan.played = (plan.played ?? 0) + 1;
      return 'land';
    }
  }
  const combat = page.getByRole('button', { name: /^Confirm (attacks|blocks)$/ });
  if ((await combat.isVisible()) && (await clickIfStill(combat))) return 'combat';
  const pass = page.getByRole('button', { name: 'Pass priority', exact: true });
  if ((await pass.isVisible()) && (await clickIfStill(pass))) {
    const anyway = page.getByRole('button', { name: 'Pass anyway', exact: true });
    if (await anyway.isVisible({ timeout: 300 }).catch(() => false)) await anyway.click();
    return 'pass';
  }
  return null;
}

/** Drive the players until `done` holds, failing after `limit` rounds. */
async function playUntil(
  players: ReadonlyArray<{ page: Page; plan: Plan }>,
  done: () => Promise<boolean>,
  limit = 600,
): Promise<void> {
  for (let round = 0; round < limit; round++) {
    if (await done()) return;
    let acted = false;
    for (const { page, plan } of players) {
      if ((await step(page, plan)) !== null) acted = true;
    }
    if (!acted) await players[0]!.page.waitForTimeout(200);
  }
  for (const [index, { page }] of players.entries()) {
    await page.screenshot({ path: `test-results/table/stuck-${index}.png`, fullPage: true });
  }
  throw new Error('The table did not reach the expected point.');
}

interface Request {
  turn: number;
  step: string | null;
  activePlayer: string;
  actions: string[];
  /** Objects on the stack when the decision was sent. */
  stack: number;
}

/** Every decision the server puts to this page's seat, in order. */
function recordRequests(page: Page): Request[] {
  const requests: Request[] = [];
  page.on('websocket', (socket) =>
    socket.on('framereceived', (frame) => {
      const message = JSON.parse(String(frame.payload)) as {
        type: string;
        payload: {
          request?: Request & { legalActions: { description: string }[] };
          state?: { stack: unknown[] };
        };
      };
      const request = message.payload.request;
      if (message.type !== 'playerActionRequired' || request === undefined) return;
      requests.push({
        turn: request.turn,
        step: request.step,
        activePlayer: request.activePlayer,
        actions: request.legalActions.map((action) => action.description),
        stack: message.payload.state?.stack.length ?? 0,
      });
    }),
  );
  return requests;
}

/** "Waiting on Bob — 5:03" as milliseconds. */
async function waitingMs(page: Page): Promise<number> {
  const text = await page.getByTestId('waiting-on').innerText();
  const match = /(\d+):(\d{2})\s*$/.exec(text);
  if (match === null) throw new Error(`No clock in "${text}"`);
  return (Number(match[1]) * 60 + Number(match[2])) * 1000;
}

test('two people and two bots play a table game through to the post-game replay', async ({
  browser,
}) => {
  test.setTimeout(600_000);
  const origin = `http://127.0.0.1:${TABLE_PORTS.main}`;
  const host = await openPage(browser, origin);
  let guest = await openPage(browser, origin);
  const hostRequests = recordRequests(host);
  const invite = await hostTable(host, 'Ann');
  await joinAsGuest(guest, host, invite, 'Bob');
  const tablePath = new URL(invite).pathname;
  await fillWithBotsAndStart(host, ['P3', 'P4']);

  for (const page of [host, guest]) {
    await expect(page.getByTestId('table-bar')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('bar-seat-P1')).toContainText('Ann');
    await expect(page.getByTestId('bar-seat-P2')).toContainText('Bob');
    await expect(page.getByTestId('bar-seat-P3')).toContainText('bot');
  }

  // Each keeps, plays a land and passes.
  let hostPlan: Plan = { lands: true };
  const guestPlan: Plan = { lands: true };
  await playUntil(
    [
      { page: host, plan: hostPlan },
      { page: guest, plan: guestPlan },
    ],
    async () => (hostPlan.played ?? 0) >= 1 && (guestPlan.played ?? 0) >= 1,
  );
  for (const page of [host, guest]) {
    await expect(page.locator('.log .line', { hasText: /P1\s*plays Swamp/ }).first()).toBeVisible();
    await expect(page.locator('.log .line', { hasText: /P2\s*plays / }).first()).toBeVisible();
  }

  // The bar names whoever the table waits on and counts their clock down.
  await playUntil(
    [{ page: host, plan: hostPlan }],
    async () => (await host.getByTestId('waiting-on').textContent())?.includes('Bob') ?? false,
  );
  const before = await waitingMs(host);
  await expect.poll(() => waitingMs(host), { timeout: 10_000 }).toBeLessThan(before);
  await expect(host.getByTestId('my-clock')).toContainText(/Your time \d+:\d{2} · bank \d+:\d{2}/);

  // Bob closes the tab and comes back: the seat token resumes the seat on the same board.
  await guest.close();
  await expect(host.getByTestId('bar-seat-P2').locator('.dot')).not.toHaveClass(/\bon\b/);
  guest = await guest.context().newPage();
  // Through an invite path from before the tables moved under /multiplayer: it is sent on.
  await guest.goto(tablePath.replace(/^\/multiplayer\//, '/t/'));
  await expect(guest).toHaveURL(new RegExp(`${tablePath}$`));
  await expect(guest.getByTestId('table-bar')).toBeVisible();
  await expect(guest.locator('.decision')).toBeVisible({ timeout: 30_000 });
  await expect(host.getByTestId('bar-seat-P2').locator('.dot')).toHaveClass(/\bon\b/);
  await expect(guest.getByTestId('join-form')).toHaveCount(0);

  // A manual-mana tap pays for a spell: tap a Swamp by hand, then cast Phyrexian Arena.
  let arenaCast = false;
  hostPlan = {
    lands: true,
    custom: async (page) => {
      if (arenaCast) return null;
      const cast = page
        .locator('.playable-now')
        .getByRole('button', { name: /^Cast Phyrexian Arena/ });
      if (!(await cast.isVisible())) return null;
      // A tile stands for every untapped land of one name, so the request is what shows the tap:
      // the next one offers one Swamp fewer.
      const swamps = (request: Request | undefined) =>
        request?.actions.filter((action) => action === 'Swamp: add {B}').length ?? 0;
      const before = hostRequests.length;
      const untapped = swamps(hostRequests.at(-1));
      await page.locator('.mana-tap').first().click();
      await expect.poll(() => hostRequests.length).toBeGreaterThan(before);
      expect(swamps(hostRequests.at(-1))).toBe(untapped - 1);
      await cast.click();
      await page.locator('.tray-actions').getByRole('button', { name: 'Confirm' }).click();
      arenaCast = true;
      return 'arena';
    },
  };
  await playUntil(
    [
      { page: host, plan: hostPlan },
      { page: guest, plan: guestPlan },
    ],
    async () => arenaCast,
  );
  await expect(host.locator('.log .line', { hasText: 'Phyrexian Arena resolves' })).toBeVisible({
    timeout: 30_000,
  });

  // Smart yield: Fell the Profane is an instant, so every window offers it. Yield it once and the
  // quiet windows of the next opponent's turn (upkeep, draw) are no longer offered.
  let yieldedAt = -1;
  hostPlan = {
    lands: true,
    custom: async (page) => {
      if (yieldedAt >= 0) return null;
      const last = hostRequests.at(-1);
      if (last === undefined || last.activePlayer === 'P1' || last.step !== 'upkeep') return null;
      const cast = page
        .locator('.playable-now')
        .getByRole('button', { name: /^Cast Fell the Profane/ });
      if (!(await cast.isVisible())) return null;
      await cast.click();
      await page.locator('.tray-actions').getByRole('button', { name: 'Smart yield' }).click();
      yieldedAt = hostRequests.length;
      return 'yield';
    },
  };
  await playUntil(
    [
      { page: host, plan: hostPlan },
      { page: guest, plan: guestPlan },
    ],
    async () => {
      if (yieldedAt < 0) return false;
      const after = hostRequests.slice(yieldedAt);
      const yieldTurn = hostRequests[yieldedAt - 1]!.turn;
      return after.some((request) => request.turn >= yieldTurn + 2);
    },
  );
  // Yielded in an opponent's upkeep, which was offered: that turn's draw and the next turn's
  // upkeep and draw are quiet, and none of them is offered now.
  const yieldTurn = hostRequests[yieldedAt - 1]!.turn;
  // A window is quiet only with an empty stack: an opponent's spell or ability on it is a new
  // reason to reconsider, which smart yield offers again by design.
  const opponentsBeginning = (request: Request) =>
    request.activePlayer !== 'P1' && (request.step === 'upkeep' || request.step === 'draw');
  const quietWindow = (request: Request) => opponentsBeginning(request) && request.stack === 0;
  expect(opponentsBeginning(hostRequests[yieldedAt - 1]!)).toBe(true);
  const offeredAfter = hostRequests
    .slice(yieldedAt)
    .filter((request) => request.turn <= yieldTurn + 1 && quietWindow(request));
  expect(offeredAfter).toEqual([]);

  // The host ends the game; both see the post-game view with the key and step the replay back.
  await host.getByTestId('table-bar').getByTestId('abandon').click();
  for (const page of [host, guest]) {
    await expect(page.getByTestId('post-game')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('ending')).toHaveText('The host ended the game.');
    await expect(page.getByTestId('rng-key')).toHaveText(TABLE_TEST_KEY);
    const turn = page.getByTestId('replay-turn');
    await expect(turn).toHaveText(/^Turn \d+$/);
    const last = Number((await turn.innerText()).replace('Turn ', ''));
    await page.getByTestId('replay-back').click();
    await expect(turn).not.toHaveText(`Turn ${last}`);
    expect(Number((await turn.innerText()).replace('Turn ', ''))).toBeLessThan(last);
  }
});

test('a seat out of time goes to the fallback bot until its player takes it back', async ({
  browser,
}) => {
  // This table's clock is relaxed divided by 120: a 10-second bank and a tiny allowance.
  const host = await openPage(browser, `http://127.0.0.1:${TABLE_PORTS.clock}`);
  const statuses: Array<{ seat: string; fallback: boolean }> = [];
  host.on('websocket', (socket) =>
    socket.on('framereceived', (frame) => {
      const message = JSON.parse(String(frame.payload)) as {
        type: string;
        payload: { seat: string; fallback: boolean };
      };
      if (message.type === 'seatStatus') statuses.push(message.payload);
    }),
  );
  await hostTable(host, 'Ann');
  await fillWithBotsAndStart(host, ['P2', 'P3', 'P4']);
  await expect(host.getByTestId('my-clock')).toBeVisible({ timeout: 60_000 });

  // Ann answers nothing: her bank runs out, decisions time out, and the fallback bot takes over.
  const badge = host.getByTestId('bar-seat-P1').locator('.badge');
  await expect(badge).toHaveText('bot (away)', { timeout: 60_000 });
  // Her bank is spent, so three quick timeouts hand the seat straight back to the bot; the
  // server's own status frames show that she held it in between.
  const before = statuses.length;
  await host.getByTestId('take-back').click();
  await expect
    .poll(() => statuses.slice(before).some((status) => status.seat === 'P1' && !status.fallback))
    .toBe(true);
});

test('a forced engine halt opens the post-game view', async ({ browser }) => {
  // This table's engine may do one event per step, so the game halts as soon as it starts.
  const host = await openPage(browser, `http://127.0.0.1:${TABLE_PORTS.halt}`);
  await hostTable(host, 'Ann');
  await fillWithBotsAndStart(host, ['P2', 'P3', 'P4']);
  await expect(host.getByTestId('post-game')).toBeVisible({ timeout: 60_000 });
  await expect(host.getByTestId('ending')).toHaveText('The game stopped before it was decided.');
  await expect(host.getByTestId('rng-key')).toHaveText(TABLE_TEST_KEY);
});

test('a guest takes a seat with a premade deck instead of pasting one', async ({ browser }) => {
  const host = await openPage(browser, `http://127.0.0.1:${TABLE_PORTS.main}`);
  const guest = await openPage(browser, `http://127.0.0.1:${TABLE_PORTS.main}`);
  const invite = await hostTable(host, 'Ada');
  await guest.goto(invite);
  await guest.getByTestId('display-name').fill('Grace');
  await guest.getByTestId('join').click();
  await guest.getByTestId('claim-seat').selectOption('P2');

  const picker = guest.getByTestId('premade-deck');
  await expect(picker.locator('option', { hasText: 'Token Triumph' })).toHaveCount(1);
  await picker.selectOption('token-triumph');
  await expect(guest.getByTestId('decklist')).toHaveValue(/Emmara, Soul of the Accord/);
  // Editing the list makes it the player's own again.
  await guest.getByTestId('decklist').fill(DECKS.P2);
  await expect(picker).toHaveValue('');
  await picker.selectOption('token-triumph');

  await guest.getByTestId('request-seat').click();
  await expect(guest.getByTestId('claim-pending')).toBeVisible();
  await expect(guest.getByTestId('problems')).toHaveCount(0);
  await host.getByTestId('approve-P2').click();
  await expect(guest.getByTestId('seat-P2')).toContainText('Grace');
});

test('after a mulligan the hand screen waits for the others, and the host can unstick a seat', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const origin = `http://127.0.0.1:${TABLE_PORTS.main}`;
  const host = await openPage(browser, origin);
  const guest = await openPage(browser, origin);
  const invite = await hostTable(host, 'Ann');
  await joinAsGuest(guest, host, invite, 'Bob');
  await fillWithBotsAndStart(host, ['P3', 'P4']);

  // Players answer keep-or-mulligan in turn order. Whoever is asked first goes first; the other
  // has not been asked yet, and answers nothing in this test.
  const keepOf = (page: Page) => page.getByRole('button', { name: /^Keep \d+$/ });
  await expect
    .poll(async () => (await keepOf(host).isVisible()) || (await keepOf(guest).isVisible()), {
      timeout: 60_000,
    })
    .toBe(true);
  const hostFirst = await keepOf(host).isVisible();
  const first = hostFirst ? host : guest;
  const second = hostFirst ? guest : host;
  const secondSeat = hostFirst ? 'P2' : 'P1';
  const secondName = hostFirst ? 'Bob' : 'Ann';

  // The mulligan keeps the hand screen up, with no choices, while the others decide.
  await first.getByRole('button', { name: 'Mulligan', exact: true }).click();
  await expect(first.getByTestId('mulligan-waiting')).toBeVisible();
  await expect(keepOf(first)).toBeHidden();
  await expect(first.locator('.opening-hand')).toBeVisible();
  await expect(keepOf(second)).toBeVisible({ timeout: 30_000 });
  // Still waiting while the other player thinks: the screen did not close onto the board.
  await expect(first.getByTestId('mulligan-waiting')).toBeVisible();

  // The host has the bot answer the stuck player's decision, once.
  await host.getByTestId('stuck-menu').click();
  await host.getByTestId(`resolve-seat-${secondSeat}`).click();
  await host.getByRole('button', { name: 'Let the bot decide' }).click();
  await expect(host.getByText(`Asked the bot to decide for ${secondName}.`)).toBeVisible();

  // With everyone answered, the first player is dealt a new hand and asked again.
  await expect(first.getByText('Opening hand · after 1 mulligan')).toBeVisible({
    timeout: 30_000,
  });
  await expect(keepOf(first)).toBeVisible();
  await expect(first.getByTestId('mulligan-waiting')).toBeHidden();
});

test('a host running the table without a seat can still unstick a player', async ({ browser }) => {
  const origin = `http://127.0.0.1:${TABLE_PORTS.main}`;
  const host = await openPage(browser, origin);
  const guest = await openPage(browser, origin);
  // The host creates the table and never joins by name or takes a seat.
  await host.goto('/');
  await host.getByTestId('host-secret').fill(TABLE_HOST_SECRET);
  await host.getByTestId('create-table').click();
  await expect(host).toHaveURL(/\/multiplayer\/[\w-]+#/);
  const invite = await host.getByTestId('invite-link').inputValue();
  await joinAsGuest(guest, host, invite, 'Bob');
  await fillWithBotsAndStart(host, ['P1', 'P3', 'P4']);

  // Bob is asked to keep or mulligan and answers nothing; the host has the bot answer for him.
  await expect(guest.getByRole('button', { name: /^Keep \d+$/ })).toBeVisible({ timeout: 60_000 });
  await expect(host.getByTestId('table-bar')).toBeVisible();
  await host.getByTestId('stuck-menu').click();
  await host.getByTestId('resolve-seat-P2').click();
  await host.getByRole('button', { name: 'Let the bot decide' }).click();
  await expect(host.getByText('Asked the bot to decide for Bob.')).toBeVisible();
  // Bob's first decision is answered either way: a keep closes his hand screen, a mulligan
  // retitles it ("Mulligan chosen", then "after 1 mulligan").
  await expect(guest.getByRole('heading', { name: 'Opening hand', exact: true })).toBeHidden({
    timeout: 30_000,
  });
  // Without a seat, ending the game stays in the lobby's host panel, not repeated in the bar.
  await expect(host.getByTestId('host-panel').getByTestId('abandon')).toBeVisible();
  await expect(host.getByTestId('table-bar').getByTestId('abandon')).toHaveCount(0);
});
