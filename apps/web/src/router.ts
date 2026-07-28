import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';
import GameView from './views/GameView.vue';
import SetupView from './views/SetupView.vue';
import StatsView from './views/StatsView.vue';
import DebugView from './views/DebugView.vue';

/**
 * Two routes in Phase 4. The stats screen and the debug panel (brief §10.2, §13) are Phase 5
 * and attach here.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'setup', component: SetupView },
  { path: '/game', name: 'game', component: GameView },
  { path: '/stats', name: 'stats', component: StatsView },
  { path: '/debug', name: 'debug', component: DebugView },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});
