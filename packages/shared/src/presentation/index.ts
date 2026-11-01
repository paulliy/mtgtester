/**
 * `@mtg/shared/presentation` — player-facing wording for engine options. Deliberately NOT
 * re-exported from the package index: it is a separate subpath so the web app is barred from
 * importing it (`no-restricted-imports` in `eslint.config.js`). The server builds these strings
 * (`server/src/match/presentation.ts`) and the browser renders what arrives (ADR 0032).
 */
export {
  actionLabel,
  actionLabelParts,
  entryNote,
  manaAbilityLabel,
  manaSymbols,
  targetHint,
} from './labels';
export {
  actionCost,
  actionData,
  paymentSourceIds,
  paymentSourceNames,
  paymentSourceSummary,
  pendingSummary,
  xFamily,
} from './actions';
