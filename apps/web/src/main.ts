import { createApp, h } from 'vue';

// Phase 0 stub. The spectator UI — board view, action log, timeline scrubber, playback
// modes with compute-ahead/hold-and-wait, deck import, stats, and the debug panel
// (brief §10, §13) — is built in Phase 4.
const app = createApp({
  render: () =>
    h(
      'main',
      {
        style:
          'font-family: system-ui, sans-serif; max-width: 42rem; margin: 3rem auto; padding: 0 1rem',
      },
      [
        h('h1', 'MTG Commander AI Simulator'),
        h('p', 'Foundations are in place. The spectator UI arrives in Phase 4.'),
      ],
    ),
});

const mountPoint = document.getElementById('app');
if (mountPoint) {
  app.mount(mountPoint);
}
