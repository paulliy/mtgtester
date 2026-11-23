/**
 * The places in the top bar's ruler and the phone menu (redesign plan, phase 2), grouped as in
 * the Decktank mockups: I. New game, II. Records, III. Workshop. Pure data, so the order, the
 * dev-only places and which place counts as "here" are unit-tested without a router.
 */

export type NavGroup = 'I' | 'II' | 'III';

export interface NavPlace {
  key: string;
  group: NavGroup;
  label: string;
  to: string;
  /** One line for the phone menu. */
  description: string;
  /** The route names that count as being at this place. */
  routes: readonly string[];
}

export const NAV_GROUP_NAMES: Readonly<Record<NavGroup, string>> = {
  I: 'New game',
  II: 'Records',
  III: 'Workshop',
};

export interface NavOptions {
  /** Dev-only places (Card lab, Deals) exist only in a dev build, matching `router.ts`. */
  dev: boolean;
  /** A game is running, so the board can be returned to. */
  gameRunning: boolean;
}

export function navPlaces(options: NavOptions): NavPlace[] {
  const places: NavPlace[] = [
    {
      key: 'setup',
      group: 'I',
      label: 'New game',
      to: '/',
      description: 'Play, watch or batch a four-seat table',
      routes: ['setup'],
    },
  ];
  if (options.gameRunning) {
    places.push({
      key: 'game',
      group: 'I',
      label: 'Return to game',
      to: '/game',
      description: 'Back to the board of the game in progress',
      routes: ['game'],
    });
  }
  places.push(
    {
      key: 'stats',
      group: 'II',
      label: 'Stats',
      to: '/stats',
      description: 'Standings, matchups and how each deck fares',
      routes: ['stats'],
    },
    {
      key: 'batch',
      group: 'II',
      label: 'Batch runs',
      to: '/batch',
      description: 'Past batch runs and their results',
      routes: ['batch', 'batch-results', 'batch-new'],
    },
  );
  if (options.dev) {
    places.push(
      {
        key: 'card-test-lab',
        group: 'III',
        label: 'Card lab',
        to: '/card-test-lab',
        description: 'Put single cards through the rules engine',
        routes: ['card-test-lab'],
      },
      {
        key: 'deals-preview',
        group: 'III',
        label: 'Deals',
        to: '/deals-preview',
        description: 'The deal panel with sample data',
        routes: ['deals-preview'],
      },
    );
  }
  places.push({
    key: 'debug',
    group: 'III',
    label: 'Debug',
    to: '/debug',
    description: 'Engine log, AI calls and seeds',
    routes: ['debug'],
  });
  return places;
}

/** Index of the place the route belongs to, or -1 (no warm tick) for a route with no place. */
export function currentPlaceIndex(
  places: readonly NavPlace[],
  routeName: string | null | undefined,
): number {
  if (routeName === null || routeName === undefined) return -1;
  return places.findIndex((place) => place.routes.includes(routeName));
}

/** True for the first place of each group: it carries the group numeral and a tall tick. */
export function startsGroup(places: readonly NavPlace[], index: number): boolean {
  return index === 0 || places[index - 1]?.group !== places[index]?.group;
}
