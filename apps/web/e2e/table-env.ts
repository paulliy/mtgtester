/** Settings shared by `playwright.table.config.ts` and the table specs. */
export const TABLE_PORTS = { main: 3111, clock: 3112, halt: 3113 } as const;
/** `TABLE_HOST_SECRET`, a development-mode setting, so the specs can create tables. */
export const TABLE_HOST_SECRET = 'table-e2e-host-secret-0001';
/** `TABLE_TEST_RNG_KEY`: every table game in these specs draws from this key. */
export const TABLE_TEST_KEY = '7e'.repeat(32);
