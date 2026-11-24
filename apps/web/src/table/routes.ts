import type { RouteRecordRaw } from 'vue-router';

/**
 * The multiplayer tables' routes (plan M6 task 1; ADR 0053, plan section 7): create a table, and
 * one page per table that is the lobby, the board and the post-game view in turn. They live under
 * `/multiplayer`, so the site's single player can own `/`; invite links from before that, at
 * `/t/<id>`, are sent on with their invite fragment. Lazy, like the tester's, so each loads on
 * demand. `meta.shell` tells the site to draw the tables' own header around them.
 */
export const TABLES_PATH = '/multiplayer';

/** A table's page; the invite code follows as the address fragment, which no request carries. */
export const tablePath = (tableId: string): string =>
  `${TABLES_PATH}/${encodeURIComponent(tableId)}`;

export const tableRoutes: RouteRecordRaw[] = [
  {
    path: TABLES_PATH,
    name: 'table-home',
    component: () => import('./TableHomeView.vue'),
    meta: { shell: 'table' },
  },
  {
    path: `${TABLES_PATH}/:id`,
    name: 'table',
    component: () => import('./TableView.vue'),
    meta: { shell: 'table' },
  },
  {
    path: '/t/:id',
    redirect: (to) => ({
      path: tablePath(String(to.params['id'])),
      hash: to.hash,
    }),
  },
];
