/**
 * PR08.15 Council's Judgment — the real card, through the real rules.
 *
 * Printed: {1}{W}{W} Sorcery — "Will of the council — Starting with you, each player votes for a
 * nonland permanent you don't control. Exile each permanent with the most votes or tied for most
 * votes."
 *
 * Clause mapping, all against the pinned Oracle hash below:
 *  - "Starting with you"                -> the vote rotation starts at the ability CONTROLLER's own
 *                                         turn slot, not the active player's.
 *  - "each player votes"                -> every living player votes exactly once, in turn order,
 *                                         and nobody may abstain: the decision has no "none".
 *  - "for a nonland permanent you don't control" -> one shared pool of the controller's
 *                                         opponents' nonland permanents, measured by CONTROL
 *                                         (never ownership, never hexproof/shroud).
 *  - "Exile each permanent with the most votes or tied for most votes" -> counted by permanent
 *                                         OBJECT id, every tied winner leaves in ONE event.
 *
 * Level 3 (real menu / real payment / real stack / real resolution) is exercised by
 * `councils-judgment-normal-cast-*`; the fixture-level tests drive `executeAbility` directly the
 * way the Druid of Purification tests do, so a regression in either path is visible.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ObjectId, OracleCard, PlayerId } from '@mtg/shared';
import { interpretCard } from '../src/cards/interpret';
import type { ManaEntry } from '../src/cards/ability';
import { fixtureOracleId } from '../src/cards/overrides';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { applyPriorityAction } from '../src/actions/apply';
import { createGame } from '../src/state/game';
import { changeController, playerById } from '../src/state/objects';
import type { EffectSource } from '../src/effects/resolve';
import { executeAbility } from '../src/effects/resolve';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { runPrioritySequence } from '../src/turn/priority';
import { addMana } from '../src/mana/pool';
import { formatPlayerLog, formatSpectatorLine } from '../src/view/spectator';
import type { GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

interface PinnedFixture {
  schemaVersion: number;
  source: string;
  retrievedAt: string;
  cards: { sha256: string; card: OracleCard }[];
}

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr08-oracle.json'), 'utf8'),
) as PinnedFixture;
const selected = fixture.cards.find((entry) => entry.card.name === "Council's Judgment");
if (selected === undefined) throw new Error("Missing Council's Judgment pin");
const pinned = selected;

/** Key order is irrelevant to the pin's digest, so canonicalize before hashing. */
function canonical(value: unknown): string {
  const ordered = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(ordered);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, ordered(entry)]),
      );
    }
    return input;
  };
  return JSON.stringify(ordered(value));
}

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(12, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  ctx.state.turnNumber = 4;
  return ctx;
}

/** A non-creature or creature permanent of an exact printed type, straight onto the battlefield. */
function relic(ctx: GameContext, controller: PlayerId, name: string, typeLine: string, text = '') {
  return spawn(ctx, controller, oracle({ name, typeLine, oracleText: text }));
}

/** Resolve the pinned spell ability directly, with a real source object in the caster's hand. */
function resolveCouncil(ctx: GameContext, caster: PlayerId, answer?: Answer) {
  const obj = conjure(ctx, caster, pinned.card, 'hand');
  const def = interpretCard({ ...pinned.card, oracleId: pinned.card.oracleId });
  const source: EffectSource = {
    cardId: obj.cardId,
    name: obj.name,
    oracleId: obj.oracleId,
    controllerId: caster,
  };
  return pump(executeAbility(ctx, source, def.spellAbility!, []), answer);
}

type Answer = (decision: PendingDecision, count: number) => DecisionOutcome;

function voteFor(decision: PendingDecision, name: string, occurrence = 0): DecisionOutcome {
  const indices = decision.options
    .map((option, index) => ({ option, index }))
    .filter(({ option }) => option.description === `Vote for ${name}`);
  expect(indices.length, `${decision.player} was offered "${name}"`).toBeGreaterThan(occurrence);
  return { index: indices[occurrence]!.index, targets: new Map<number, string>() };
}

/** Answers each seat from a plan of "how many candidates does this seat name"; unplanned seats fail. */
function byName(picks: Record<PlayerId, string>, occurrence = 0): Answer {
  return (decision) => {
    const wanted = picks[decision.player];
    if (wanted === undefined) throw new Error(`no planned vote for ${decision.player}`);
    return voteFor(decision, wanted, occurrence);
  };
}

