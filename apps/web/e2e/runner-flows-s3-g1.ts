import type { Locator, Page } from '@playwright/test';

type Flow = (page: Page) => Promise<void>;
type Helpers = {
  passUntil: (page: Page, target: Locator) => Promise<void>;
  passStackUntil: (page: Page, target: Locator) => Promise<void>;
};

/** Viewer flows for PR #89's common blocking line scenarios (group s3-g1). */
export function s3g1Flows(_h: Helpers): Record<string, Flow> {
  return {};
}
