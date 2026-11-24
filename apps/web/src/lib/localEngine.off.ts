/**
 * What `lib/localEngine.ts` becomes in a build without local games (`vite.config.ts` swaps it
 * in), so the server and table builds never emit the game worker. Nothing here is reached: the
 * callers check `LOCAL_GAMES` first.
 */

import type * as LocalEngine from './localEngine';

const off = (): never => {
  throw new Error('This build does not run games in the browser.');
};

export const cardsUrl: typeof LocalEngine.cardsUrl = off;
export const engineReady: typeof LocalEngine.engineReady = off;
export const workerRequest: typeof LocalEngine.workerRequest = off;
export const onFrame: typeof LocalEngine.onFrame = off;
export const sendFrame: typeof LocalEngine.sendFrame = off;
export const stopEngine: typeof LocalEngine.stopEngine = off;
