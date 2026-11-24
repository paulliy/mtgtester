import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { LOCAL_GAMES } from './lib/localMode';
import { IMPORT_REPORT_PATH } from './lib/navigation';
import { tableRoutes } from './table/routes';

/**
 * The site's routes: single player, and the multiplayer tables under `/multiplayer`. Every view loads on demand (plan M6 task 1), so a view is a chunk of its
 * own and the table app's bundle can be checked to hold none of them.
 */
const comingSoon = () => import('./views/ComingSoonView.vue');

/**
 * Stats, Batch and Debug read the server's database and logs. A local-games build plays in the
 * browser (`lib/localMode.ts`), so Stats and Batch say they are coming soon and Debug is absent.
 */
const serverRoutes: RouteRecordRaw[] = LOCAL_GAMES
  ? [
      { path: '/stats', name: 'stats', component: comingSoon },
      { path: '/batch', name: 'batch', component: comingSoon },
      { path: '/batch/new', name: 'batch-new', component: comingSoon },
      { path: '/batch/:id', name: 'batch-results', component: comingSoon },
    ]
  : [
      { path: '/stats', name: 'stats', component: () => import('./views/StatsView.vue') },
      { path: '/debug', name: 'debug', component: () => import('./views/DebugView.vue') },
      // `/batch/new` is listed first so `new` is never read as a run id.
      {
        path: '/batch/new',
        name: 'batch-new',
        component: () => import('./views/BatchSetupView.vue'),
      },
      // One record serves the list (`/batch`) and a chosen run (`/batch/:id`), so picking a run
      // swaps the route without remounting the page.
      {
        path: '/batch/:id?',
        name: 'batch-results',
        component: () => import('./views/BatchRunsView.vue'),
      },
      // The last refused import and the work order for its unmodeled cards (ADR 0054). It asks
      // the server about each card, so a local-games build has no report.
      {
        path: IMPORT_REPORT_PATH,
        name: 'import-report',
        component: () => import('./views/ImportReportView.vue'),
      },
    ];

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'setup', component: () => import('./views/SetupView.vue') },
  { path: '/game', name: 'game', component: () => import('./views/GameView.vue') },
  ...serverRoutes,
  // The multiplayer tables, on their own paths with their own header (`SiteApp.vue`).
  ...tableRoutes,
  ...(import.meta.env['DEV'] === true
    ? [
        {
          path: '/card-test-lab',
          name: 'card-test-lab',
          component: () => import('./views/CardTestLabView.vue'),
        },
        // The deal UI with sample data and no game (ADR 0035).
        {
          path: '/deals-preview',
          name: 'deals-preview',
          // Loaded on demand, so its sample data never ships in a production bundle.
          component: () => import('./views/DealsPreviewView.vue'),
        },
      ]
    : []),
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
