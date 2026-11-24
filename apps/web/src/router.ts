import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import { LOCAL_GAMES } from './lib/localMode';

/**
 * The tester's routes. Every view loads on demand (plan M6 task 1), so a view is a chunk of its
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
      { path: '/batch/:id', name: 'batch-results', component: comingSoon },
    ]
  : [
      { path: '/stats', name: 'stats', component: () => import('./views/StatsView.vue') },
      { path: '/debug', name: 'debug', component: () => import('./views/DebugView.vue') },
      { path: '/batch', name: 'batch', component: () => import('./views/BatchSetupView.vue') },
      {
        path: '/batch/:id',
        name: 'batch-results',
        component: () => import('./views/BatchResultsView.vue'),
      },
    ];

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'setup', component: () => import('./views/SetupView.vue') },
  { path: '/game', name: 'game', component: () => import('./views/GameView.vue') },
  ...serverRoutes,
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