const voteEvents = (ctx: GameContext) =>
  ctx.state.eventLog.filter((event) => event.type === 'vote');
const exileEvents = (ctx: GameContext) =>
  ctx.state.eventLog.filter(
    (event) => event.type === 'zoneChange' && event.payload['to'] === 'exile',
  );
const onBattlefield = (ctx: GameContext, perm: { id: ObjectId }) =>
  ctx.state.battlefield.some((candidate) => candidate.id === perm.id);

describe("Council's Judgment (PR08.15)", () => {
  it('councils-judgment-pinned-oracle — the pin, the real id and the fixture alias all agree', () => {
    expect(fixture.source).toBe('packages/server/fixtures/coverage-oracle.json');
    expect(pinned.card.oracleId).toBe('acf4d685-a718-42f7-9a7a-dee069ae8db2');
    expect(pinned.card.manaCost).toBe('{1}{W}{W}');
    expect(pinned.card.typeLine).toBe('Sorcery');
    expect(pinned.card.oracleText).toBe(
      "Will of the council — Starting with you, each player votes for a nonland permanent you don't control. Exile each permanent with the most votes or tied for most votes.",
    );
    expect(createHash('sha256').update(canonical(pinned.card)).digest('hex')).toBe(
      'fc8ad609d7a659cefbc858742af30f585db3edc89eca1de03dec248a1e8eb0a1',
    );
    expect(pinned.sha256).toBe('fc8ad609d7a659cefbc858742af30f585db3edc89eca1de03dec248a1e8eb0a1');

    expect(fixtureOracleId(pinned.card.name)).toBe('oracle-council-s-judgment');
    for (const id of [pinned.card.oracleId, 'oracle-council-s-judgment']) {
      const def = interpretCard({ ...pinned.card, oracleId: id });
      expect(def.unmodeledReasons).toEqual([]);
      expect(def.modeled, def.unmodeledReasons.join('\n')).toBe(true);
      expect(def.manaCost).toEqual({
        generic: 1,
        colored: { W: 2, U: 0, B: 0, R: 0, G: 0 },
        colorless: 0,
      });
      // The card is NON-TARGETING: no target spec, so nothing to pick before the votes.
      expect(def.spellAbility).toMatchObject({ kind: 'spell', targets: [] });
      expect(def.spellAbility!.effects).toEqual([
        {
          op: 'voteAndExileMost',
          selector: {
            kind: 'allOf',
            of: [
              { kind: 'not', of: { kind: 'type', value: 'Land' } },
              { kind: 'controller', who: 'opponents' },
            ],
          },
        },
      ]);
    }
  });

  it('councils-judgment-plurality — a 2:1:1 vote exiles exactly the two-vote permanent', () => {
    const ctx = pod('council-plurality');
    const a = relic(ctx, 'P2', 'Quorum Idol', 'Artifact');
    const b = relic(ctx, 'P3', 'Minor Seal', 'Enchantment');
    const c = relic(ctx, 'P4', 'Quiet Relic', 'Artifact');
    const { decisions } = resolveCouncil(ctx, 'P1', (decision) => {
      expect(decision.decisionType).toBe('general');
      const names = decision.options.map((option) => option.description);
      expect(names).toEqual([
        'Vote for Quorum Idol',
        'Vote for Minor Seal',
        'Vote for Quiet Relic',
      ]);
      // No abstain option exists, and no option is a target.
      expect(names.some((description) => /none|skip|decline/i.test(description))).toBe(false);
      expect(decision.options.every((option) => option.targets === undefined)).toBe(true);
      return voteFor(
        decision,
        decision.player === 'P1' || decision.player === 'P2'
          ? 'Quorum Idol'
          : decision.player === 'P3'
            ? 'Minor Seal'
            : 'Quiet Relic',
      );
    });
    expect(decisions.map((decision) => decision.player)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(onBattlefield(ctx, a)).toBe(false);
    expect(onBattlefield(ctx, b)).toBe(true);
    expect(onBattlefield(ctx, c)).toBe(true);
    expect(exileEvents(ctx).map((event) => event.payload['name'])).toEqual(['Quorum Idol']);
  });

  it('councils-judgment-tie — a 2:2 tie exiles both tied permanents in one departure', () => {
    const ctx = pod('council-tie');
    const a = relic(ctx, 'P2', 'Quorum Idol', 'Artifact');
    const b = relic(ctx, 'P3', 'Minor Seal', 'Enchantment');
    const { decisions } = resolveCouncil(ctx, 'P1', (decision) =>
      voteFor(
        decision,
        decision.player === 'P1' || decision.player === 'P4' ? 'Quorum Idol' : 'Minor Seal',
      ),
    );
    expect(decisions.map((decision) => decision.player)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(onBattlefield(ctx, a)).toBe(false);
    expect(onBattlefield(ctx, b)).toBe(false);
    expect(
      exileEvents(ctx)
        .map((event) => event.payload['name'])
        .sort(),
    ).toEqual(['Minor Seal', 'Quorum Idol']);
  });

  it('councils-judgment-all-different — four different votes tie at one and exile all four', () => {
    const ctx = pod('council-scorch');
    const names = ['Alpha Idol', 'Beta Idol', 'Gamma Idol', 'Delta Idol'];
    const ids = names.map(
      (name, index) =>
        relic(ctx, (['P2', 'P2', 'P3', 'P4'] as PlayerId[])[index]!, name, 'Artifact').id,
    );
    const { decisions } = resolveCouncil(ctx, 'P1', (decision, count) =>
      voteFor(decision, names[count - 1]!),
    );
    expect(decisions.map((decision) => decision.player)).toEqual(['P1', 'P2', 'P3', 'P4']);
    for (const id of ids) expect(onBattlefield(ctx, { id })).toBe(false);
    expect(exileEvents(ctx)).toHaveLength(4);
  });

  it('councils-judgment-unanimous — four votes for one permanent exile only that object', () => {
    const ctx = pod('council-unanimous');
    const a = relic(ctx, 'P2', 'Quorum Idol', 'Artifact');
    const b = relic(ctx, 'P3', 'Minor Seal', 'Enchantment');
    const c = relic(ctx, 'P4', 'Quiet Relic', 'Artifact');
    resolveCouncil(
      ctx,
      'P1',
      byName({ P1: 'Quorum Idol', P2: 'Quorum Idol', P3: 'Quorum Idol', P4: 'Quorum Idol' }),
    );
    expect(onBattlefield(ctx, a)).toBe(false);
    expect(onBattlefield(ctx, b)).toBe(true);
    expect(onBattlefield(ctx, c)).toBe(true);
  });

  it('councils-judgment-caster-votes — the caster votes first, on the same pool as everyone else', () => {
    const ctx = pod('council-caster-votes');
    const own = relic(ctx, 'P1', 'Caster Idol', 'Artifact');
    const target = relic(ctx, 'P2', 'Quorum Idol', 'Artifact');
    const decoy = relic(ctx, 'P3', 'Decoy Idol', 'Artifact');
    const asked: PlayerId[] = [];
    resolveCouncil(ctx, 'P1', (decision) => {
      asked.push(decision.player);
      expect(decision.options.map((option) => option.description)).toEqual([
        'Vote for Quorum Idol',
        'Vote for Decoy Idol',
      ]);
      return voteFor(decision, 'Quorum Idol');
    });
    // The caster is an ordinary voter and is asked FIRST, on the shared pool.
    expect(asked).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(onBattlefield(ctx, own)).toBe(true);
    expect(onBattlefield(ctx, target)).toBe(false);
    expect(onBattlefield(ctx, decoy)).toBe(true);
  });

  it('councils-judgment-turn-order — a nonactive controller starts the votes, and a loser is skipped', () => {
    const ctx = pod('council-order');
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    const a = relic(ctx, 'P2', 'Quorum Idol', 'Artifact');
    const b = relic(ctx, 'P4', 'Minor Seal', 'Enchantment');
    const departed = resolveCouncil(
      ctx,
      'P3',
      byName({ P3: 'Quorum Idol', P4: 'Quorum Idol', P1: 'Quorum Idol', P2: 'Minor Seal' }),
    );
    // The active player is P1; the rotation still starts at P3, the ability's controller.
    expect(departed.decisions.map((decision) => decision.player)).toEqual(['P3', 'P4', 'P1', 'P2']);
    expect(voteEvents(ctx).map((event) => event.actorSeat)).toEqual(['P3', 'P4', 'P1', 'P2']);
    expect(onBattlefield(ctx, a)).toBe(false);
    expect(onBattlefield(ctx, b)).toBe(true);

    const lost = pod('council-order-lost');
    lost.state.currentTurnPlayer = 'P1';
    lost.state.activePlayerIndex = 0;
    playerById(lost, 'P2').hasLost = true;
    relic(lost, 'P4', 'Quorum Idol', 'Artifact');
    relic(lost, 'P3', 'Minor Seal', 'Enchantment');
    const after = resolveCouncil(
      lost,
      'P1',
      byName({ P1: 'Quorum Idol', P3: 'Quorum Idol', P4: 'Quorum Idol' }),
    );
    // P2 is eliminated and never asked.
    expect(after.decisions.map((decision) => decision.player)).toEqual(['P1', 'P3', 'P4']);
    expect(voteEvents(lost).map((event) => event.actorSeat)).toEqual(['P1', 'P3', 'P4']);
  });

  it("councils-judgment-candidate-pool — controlled lands and the caster's own permanents are never offered", () => {
    const ctx = pod('council-pool');
    const own = relic(ctx, 'P1', 'Caster Idol', 'Artifact');
    const ownCreature = relic(ctx, 'P1', 'Caster Bear', 'Creature — Bear', '');
    const ownLand = relic(ctx, 'P1', 'Caster Plains', 'Land');
    const enemyLand = relic(ctx, 'P2', 'Enemy Island', 'Land');
    const enemyCreature = relic(ctx, 'P2', 'Enemy Bear', 'Creature — Bear');
    const enemyPlaneswalker = relic(ctx, 'P3', 'Enemy Walker', 'Planeswalker — Test');
    resolveCouncil(ctx, 'P1', (decision, count) => {
      // Exactly the two enemy nonland permanents — never the caster's own, never a land.
      expect(decision.options.map((option) => option.description).sort()).toEqual([
        'Vote for Enemy Bear',
        'Vote for Enemy Walker',
      ]);
      return voteFor(decision, count === 1 || count === 2 ? 'Enemy Bear' : 'Enemy Walker');
    });
    for (const survivor of [own, ownCreature, ownLand, enemyLand]) {
      expect(onBattlefield(ctx, survivor)).toBe(true);
    }
    // A 2:2 tie, so both eligible enemy nonlands leave and nothing else does.
    expect(onBattlefield(ctx, enemyCreature)).toBe(false);
    expect(onBattlefield(ctx, enemyPlaneswalker)).toBe(false);
  });

  it('councils-judgment-control-not-ownership — "you don\'t control" follows the controller, not the owner', () => {
    const ctx = pod('council-ownership');
    const mineButOwnedByThem = relic(ctx, 'P1', 'Contested Idol', 'Artifact');
    changeController(ctx, mineButOwnedByThem, 'P2');
    const theirsButOwnedByMe = relic(ctx, 'P2', 'Gift Seal', 'Enchantment');
    changeController(ctx, theirsButOwnedByMe, 'P1');
    resolveCouncil(ctx, 'P1', (decision) => {
      // Only the permanent P1 controls is excluded, even though P2 owns it.
      expect(decision.options.map((option) => option.description)).toEqual(['Vote for Gift Seal']);
      return { index: 0, targets: new Map() };
    });
    expect(onBattlefield(ctx, mineButOwnedByThem)).toBe(false);
    expect(onBattlefield(ctx, theirsButOwnedByMe)).toBe(true);
  });

  it.each(['Hexproof', 'Shroud', 'Protection from spells'])(
    'councils-judgment-nontargeting — %s never removes a vote option',
    (keyword) => {
      const ctx = pod(`council-${keyword}`);
      const warded = relic(ctx, 'P2', 'Warded Idol', 'Artifact', keyword);
      resolveCouncil(ctx, 'P1', (decision) => {
        expect(decision.options.map((option) => option.description)).toEqual([
          'Vote for Warded Idol',
        ]);
        return { index: 0, targets: new Map() };
      });
      expect(onBattlefield(ctx, warded)).toBe(false);
    },
  );

  it('councils-judgment-no-candidates — with nothing to vote for there is no vote and no exile', () => {
    const ctx = pod('council-empty');
    const own = relic(ctx, 'P1', 'Caster Idol', 'Artifact');
    const land = relic(ctx, 'P2', 'Enemy Island', 'Land');
    const { decisions } = resolveCouncil(ctx, 'P1', () => {
      throw new Error('no decision may be surfaced when there is nothing to vote for');
    });
    expect(decisions).toEqual([]);
    expect(voteEvents(ctx)).toEqual([]);
    expect(exileEvents(ctx)).toEqual([]);
    expect(onBattlefield(ctx, own)).toBe(true);
    expect(onBattlefield(ctx, land)).toBe(true);
  });

  it('councils-judgment-no-targets — the cast menu offers no target selection before the votes', () => {
    const ctx = pod('council-no-targets');
    const obj = conjure(ctx, 'P1', pinned.card, 'hand');
    addMana(playerById(ctx, 'P1'), whitePayment());
    const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === obj.id;
    });
    expect(option).toBeDefined();
    expect(interpretCard(pinned.card).spellAbility!.targets).toEqual([]);
    // The engine's own cast proposal asks for no targets at all.
    const cast = pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(cast.decisions).toEqual([]);
    expect(ctx.state.stack).toHaveLength(1);
    expect(ctx.state.stack[0]!.targets).toEqual([]);
  });

  it('councils-judgment-public-votes — every vote is public and names source, voter and object', () => {
    const ctx = pod('council-public');
    const a = relic(ctx, 'P2', 'Quorum Idol', 'Artifact');
    const b = relic(ctx, 'P3', 'Minor Seal', 'Enchantment');
    const exileBefore = () => exileEvents(ctx).length;
    resolveCouncil(ctx, 'P1', (decision, count) => {
      // Nothing has left while the votes are still being cast.
      expect(exileBefore()).toBe(0);
      expect(voteEvents(ctx)).toHaveLength(count - 1);
      expect(onBattlefield(ctx, a)).toBe(true);
      expect(onBattlefield(ctx, b)).toBe(true);
      return voteFor(decision, count <= 2 ? 'Quorum Idol' : 'Minor Seal');
    });
    const votes = voteEvents(ctx);
    expect(votes.map((event) => event.actorSeat)).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(votes.map((event) => event.payload['voter'])).toEqual(['P1', 'P2', 'P3', 'P4']);
    expect(votes.map((event) => event.payload['name'])).toEqual([
      'Quorum Idol',
      'Quorum Idol',
      'Minor Seal',
      'Minor Seal',
    ]);
    expect(votes.map((event) => event.payload['objectId'])).toEqual([a.id, a.id, b.id, b.id]);
    for (const vote of votes) {
      expect(vote.payload['source']).toBe("Council's Judgment");
      expect(formatSpectatorLine(vote)!.text).toBe(
        `Council's Judgment: ${vote.payload['voter']} votes for ${vote.payload['name']}`,
      );
    }
    // Public means public: every seat, including players with no vote pending, sees the whole log.
    for (const viewer of ['P1', 'P2', 'P3', 'P4'] as PlayerId[]) {
      expect(formatPlayerLog(ctx.state.eventLog, viewer).map((line) => line.text)).toEqual([
        "Council's Judgment: P1 votes for Quorum Idol",
        "Council's Judgment: P2 votes for Quorum Idol",
        "Council's Judgment: P3 votes for Minor Seal",
        "Council's Judgment: P4 votes for Minor Seal",
      ]);
    }
    // The vote names a battlefield permanent only — no hand or library identity is recorded.
    const text = JSON.stringify(votes.map((vote) => vote.payload));
    expect(text).not.toContain('Island');
    expect(text).not.toContain('library');
  });

  it('councils-judgment-normal-cast-plurality — the real {1}{W}{W} menu, stack, resolution and votes', () => {
    const ctx = pod('council-normal-cast');
    const a = relic(ctx, 'P2', 'Quorum Idol', 'Artifact');
    const b = relic(ctx, 'P3', 'Minor Seal', 'Enchantment');
    const c = relic(ctx, 'P4', 'Quiet Relic', 'Artifact');

    const obj = conjure(ctx, 'P1', pinned.card, 'hand');
    const payment = whitePayment();
    addMana(playerById(ctx, 'P1'), payment);
    const option = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'castSpell' && payload.objectId === obj.id;
    });
    expect(option).toBeDefined();
    const cast = pump(
      applyPriorityAction(ctx, playerById(ctx, 'P1'), option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    // {1}{W}{W} against W/W/C has exactly one solution, so the engine asks nothing.
    expect(cast.decisions).toEqual([]);
    expect(playerById(ctx, 'P1').manaEntries).toEqual([]);
    expect(playerById(ctx, 'P1').hand.filter((held) => held.id === obj.id)).toHaveLength(0);
    expect(ctx.state.stack).toHaveLength(1);
    expect(ctx.state.stack[0]!.controllerId).toBe('P1');
    expect(ctx.state.stack[0]!.targets).toEqual([]);
    expect(
      ctx.state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['player'] === 'P1',
      ),
    ).toBe(true);

    // Pass priority around the table; answer only the council's own vote decisions.
    const seen: { player: PlayerId; options: string[]; exiledBefore: number }[] = [];
    pump(runPrioritySequence(ctx), (decision) => {
      if (decision.decisionType === 'priority') {
        const pass = decision.options.findIndex((option) => option.type === 'pass');
        return { index: pass >= 0 ? pass : 0, targets: new Map() };
      }
      expect(decision.decisionType).toBe('general');
      seen.push({
        player: decision.player,
        options: decision.options.map((candidate) => candidate.description),
        exiledBefore: exileEvents(ctx).length,
      });
      const wanted =
        decision.player === 'P1' || decision.player === 'P4' ? 'Quorum Idol' : 'Minor Seal';
      const index = decision.options.findIndex(
        (candidate) => candidate.description === `Vote for ${wanted}`,
      );
      expect(index, `${decision.player} can vote for ${wanted}`).toBeGreaterThanOrEqual(0);
      return { index, targets: new Map() };
    });

    expect(seen.map((entry) => entry.player)).toEqual(['P1', 'P2', 'P3', 'P4']);
    for (const entry of seen) {
      expect(entry.options).toEqual([
        'Vote for Quorum Idol',
        'Vote for Minor Seal',
        'Vote for Quiet Relic',
      ]);
      // All four votes are cast before a single permanent leaves.
      expect(entry.exiledBefore).toBe(0);
    }
    expect(ctx.state.stack).toHaveLength(0);
    // 2:2 — a tie, so both winners leave.
    expect(onBattlefield(ctx, a)).toBe(false);
    expect(onBattlefield(ctx, b)).toBe(false);
    expect(onBattlefield(ctx, c)).toBe(true);
    expect(
      exileEvents(ctx)
        .map((event) => event.payload['name'])
        .sort(),
    ).toEqual(['Minor Seal', 'Quorum Idol']);
    // The sorcery itself went to the graveyard as an ordinary spell.
    expect(
      playerById(ctx, 'P1').graveyard.filter((card) => card.name === "Council's Judgment"),
    ).toHaveLength(1);
    expect(ctx.state.battlefield.some((permanent) => permanent.name === "Council's Judgment")).toBe(
      false,
    );
  });

  it('councils-judgment-cast-cost-and-timing — {1}{W}{W} needs two white and a third mana, on a sorcery window', () => {
    const ctx = pod('council-legality');
    const obj = conjure(ctx, 'P1', pinned.card, 'hand');
    const offered = () =>
      computePriorityOptions(ctx, playerById(ctx, 'P1')).some((candidate) => {
        const payload = candidate.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.objectId === obj.id;
      });

    // Two white but no third mana: the total is short.
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, { symbol: 'W' }]);
    expect(offered()).toBe(false);

    // Three colorless: the total is there, the white is not.
    playerById(ctx, 'P1').manaEntries = [];
    addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
    expect(offered()).toBe(false);

    // One white and two colorless: still short a second white.
    playerById(ctx, 'P1').manaEntries = [];
    addMana(playerById(ctx, 'P1'), [{ symbol: 'W' }, { symbol: 'C' }, { symbol: 'C' }]);
    expect(offered()).toBe(false);

    // The same three real entries the positive test pays with do make it legal.
    playerById(ctx, 'P1').manaEntries = [];
    addMana(playerById(ctx, 'P1'), whitePayment());
    expect(offered()).toBe(true);

    // Sorcery speed (CR 307.1): the window closes in combat...
    ctx.state.phase = 'combat';
    ctx.state.step = 'combatDamage';
    expect(offered()).toBe(false);

    // ...and on another player's turn, while still holding priority.
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    expect(offered()).toBe(true);
    ctx.state.currentTurnPlayer = 'P2';
    ctx.state.activePlayerIndex = 1;
    expect(offered()).toBe(false);

    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    expect(offered()).toBe(true);
    expect(playerById(ctx, 'P1').hand.filter((held) => held.id === obj.id)).toHaveLength(1);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(3);
    expect(voteEvents(ctx)).toEqual([]);
    expect(exileEvents(ctx)).toEqual([]);
  });
});

/** {1}{W}{W}: two white and one colorless, as three separate real mana objects. */
function whitePayment(): ManaEntry[] {
  return [{ symbol: 'W' }, { symbol: 'W' }, { symbol: 'C' }];
}
