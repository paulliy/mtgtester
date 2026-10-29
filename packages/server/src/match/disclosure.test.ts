/**
 * `DisclosurePolicy` (ADR 0031 decision 3): the deny-by-default values, the tester's and the
 * table's policies, the outbound allowlist they yield, and the throw-or-drop check at the last hop.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SERVER_TO_CLIENT_TYPES, type GameMode } from '@mtg/shared';
import {
  checkOutbound,
  DENY_ALL,
  FULL_STATE_TYPES,
  isOutboundAllowed,
  mayShowArchetypeTag,
  mayShowDecklists,
  outboundAllowlist,
  seedLabel,
  tablePolicy,
  testerPolicy,
  type DisclosurePolicy,
} from './disclosure';

const LIVE = { terminal: false } as const;
const OVER = { terminal: true } as const;

/** Types any policy may send: they carry nothing the policy decides. */
const ALWAYS = [
  'gameStarted',
  'eventBatch',
  'computeHalted',
  'playerStateSnapshot',
  'playerActionRequired',
  'sessionPaused',
  'gameOver',
  'diplomacyState',
  'dealDraft',
  'error',
];

describe('DENY_ALL', () => {
  it('denies every field', () => {
    expect(DENY_ALL).toEqual({
      showSeed: false,
      debugEvents: false,
      annotations: 'none',
      aiCostReports: false,
      rawErrorText: false,
      archetypeTags: 'none',
      fullState: 'never',
      decklistsAfterGame: false,
      haltIsTerminal: false,
    });
  });

  it('is frozen, so no entry point can loosen it in place', () => {
    expect(Object.isFrozen(DENY_ALL)).toBe(true);
    expect(Object.isFrozen(tablePolicy())).toBe(true);
    expect(Object.isFrozen(testerPolicy('spectator'))).toBe(true);
  });

  it('allows only the types that carry nothing the policy decides', () => {
    for (const phase of [LIVE, OVER]) {
      expect([...outboundAllowlist(DENY_ALL, phase)].sort()).toEqual([...ALWAYS].sort());
    }
  });

  it('reveals no seed, tag or decklist', () => {
    expect(seedLabel(DENY_ALL, 'secret')).toBe('');
    expect(mayShowDecklists(DENY_ALL, true)).toBe(false);
    expect(
      mayShowArchetypeTag(DENY_ALL, {
        owner: 'P1',
        viewer: 'P1',
        ownerIsHuman: true,
        gameOver: true,
      }),
    ).toBe(false);
  });
});

describe('testerPolicy', () => {
  it('shows a spectator everything, live', () => {
    expect(testerPolicy('spectator')).toEqual({
      showSeed: true,
      debugEvents: true,
      annotations: 'live',
      aiCostReports: true,
      rawErrorText: true,
      archetypeTags: 'all',
      fullState: 'always',
      decklistsAfterGame: true,
      haltIsTerminal: false,
    });
  });

  it('seals a single player: no debug or raw text, the full state and notes after the game', () => {
    expect(testerPolicy('singlePlayer')).toEqual({
      showSeed: true,
      debugEvents: false,
      annotations: 'afterGame',
      aiCostReports: true,
      rawErrorText: false,
      archetypeTags: 'ownHumanSeat',
      fullState: 'afterGame',
      decklistsAfterGame: true,
      haltIsTerminal: false,
    });
  });

  it('gives a table, if the tester ever ran one, the table policy', () => {
    expect(testerPolicy('table')).toEqual(tablePolicy());
  });

  it('is decided for every mode', () => {
    const modes: GameMode[] = ['spectator', 'singlePlayer', 'table'];
    for (const mode of modes) expect(testerPolicy(mode)).toBeDefined();
  });
});

