/**
 * The frame scan (multiplayer plan M2a): every frame `GameServer` sends to the player of a
 * scripted single-player game is checked against what the player may not be told.
 *
 * A scan is only worth anything if it can fail, so each rule is also run against a frame that
 * breaks it. The rules that depend on the engine's player projection (commander zones and the
 * yield flag) are skipped, in plain view, until that change lands.
 *
 * What counts as "another seat's archetype tag" is the disclosure policy's call, not the scan's:
 * the tester's policy shows every seat's tag in `gameStarted` today, so the scan passes it, and the
 * same frames fail under the table's policy.
 */

import { describe, expect, it, vi } from 'vitest';
import { RandomDecisionProvider } from '@mtg/engine';
import type { OracleCard, PlayerId, ServerToClientMessage, StartGamePayload } from '@mtg/shared';
import type { MatchSession } from '../match/session';
import type { SeatSetup } from '../match/setup';
import {
  mayShowArchetypeTag,
  tablePolicy,
  testerPolicy,
  type DisclosurePolicy,
} from '../match/disclosure';
import { GameServer, type GameServerDeps } from './server';

const mocks = vi.hoisted(() => ({ turnCap: 40 }));

vi.mock('../match/setup', () => ({ setupSeats: vi.fn() }));
vi.mock('../match/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../match/session')>();
  return {
    ...actual,
    MatchSession: class extends actual.MatchSession {
      constructor(opts: ConstructorParameters<typeof actual.MatchSession>[0]) {
        super({ ...opts, turnCap: mocks.turnCap });
      }
    },
  };
});

import { setupSeats } from '../match/setup';

const VIEWER: PlayerId = 'P1';
const SEATS: readonly PlayerId[] = ['P1', 'P2', 'P3', 'P4'];
const tagOf = (seat: PlayerId): string => `archetype-secret-${seat}`;

function forest(n: number): OracleCard {
  return {
    oracleId: `forest-${n}`,
    scryfallId: `scry-forest-${n}`,
    name: 'Forest',
    manaCost: null,
    cmc: 0,
    colors: [],
    colorIdentity: ['G'],
    typeLine: 'Basic Land — Forest',
    supertypes: ['Basic'],
    types: ['Land'],
    subtypes: ['Forest'],
    oracleText: '',
    power: null,
    toughness: null,
    loyalty: null,
    defense: null,
    keywords: [],
    layout: 'normal',
    commanderLegality: 'legal',
    isBasicLand: true,
  };
}

function general(seat: string): OracleCard {
  return {
    ...forest(0),
    oracleId: `general-${seat}`,
    scryfallId: `scry-general-${seat}`,
    name: `Test General ${seat}`,
    manaCost: '{G}',
    cmc: 1,
    colors: ['G'],
    typeLine: 'Legendary Creature — Elf',
    supertypes: ['Legendary'],
    types: ['Creature'],
    subtypes: ['Elf'],
    power: '2',
    toughness: '2',
    isBasicLand: false,
  };
}

function seats(): SeatSetup[] {
  return SEATS.map((seat) => ({
    seat,
    deckSnapshotId: null,
    config: {
      id: seat,
      deckId: `deck-${seat}`,
      commanders: [general(seat)],
      cards: Array.from({ length: 24 }, (_, i) => forest(i)),
    },
    summary: {
      seat,
      deckId: `deck-${seat}`,
      label: `Test General ${seat}`,
      commanderNames: [`Test General ${seat}`],
      colorIdentity: ['G'],
      archetypeTag: tagOf(seat),
    },
  }));
}

// ── The scan ────────────────────────────────────────────────────────────────────────────────

interface ScannedFrame {
  /** The frame as sent. */
  json: string;
  /** Object ids sitting in another seat's hand at the instant the frame was sent. */
  hiddenHandIds: ReadonlySet<string>;
}

export interface Violation {
  frame: number;
  rule: 'otherSeatHand' | 'otherSeatArchetypeTag' | 'noteKey' | 'rawHaltText';
  detail: string;
}

/** Frames that legitimately carry the whole game: they are sent only once it is over. */
const POST_GAME_TYPES = new Set(['replayUnlocked', 'gameReflections']);

function keysOf(value: unknown, out: Set<string>): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out);
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      keysOf(item, out);
    }
  }
  return out;
}

