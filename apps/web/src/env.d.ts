interface ImportMetaEnv {
  readonly DEV: boolean;
  /** `table` when built with `vite build --mode table` (the table app); the tester otherwise. */
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
