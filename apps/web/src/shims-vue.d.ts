/**
 * `tsc --build` is the repo-wide typechecker and does not understand single-file components.
 * This declares them as generic Vue components so TypeScript in `.ts` files typechecks
 * normally; template contents are checked by the Vue language server in the editor.
 */
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}

/** Optional endpoint override for isolated local UI runs and end-to-end environments. */
interface ImportMetaEnv {
  readonly VITE_GAME_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
