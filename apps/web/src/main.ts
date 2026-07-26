import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './styles.css';

// The spectator UI (brief §10). The server owns the engine and the AI calls; this app is a
// view over pushed WebSocket updates and never interprets a rule.
createApp(App).use(createPinia()).use(router).mount('#app');
