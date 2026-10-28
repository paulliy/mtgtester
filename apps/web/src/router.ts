import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import GameView from './views/GameView.vue';
import SetupView from './views/SetupView.vue';
import StatsView from './views/StatsView.vue';
import DebugView from './views/DebugView.vue';
import BatchSetupView from './views/BatchSetupView.vue';
import BatchResultsView from './views/BatchResultsView.vue';
import CardTestLabView from './views/CardTestLabView.vue';

/**
 * Two routes in Phase 4. The stats screen and the debug panel (brief §10.2, §13) are Phase 5
 * and attach here.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'setup', component: SetupView },
  { path: '/game', name: 'game', component: GameView },
  { path: '/stats', name: 'stats', component: StatsView },
  { path: '/debug', name: 'debug', component: DebugView },
  { path: '/batch', name: 'batch', component: BatchSetupView },
  { path: '/batch/:id', name: 'batch-results', component: BatchResultsView },
  ...(import.meta.env['DEV'] === true
    ? [
        { path: '/card-test-lab', name: 'card-test-lab', component: CardTestLabView },
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
