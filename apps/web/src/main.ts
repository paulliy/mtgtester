import { createApp, type Component } from 'vue';
import { createPinia } from 'pinia';
import type { Router } from 'vue-router';
import './styles.css';
import { applyStoredTheme } from './stores/theme';

// Before anything mounts, so a stored Day or Night choice is on the page at first paint.
applyStoredTheme();

/**
 * The site (the default build) is single player and the multiplayer tables under one router
 * (ADR 0053, plan section 7): the tester's views, and the tables' views under `/multiplayer`.
 * Single player talks to the game server, or with `VITE_LOCAL_GAMES=true` to a worker in the
 * browser; the views never interpret a rule (brief §10). `vite build --mode table` still builds
 * the tables alone, which `serve:table` serves from its own origin until the site moves to static
 * hosting. The mode is a build-time constant, so the branch not taken is removed.
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
    import('./SiteApp.vue'),
    import('./router'),
  ]);
  return { app, router };
}

void boot().then(async ({ app, router }) => {
  const site = createApp(app).use(createPinia()).use(router);
  // The first route decides which header the page draws (`SiteApp.vue`), so wait for it.
  await router.isReady();
  site.mount('#app');
});
