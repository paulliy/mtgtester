import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router';

/**
 * The table app's routes (plan M6 task 1): create a table, and one page per table that is the
 * lobby, the board and the post-game view in turn. Lazy, like the tester's, so each loads on
 * demand; the table bundle holds none of the tester's views.
 */
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'table-home', component: () => import('./TableHomeView.vue') },
  { path: '/t/:id', name: 'table', component: () => import('./TableView.vue') },
];

export const tableRouter = createRouter({
  history: createWebHistory(),
  routes,
});
