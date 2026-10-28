/**
 * `@mtg/shared/presentation` — player-facing wording for engine options. Deliberately NOT
 * re-exported from the package index: it is a separate subpath so the web app can be barred
 * from importing it once the server computes these strings (ADR 0032).
 */
export { actionLabel } from './labels';
export {
  actionCost,
  actionData,
  groupXActions,
  paymentSourceNames,
  paymentSourceSummary,
  pendingSummary,
} from './actions';
export type { XActionGroup } from './actions';
