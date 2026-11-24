interface ImportMetaEnv {
  readonly DEV: boolean;
  /** `table` when built with `vite build --mode table` (the table app); the tester otherwise. */
  readonly MODE: string;
  /** `true` builds local games: single player runs in a browser worker (`lib/localMode.ts`). */
  readonly VITE_LOCAL_GAMES?: string;
  /** Where a local-games build reads the site card files; `/cards/` on the page's host by default. */
  readonly VITE_CARDS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