export function scanFrames(
  frames: readonly ScannedFrame[],
  options: {
    viewer: PlayerId;
    policy: DisclosurePolicy;
    /** Every seat's tag, keyed by seat. */
    tags: Readonly<Record<string, string>>;
    /** The engine's raw halt wording, when the game halted. */
    rawHaltText: readonly string[];
  },
): Violation[] {
  const violations: Violation[] = [];
  const humans = new Set<PlayerId>([options.viewer]);
  frames.forEach((frame, index) => {
    const parsed = JSON.parse(frame.json) as { type: string };
    if (POST_GAME_TYPES.has(parsed.type)) return;
    const flag = (rule: Violation['rule'], detail: string): void => {
      violations.push({ frame: index, rule, detail: `${parsed.type}: ${detail}` });
    };

    for (const id of frame.hiddenHandIds) {
      if (frame.json.includes(`"${id}"`)) flag('otherSeatHand', id);
    }
    for (const [seat, tag] of Object.entries(options.tags)) {
      const allowed = mayShowArchetypeTag(options.policy, {
        owner: seat,
        viewer: options.viewer,
        ownerIsHuman: humans.has(seat),
        gameOver: false,
      });
      if (!allowed && frame.json.includes(tag)) flag('otherSeatArchetypeTag', `${seat}: ${tag}`);
    }
    if (keysOf(parsed, new Set()).has('note')) flag('noteKey', 'a `note` key');
    for (const text of options.rawHaltText) {
      if (text !== '' && frame.json.includes(JSON.stringify(text).slice(1, -1))) {
        flag('rawHaltText', text);
      }
    }
  });
  return violations;
}

// ── A scripted single-player game, every frame captured ─────────────────────────────────────

interface Seam {
  onSocketOpen(socket: unknown): void;
  handleMessage(socket: unknown, raw: string): Promise<void>;
  session: MatchSession | null;
}

