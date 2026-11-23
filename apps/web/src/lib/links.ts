/**
 * Places outside this app (ADR 0052 decision 7). One constant per link, so a link can move to
 * configuration later without touching the views.
 */

/** The hosted multiplayer tables. Opened in a new tab; the local server never proxies them. */
export const HOSTED_TABLES_URL = 'https://decktester.poilygon.dev/';
