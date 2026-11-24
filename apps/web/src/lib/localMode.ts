/**
 * Local games (ADR 0053): a build with `VITE_LOCAL_GAMES=true` plays single player and watch
 * games in a Web Worker in the visitor's browser, with no game server. Batch, Stats and the
 * Debug panel need the server's database or the AI, so that build shows them as coming soon or
 * leaves them out. The flag is a build-time constant, so each build holds only its own path.
 */

export const LOCAL_GAMES = import.meta.env.VITE_LOCAL_GAMES === 'true';

/**
 * True when this browser can start a module worker. The option's `type` is read only by
 * browsers that support module workers, so the getter runs only there; the worker itself never
 * loads (its URL is refused), which is why the constructor's error is ignored.
 */
export function supportsModuleWorkers(): boolean {
  if (typeof Worker === 'undefined') return false;
  let supported = false;
  const probe = {
    get type(): WorkerType {
      supported = true;
      return 'module';
    },
  };
  try {
    new Worker('blob://', probe).terminate();
  } catch {
    // Expected: the probe URL is never meant to load.
  }
  return supported;
}
