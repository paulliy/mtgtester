import { createApp, type Component } from 'vue';
import { createPinia } from 'pinia';
import type { Router } from 'vue-router';
import './styles.css';

/**
 * Two apps from one source tree (ADR 0031, plan M6 task 1). The tester (the default) is the
 * spectator UI of brief §10: the server owns the engine and the AI calls, and this app is a view
 * over pushed WebSocket updates that never interprets a rule. `vite build --mode table` builds
 * the table app instead, which `serve:table` serves from its own origin. The mode is a build-time
 * constant, so each bundle holds only its own app: the branch not taken is removed.
 */
async function boot(): Promise<{ app: Component; router: Router }> {
  if (import.meta.env.MODE === 'table') {
    const [{ default: app }, { tableRouter }] = await Promise.all([
      import('./table/TableApp.vue'),
      import('./table/router'),
    ]);
    return { app, router: tableRouter };
  }
  const [{ default: app }, { router }] = await Promise.all([
    import('./App.vue'),
    import('./router'),
  ]);
  return { app, router };
}

void boot().then(({ app, router }) => {
  createApp(app).use(createPinia()).use(router).mount('#app');
});