async function until(done: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

interface Played {
  frames: ScannedFrame[];
  messages: ServerToClientMessage[];
  rawHaltText: string[];
  /** Hand ids of the other seats seen at any frame, to prove the scan had something to catch. */
  everHidden: Set<string>;
}

async function playScriptedGame(turnCap: number): Promise<Played> {
  mocks.turnCap = turnCap;
  vi.mocked(setupSeats).mockResolvedValue({ ok: true, seats: seats() });
  const server = new GameServer({} as GameServerDeps);
  const seam = server as unknown as Seam;
  const frames: ScannedFrame[] = [];
  const everHidden = new Set<string>();
  const socket = {
    send: (json: string) => {
      const hidden = new Set<string>();
      for (const player of seam.session?.engine.getState().players ?? []) {
        if (player.id === VIEWER) continue;
        for (const card of player.hand) {
          hidden.add(card.id);
          everHidden.add(card.id);
        }
      }
      frames.push({ json, hiddenHandIds: hidden });
    },
  };
  seam.onSocketOpen(socket);
  const payload: Partial<StartGamePayload> = {
    seats: [{ kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }, { kind: 'pool' }],
    providerKind: 'random',
    seed: 'frame-scan',
    paceMs: 0,
    gameMode: 'singlePlayer',
    humanSeat: VIEWER,
  } as Partial<StartGamePayload>;
  await seam.handleMessage(socket, JSON.stringify({ type: 'startGame', payload }));

  const messages = (): ServerToClientMessage[] =>
    frames.map((frame) => JSON.parse(frame.json) as ServerToClientMessage);
  const chooser = new RandomDecisionProvider('frame-scan-human');
  let consumed = 0;
  const required = () =>
    messages().filter(
      (m): m is Extract<ServerToClientMessage, { type: 'playerActionRequired' }> =>
        m.type === 'playerActionRequired',
    );
  const over = () => messages().some((m) => m.type === 'gameOver' || m.type === 'computeHalted');
  for (;;) {
    await until(() => over() || required().length > consumed, 'the next request or the end');
    if (over()) break;
    const next = required()[consumed]!;
    consumed += 1;
    const response = chooser.decide(next.payload.request);
    await seam.handleMessage(
      socket,
      JSON.stringify({
        type: 'submitPlayerAction',
        payload: {
          requestId: response.requestId,
          actionId: response.actionId,
          revision: next.payload.revision,
          ...(response.targets !== undefined ? { targets: response.targets } : {}),
        },
      }),
    );
  }
  await seam.session?.settled();
  const halt = seam.session?.runner.getHalt();
  const result = seam.session?.runner.getResult();
  const rawHaltText = [halt?.reason, halt?.site, result?.haltReason, result?.haltSite].filter(
    (text): text is string => typeof text === 'string' && text !== '',
  );
  seam.session?.abandon();
  expect(consumed).toBeGreaterThan(0);
  return { frames, messages: messages(), rawHaltText, everHidden };
}

const TAGS = Object.fromEntries(SEATS.map((seat) => [seat, tagOf(seat)]));

describe('every frame of a scripted single-player game', () => {
  it('names no other seat hand, note key or raw halt text, and only the tags the policy allows', async () => {
    const played = await playScriptedGame(40);
    // The scan had hidden cards to look for.
    expect(played.everHidden.size).toBeGreaterThan(0);

    expect(
      scanFrames(played.frames, {
        viewer: VIEWER,
        policy: testerPolicy('singlePlayer'),
        tags: TAGS,
        rawHaltText: played.rawHaltText,
      }),
    ).toEqual([]);
  }, 30_000);

  it('does not leak raw halt text in a game the engine halts', async () => {
    const played = await playScriptedGame(4);
    expect(played.messages.some((m) => m.type === 'computeHalted')).toBe(true);
    // The engine's own wording exists to be absent from the frames.
    expect(played.rawHaltText.length).toBeGreaterThan(0);

    expect(
      scanFrames(played.frames, {
        viewer: VIEWER,
        policy: testerPolicy('singlePlayer'),
        tags: TAGS,
        rawHaltText: played.rawHaltText,
      }),
    ).toEqual([]);
  }, 30_000);

  it('would flag the other seats tags under the table policy, which withholds them', async () => {
    const played = await playScriptedGame(40);
    const violations = scanFrames(played.frames, {
      viewer: VIEWER,
      policy: tablePolicy(),
      tags: TAGS,
      rawHaltText: [],
    });

    // `gameStarted` names all four seats; the table's policy lets the viewer read only its own.
    expect(violations.filter((v) => v.rule === 'otherSeatArchetypeTag')).not.toEqual([]);
    expect(
      violations.some((v) => v.rule === 'otherSeatArchetypeTag' && v.detail.includes(tagOf('P2'))),
    ).toBe(true);
    expect(
      violations.some((v) => v.rule === 'otherSeatArchetypeTag' && v.detail.includes(tagOf('P1'))),
    ).toBe(false);
  }, 30_000);
});

describe('the scan itself', () => {
  const frame = (value: unknown, hidden: string[] = []): ScannedFrame => ({
    json: JSON.stringify(value),
    hiddenHandIds: new Set(hidden),
  });
  const scan = (frames: ScannedFrame[], rawHaltText: string[] = []) =>
    scanFrames(frames, {
      viewer: VIEWER,
      policy: tablePolicy(),
      tags: TAGS,
      rawHaltText,
    });

  it('fails on another seat hand object id', () => {
    const found = scan([
      frame({ type: 'playerStateSnapshot', payload: { hand: [{ id: 'o17' }] } }, ['o17']),
    ]);
    expect(found).toEqual([
      expect.objectContaining({ rule: 'otherSeatHand', detail: expect.stringContaining('o17') }),
    ]);
  });

  it('fails on another seat archetype tag, and allows the viewer own', () => {
    const found = scan([
      frame({ type: 'gameStarted', payload: { seats: [tagOf('P1'), tagOf('P3')] } }),
    ]);
    expect(found.map((v) => v.rule)).toEqual(['otherSeatArchetypeTag']);
    expect(found[0]?.detail).toContain(tagOf('P3'));
  });

  it('fails on a note key at any depth', () => {
    const found = scan([
      frame({ type: 'eventBatch', payload: { lines: [{ deep: { note: 'x' } }] } }),
    ]);
    expect(found).toEqual([expect.objectContaining({ rule: 'noteKey' })]);
  });

  it('fails on raw halt text, including in a quoted string', () => {
    const raw = 'turn cap of 4 exceeded — probable "engine" bug';
    const found = scan([frame({ type: 'computeHalted', payload: { reason: raw } })], [raw]);
    expect(found).toEqual([expect.objectContaining({ rule: 'rawHaltText' })]);
  });

  it('ignores post-game frames, which carry the whole game by design', () => {
    expect(
      scan([
        frame({ type: 'replayUnlocked', payload: { note: 'x', hand: [{ id: 'o17' }] } }, ['o17']),
      ]),
    ).toEqual([]);
  });

  // allowed-skip: needs the M2a engine projection change (viewer-aware commander views)
  it.skip('fails on another seat commander zone or art while it is hidden', () => {
    // Once the engine projects a hidden commander as `zone: 'hidden'` with `objectId: null` and
    // `scryfallId: null` to non-owners, scan every frame for a commander of another seat that
    // is in a hand, a library or face down, by object id and by scryfall id.
  });

  // allowed-skip: needs the M2a engine projection change (yieldingUntilEndOfTurn to its own seat)
  it.skip('fails on another seat yield flag', () => {
    // Once `yieldingUntilEndOfTurn` goes only to its own seat, scan every frame for the key on a
    // seat other than the viewer's.
  });
});
