/**
 * The Web Worker entry for single player in the browser (ADR 0053). The web app loads this file
 * as a module worker; everything it does is in `worker-core.ts`.
 */

import { serveWorker, type WorkerScope } from './worker-core';

// The server's TypeScript build has no DOM or worker library, so the scope is read untyped.
serveWorker((globalThis as unknown as { self: WorkerScope }).self);