describe('tablePolicy', () => {
  it('follows ADR 0031 decision 3', () => {
    expect(tablePolicy()).toEqual({
      showSeed: false,
      debugEvents: false,
      annotations: 'ownSeat',
      aiCostReports: false,
      rawErrorText: false,
      archetypeTags: 'ownHumanSeat',
      fullState: 'afterGame',
      decklistsAfterGame: true,
      haltIsTerminal: true,
    });
  });

  it('hides the seed and shows decklists only after the game', () => {
    expect(seedLabel(tablePolicy(), 'label')).toBe('');
    expect(mayShowDecklists(tablePolicy(), false)).toBe(false);
    expect(mayShowDecklists(tablePolicy(), true)).toBe(true);
  });

  it('gives a human seat its own tag alone, and withholds a bot tag from everyone, until the end', () => {
    const policy = tablePolicy();
    const tag = (owner: string, viewer: string, ownerIsHuman: boolean, gameOver: boolean) =>
      mayShowArchetypeTag(policy, { owner, viewer, ownerIsHuman, gameOver });

    expect(tag('P1', 'P1', true, false)).toBe(true);
    expect(tag('P1', 'P3', true, false)).toBe(false);
    expect(tag('P2', 'P1', false, false)).toBe(false);
    expect(tag('P2', 'P2', false, false)).toBe(false);
    // The game is over: the decklists unlock, and the tags with them.
    expect(tag('P2', 'P1', false, true)).toBe(true);
  });

  it('sends no debug events, cost reports or raw-detail frames at any phase', () => {
    for (const phase of [LIVE, OVER]) {
      for (const type of ['debugEvents', 'apiWaiting', 'decisionPending']) {
        expect(isOutboundAllowed(tablePolicy(), type, phase)).toBe(false);
      }
    }
  });
});

describe('the outbound allowlist', () => {
  it('classifies every wire type: nothing falls through to a default', () => {
    // A type added to the protocol without a gate is denied by the policy, never allowed by omission.
    for (const type of SERVER_TO_CLIENT_TYPES) {
      const everything: DisclosurePolicy = {
        showSeed: true,
        debugEvents: true,
        annotations: 'live',
        aiCostReports: true,
        rawErrorText: true,
        archetypeTags: 'all',
        fullState: 'always',
        decklistsAfterGame: true,
        haltIsTerminal: true,
      };
      expect(isOutboundAllowed(everything, type, LIVE), type).toBe(true);
    }
    expect(isOutboundAllowed(testerPolicy('spectator'), 'notARealType', OVER)).toBe(false);
  });

  it('names the full-state types', () => {
    expect([...FULL_STATE_TYPES].sort()).toEqual(
      ['replayTurnState', 'replayUnlocked', 'stateSnapshot', 'tableResults'].sort(),
    );
  });

  it('holds the full-state types back at a table until the game is over', () => {
    const table = tablePolicy();
    for (const type of FULL_STATE_TYPES) {
      expect(isOutboundAllowed(table, type, LIVE), type).toBe(false);
      expect(isOutboundAllowed(table, type, OVER), type).toBe(true);
    }
    expect(isOutboundAllowed(table, 'debugEvents', OVER)).toBe(false);
  });

  it('lets a spectator see the board live and a single player only after the game', () => {
    for (const type of ['stateSnapshot', 'debugEvents', 'apiWaiting']) {
      expect(isOutboundAllowed(testerPolicy('spectator'), type, LIVE), type).toBe(true);
    }
    expect(isOutboundAllowed(testerPolicy('singlePlayer'), 'stateSnapshot', LIVE)).toBe(false);
    expect(isOutboundAllowed(testerPolicy('singlePlayer'), 'stateSnapshot', OVER)).toBe(true);
    expect(isOutboundAllowed(testerPolicy('singlePlayer'), 'replayUnlocked', LIVE)).toBe(false);
    expect(isOutboundAllowed(testerPolicy('singlePlayer'), 'replayUnlocked', OVER)).toBe(true);
    expect(isOutboundAllowed(testerPolicy('singlePlayer'), 'debugEvents', OVER)).toBe(false);
    expect(isOutboundAllowed(testerPolicy('singlePlayer'), 'apiWaiting', LIVE)).toBe(true);
  });

  it('derives the same answer as isOutboundAllowed', () => {
    const allowed = outboundAllowlist(testerPolicy('singlePlayer'), LIVE);
    expect(allowed.has('apiWaiting')).toBe(true);
    expect(allowed.has('replayUnlocked')).toBe(false);
    expect(allowed.has('replayTurnState')).toBe(false);
  });
});

describe('checkOutbound', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('passes an allowed message', () => {
    expect(checkOutbound(tablePolicy(), 'eventBatch', LIVE)).toBe(true);
  });

  it('throws under test, naming the type', () => {
    expect(process.env['VITEST']).toBeTruthy();
    expect(() => checkOutbound(tablePolicy(), 'replayUnlocked', LIVE)).toThrow(/replayUnlocked/);
  });

  it('drops the message with a warning when it is not a test run', () => {
    vi.stubEnv('VITEST', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(checkOutbound(tablePolicy(), 'debugEvents', LIVE)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('debugEvents');
  });
});
