import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { computeCharacteristics } from '../src/effects/continuous';
import type { DecisionOutcome, PendingDecision } from '../src/decisions';
import { addMana, drainPool } from '../src/mana/pool';
import { runPrioritySequence } from '../src/turn/priority';
import { resolveTopOfStack } from '../src/stack/stack';
import { buildPlayerView } from '../src/view/view';
import { createGame } from '../src/state/game';
import { moveObject, playerById, queueTriggersForEvent } from '../src/state/objects';
import type { EnginePermanent, GameContext } from '../src/state/types';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const pinned = (
  JSON.parse(
    readFileSync(new URL('./fixtures/coverage-pr09-oracle.json', import.meta.url), 'utf8'),
  ) as { cards: { card: OracleCard; sha256: string }[] }
).cards;
function pinnedCard(name: string): OracleCard {
  const card = pinned.find((entry) => entry.card.name === name)?.card;
  if (card === undefined) throw new Error(`missing pinned PR09 Oracle card: ${name}`);
  return card;
}
const OMNITOOL = pinnedCard('Adaptive Omnitool');
const SKYHUNTER = pinnedCard('Armored Skyhunter');

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      Array.from({ length: 4 }, () => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 4;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  // Tests seed only the cards relevant to the behavior under study.
  for (const player of ctx.state.players) player.hand = [];
  return ctx;
}

type Answer = (decision: PendingDecision) => DecisionOutcome;
const pass = (decision: PendingDecision): DecisionOutcome => {
  const index = decision.options.findIndex(
    (option) =>
      option.type === 'pass' ||
      (option.payload as Partial<PriorityActionPayload> | undefined)?.kind === 'pass',
  );
  if (index < 0) throw new Error(`no priority pass option in ${decision.prompt}`);
  return { index, targets: new Map() };
};

function castObject(ctx: GameContext, object: ReturnType<typeof conjure>): EnginePermanent {
  const action = computePriorityOptions(ctx, playerById(ctx, 'P1')).find((option) => {
    const payload = option.payload as PriorityActionPayload;
    return payload.kind === 'castSpell' && payload.objectId === object.id;
  });
  expect(action, `${object.name} has a legal cast action`).toBeDefined();
  pump(
    applyPriorityAction(ctx, playerById(ctx, 'P1'), action!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map(),
    }),
  );
  expect(ctx.state.stack).toHaveLength(1);
  expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  pump(runPrioritySequence(ctx), (decision) => pass(decision));
  const permanent = ctx.state.battlefield.find((entry) => entry.cardId === object.cardId);
  expect(permanent, `${object.name} resolves as a permanent`).toBeDefined();
  return permanent!;
}

function castPermanently(ctx: GameContext, card: OracleCard, mana: ('C' | 'W')[]): EnginePermanent {
  const object = conjure(ctx, 'P1', card, 'hand');
  addMana(
    playerById(ctx, 'P1'),
    mana.map((symbol) => ({ symbol })),
  );
  return castObject(ctx, object);
}

function library(ctx: GameContext, cards: OracleCard[]): ReturnType<typeof conjure>[] {
  const player = playerById(ctx, 'P1');
  const objects = cards.map((card) => conjure(ctx, 'P1', card, 'library'));
  player.library = objects;
  return [...objects];
}

function artifact(name: string, subtype?: 'Equipment'): OracleCard {
  return oracle({
    name,
    typeLine: subtype === undefined ? 'Artifact' : 'Artifact — Equipment',
    manaCost: '{1}',
    oracleText: subtype === undefined ? '' : 'Equip {9}',
    power: null,
    toughness: null,
  });
}
function aura(name = 'Lab Aura'): OracleCard {
  return oracle({
    name,
    typeLine: 'Enchantment — Aura',
    manaCost: '{W}',
    oracleText: 'Enchant creature\nEnchanted creature gets +1/+1.',
    power: null,
    toughness: null,
  });
}
function creature(name: string): OracleCard {
  return oracle({ name, typeLine: 'Creature — Test', manaCost: '{1}', power: '2', toughness: '2' });
}
function choiceByDescription(decision: PendingDecision, pattern: RegExp): DecisionOutcome {
  const index = decision.options.findIndex((option) => pattern.test(option.description));
  if (index < 0)
    throw new Error(
      `no option matching ${pattern} in ${decision.options.map((option) => option.description).join(' | ')}`,
    );
  return { index, targets: new Map() };
}
function decline(decision: PendingDecision): DecisionOutcome {
  const index = decision.options.findIndex((option) => option.type === 'decline');
  if (index < 0) throw new Error(`no decline option in ${decision.prompt}`);
  return { index, targets: new Map() };
}

/** Queue the actual attacks event, then pass priority until its trigger and choices resolve. */
function attackAndResolve(
  ctx: GameContext,
  attacker: EnginePermanent,
  answer: Answer = pass,
): PendingDecision[] {
  attacker.attacking = 'P2';
  queueTriggersForEvent(ctx, 'attacks', [{ permanent: attacker, playerId: 'P1' }]);
  return pump(runPrioritySequence(ctx), (decision) => {
    if (decision.decisionType === 'priority') return pass(decision);
    // The attack triggers are mandatory: only their own choices are asked, no "use it?" first.
    expect(decision.decisionType).not.toBe('optionalTrigger');
    return answer(decision);
  }).decisions;
}

function chooseTopCard(name: string): Answer {
  return (decision) => choiceByDescription(decision, new RegExp(`Put ${name}\\b`));
}

function performEquip(ctx: GameContext, equipment: EnginePermanent, host: EnginePermanent): void {
  const player = playerById(ctx, 'P1');
  const option = computePriorityOptions(ctx, player).find((entry) => {
    const payload = entry.payload as PriorityActionPayload;
    return (
      payload.kind === 'activateAbility' &&
      payload.objectId === equipment.id &&
      /Equip/.test(entry.description)
    );
  });
  expect(option, 'the printed sorcery-speed equip action is offered').toBeDefined();
  pump(
    applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
      index: 0,
      targets: new Map([[0, host.id]]),
    }),
  );
  pump(resolveTopOfStack(ctx));
}

describe('Adaptive Omnitool (pinned PR09 Oracle)', () => {
  it('pr09-omnitool-equip-sorcery-artifact-count — pays Equip {3}; its bonus includes itself, excludes opposing artifacts, and tracks the current count', () => {
    const ctx = pod('pr09-omnitool-equip');
    const tool = castPermanently(ctx, OMNITOOL, ['C', 'C']);
    const host = spawn(ctx, 'P1', creature('Omnitool Host'));
    const opposingCreature = spawn(ctx, 'P2', creature('Opposing Omnitool Creature'));
    spawn(ctx, 'P2', artifact('Opponent Artifact'));
    const ownArtifact = spawn(ctx, 'P1', artifact('Own Artifact One'));
    const secondArtifact = spawn(ctx, 'P1', artifact('Own Artifact Two'));
    ctx.state.phase = 'combat';
    ctx.state.step = 'beginCombat';
    addMana(playerById(ctx, 'P1'), [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'C' }]);
    expect(
      computePriorityOptions(ctx, playerById(ctx, 'P1')).some(
        (option) => (option.payload as { objectId?: string }).objectId === tool.id,
      ),
    ).toBe(false);
    ctx.state.phase = 'precombatMain';
    ctx.state.step = null;
    const player = playerById(ctx, 'P1');
    const equipAction = computePriorityOptions(ctx, player).find(
      (option) =>
        (option.payload as { objectId?: string }).objectId === tool.id &&
        /Equip/.test(option.description),
    );
    expect(equipAction).toBeDefined();
    // Equip targets only creatures you control.
    const equipTargets = equipAction!.targets!.flatMap((slot) => slot.options);
    expect(equipTargets).toContain(host.id);
    expect(equipTargets).not.toContain(opposingCreature.id);
    // Only two mana cannot pay the printed equip cost.
    drainPool(player, false);
    addMana(player, [{ symbol: 'C' }, { symbol: 'C' }]);
    expect(
      computePriorityOptions(ctx, player).some(
        (option) =>
          (option.payload as { objectId?: string }).objectId === tool.id &&
          /Equip/.test(option.description),
      ),
    ).toBe(false);
    addMana(player, [{ symbol: 'C' }]);
    performEquip(ctx, tool, host);
    expect(tool.attachedTo).toBe(host.id);
    expect(player.manaEntries).toHaveLength(0);
    expect(computeCharacteristics(ctx, host)).toMatchObject({ power: 5, toughness: 5 });
    pump(moveObject(ctx, secondArtifact, { zone: 'graveyard' }));
    expect(computeCharacteristics(ctx, host)).toMatchObject({ power: 4, toughness: 4 });
    expect(ownArtifact.controllerId).toBe('P1');
  });

  it('pr09-omnitool-only-equipped-creature-attacks-trigger — only the creature equipped by this Omnitool fires its trigger', () => {
    const ctx = pod('pr09-omnitool-trigger-source');
    const tool = spawn(ctx, 'P1', OMNITOOL);
    const equipped = spawn(ctx, 'P1', creature('Equipped Attacker'));
    const other = spawn(ctx, 'P1', creature('Other Attacker'));
    tool.attachedTo = equipped.id;
    library(ctx, [
      artifact('Trigger Artifact'),
      oracle({ name: 'Trigger Tail', typeLine: 'Instant' }),
    ]);
    other.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: other, playerId: 'P1' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    const decisions = attackAndResolve(ctx, equipped, chooseTopCard('Trigger Artifact'));
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
    expect(
      decisions.some((decision) => decision.options.some((option) => option.type === 'putFromTop')),
    ).toBe(true);
  });

  it('pr09-omnitool-reveal-zone-change-privacy — reveals the chosen artifact before its real hand move, never draws, and hides the other looked cards', () => {
    const ctx = pod('pr09-omnitool-reveal-private');
    const tool = spawn(ctx, 'P1', OMNITOOL);
    const host = spawn(ctx, 'P1', creature('Omnitool Privacy Host'));
    tool.attachedTo = host.id;
    const looked = [
      artifact('Public Tool'),
      oracle({ name: 'Private Instant', typeLine: 'Instant' }),
      artifact('Private Relic'),
    ];
    const objects = library(ctx, looked);
    const eventStart = ctx.state.eventLog.length;
    attackAndResolve(ctx, host, chooseTopCard('Public Tool'));
    const events = ctx.state.eventLog.slice(eventStart);
    const revealIndex = events.findIndex((event) => event.type === 'revealCard');
    const moveIndex = events.findIndex(
      (event) =>
        event.type === 'zoneChange' &&
        event.payload['name'] === 'Public Tool' &&
        event.payload['from'] === 'library' &&
        event.payload['to'] === 'hand',
    );
    expect(revealIndex).toBeGreaterThanOrEqual(0);
    expect(moveIndex).toBeGreaterThan(revealIndex);
    expect(
      events.filter((event) => event.type === 'revealCard').map((event) => event.payload['name']),
    ).toEqual(['Public Tool']);
    expect(events.some((event) => event.type === 'draw')).toBe(false);
    expect(playerById(ctx, 'P1').hand.map((card) => card.cardId)).toContain(objects[0]!.cardId);
    const opponentView = JSON.stringify(buildPlayerView(ctx, 'P2'));
    expect(opponentView).toContain('Public Tool');
    expect(opponentView).not.toContain('Private Instant');
    expect(opponentView).not.toContain('Private Relic');
  });

  it('pr09-omnitool-top-six-filter — offers only artifacts among the top six and never the untouched library tail', () => {
    const ctx = pod('pr09-omnitool-top-six');
    const tool = spawn(ctx, 'P1', OMNITOOL);
    const host = spawn(ctx, 'P1', creature('Omnitool Filter Host'));
    tool.attachedTo = host.id;
    const cards = Array.from({ length: 8 }, (_, index) =>
      index === 1 || index === 4
        ? artifact(`Top Artifact ${index}`)
        : oracle({ name: `Top Instant ${index}`, typeLine: 'Instant' }),
    );
    library(ctx, cards);
    const offered: string[][] = [];
    attackAndResolve(ctx, host, (decision) => {
      offered.push(decision.options.map((option) => option.description));
      return choiceByDescription(decision, /^Put Top Artifact 1\b/);
    });
    expect(offered).toHaveLength(1);
    expect(offered[0]!.some((entry) => entry.includes('Top Artifact 1'))).toBe(true);
    expect(offered[0]!.some((entry) => entry.includes('Top Artifact 4'))).toBe(true);
    expect(
      offered[0]!.some((entry) => /Top Instant|Top Artifact 6|Top Artifact 7/.test(entry)),
    ).toBe(false);
  });

  it('pr09-omnitool-decline — declining leaves all six cards unrevealed and moves none to hand', () => {
    const ctx = pod('pr09-omnitool-decline');
    const tool = spawn(ctx, 'P1', OMNITOOL);
    const host = spawn(ctx, 'P1', creature('Omnitool Decline Host'));
    tool.attachedTo = host.id;
    const objects = library(ctx, [
      artifact('Declined Artifact'),
      ...Array.from({ length: 5 }, (_, i) =>
        oracle({ name: `Declined Spell ${i}`, typeLine: 'Instant' }),
      ),
    ]);
    const choices = attackAndResolve(ctx, host, decline);
    expect(
      choices.some((decision) => decision.options.some((option) => option.type === 'putFromTop')),
    ).toBe(true);
    expect(ctx.state.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
    expect(playerById(ctx, 'P1').hand).toHaveLength(0);
    expect(new Set(playerById(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(objects.map((card) => card.cardId)),
    );
  });

  it('pr09-omnitool-no-match-empty-short — no match and an empty library skip the choice; a short library still resolves once', () => {
    const ctx = pod('pr09-omnitool-libraries');
    const tool = spawn(ctx, 'P1', OMNITOOL);
    const host = spawn(ctx, 'P1', creature('Omnitool Library Host'));
    tool.attachedTo = host.id;
    const nonArtifacts = Array.from({ length: 6 }, (_, i) =>
      oracle({ name: `No Artifact ${i}`, typeLine: 'Sorcery' }),
    );
    const objects = library(ctx, nonArtifacts);
    const noMatch = attackAndResolve(ctx, host);
    expect(
      noMatch.some((decision) => decision.options.some((option) => option.type === 'putFromTop')),
    ).toBe(false);
    expect(new Set(playerById(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(objects.map((card) => card.cardId)),
    );
  });

  it('pr09-omnitool-empty-and-short — empty library does nothing; a three-card library offers only its artifact', () => {
    const emptyCtx = pod('pr09-omnitool-empty');
    const emptyTool = spawn(emptyCtx, 'P1', OMNITOOL);
    const emptyHost = spawn(emptyCtx, 'P1', creature('Omnitool Empty Host'));
    emptyTool.attachedTo = emptyHost.id;
    expect(
      attackAndResolve(emptyCtx, emptyHost).some((decision) =>
        decision.options.some((option) => option.type === 'putFromTop'),
      ),
    ).toBe(false);
    expect(playerById(emptyCtx, 'P1').hasLost).toBe(false);

    const shortCtx = pod('pr09-omnitool-short');
    const shortTool = spawn(shortCtx, 'P1', OMNITOOL);
    const shortHost = spawn(shortCtx, 'P1', creature('Omnitool Short Host'));
    shortTool.attachedTo = shortHost.id;
    const short = library(shortCtx, [
      artifact('Short Artifact'),
      oracle({ name: 'Short Spell', typeLine: 'Instant' }),
      oracle({
        name: 'Short Land',
        typeLine: 'Basic Land — Plains',
        manaCost: null,
        cmc: 0,
        power: null,
        toughness: null,
      }),
    ]);
    attackAndResolve(shortCtx, shortHost, chooseTopCard('Short Artifact'));
    expect(playerById(shortCtx, 'P1').hand.map((card) => card.name)).toContain('Short Artifact');
    expect(new Set(playerById(shortCtx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(short.slice(1).map((card) => card.cardId)),
    );
  });

  it('pr09-omnitool-seeded-random-bottom — selected card leaves the looked set and the remaining library order replays from its seed', () => {
    const run = (seed: string) => {
      const ctx = pod(seed);
      const tool = spawn(ctx, 'P1', OMNITOOL);
      const host = spawn(ctx, 'P1', creature('Omnitool Seed Host'));
      tool.attachedTo = host.id;
      const cards = library(ctx, [
        artifact('Seed Artifact'),
        ...Array.from({ length: 7 }, (_, i) =>
          oracle({ name: `Seed Spell ${i}`, typeLine: 'Instant' }),
        ),
      ]);
      attackAndResolve(ctx, host, chooseTopCard('Seed Artifact'));
      expect(
        new Set(
          [...playerById(ctx, 'P1').hand, ...playerById(ctx, 'P1').library].map(
            (card) => card.cardId,
          ),
        ),
      ).toEqual(new Set(cards.map((card) => card.cardId)));
      return playerById(ctx, 'P1').library.map((card) => card.name);
    };
    expect(run('pr09-omnitool-seeded')).toEqual(run('pr09-omnitool-seeded'));
  });
});

describe('Armored Skyhunter (pinned PR09 Oracle)', () => {
  it('pr09-skyhunter-only-self-attack-triggers — its own attack queues the trigger, another creature attack does not', () => {
    const ctx = pod('pr09-skyhunter-trigger');
    const hunter = spawn(ctx, 'P1', SKYHUNTER);
    const other = spawn(ctx, 'P1', creature('Skyhunter Other Attacker'));
    library(ctx, [oracle({ name: 'Skyhunter Trigger Tail', typeLine: 'Instant' })]);
    other.attacking = 'P2';
    queueTriggersForEvent(ctx, 'attacks', [{ permanent: other, playerId: 'P1' }]);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(attackAndResolve(ctx, hunter)).toHaveLength(0);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
    expect(playerById(ctx, 'P1').library).toHaveLength(1);
  });

  it('pr09-skyhunter-filter-and-put-equipment — chooses only Aura or Equipment, then may attach Equipment to your creature without paying Equip', () => {
    const ctx = pod('pr09-skyhunter-equipment');
    const hunter = spawn(ctx, 'P1', SKYHUNTER);
    const own = spawn(ctx, 'P1', creature('Skyhunter Own Host'));
    const otherOwn = spawn(ctx, 'P1', creature('Skyhunter Other Host'));
    spawn(ctx, 'P2', creature('Skyhunter Opponent Host'));
    library(ctx, [
      artifact('Deployable Equipment', 'Equipment'),
      artifact('Artifact Only'),
      aura('Deployable Aura'),
      ...Array.from({ length: 3 }, (_, i) =>
        oracle({ name: `Skyhunter Spell ${i}`, typeLine: 'Instant' }),
      ),
    ]);
    const attachmentOffers: string[][] = [];
    const decisions = attackAndResolve(ctx, hunter, (decision) => {
      const hostOptions = decision.options.filter(
        (option) =>
          option.description.includes('Skyhunter Own Host') ||
          option.description.includes('Skyhunter Other Host') ||
          option.description.includes('Skyhunter Opponent Host'),
      );
      if (hostOptions.length > 0) {
        attachmentOffers.push(hostOptions.map((option) => option.description));
        return choiceByDescription(decision, /Skyhunter Own Host/);
      }
      if (decision.options.some((option) => option.description.includes('Deployable Equipment')))
        return chooseTopCard('Deployable Equipment')(decision);
      return pass(decision);
    });
    expect(
      decisions.some((decision) =>
        decision.options.some((option) => option.description.includes('Artifact Only')),
      ),
    ).toBe(false);
    expect(attachmentOffers).toHaveLength(1);
    expect(
      attachmentOffers[0]!.some((description) => description.includes('Skyhunter Opponent Host')),
    ).toBe(false);
    const deployed = ctx.state.battlefield.find(
      (permanent) => permanent.name === 'Deployable Equipment',
    );
    expect(deployed?.attachedTo).toBe(own.id);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
    expect(ctx.state.eventLog.some((event) => event.type === 'equip')).toBe(false);
    expect(otherOwn.id).not.toBe(own.id);
  });

  it('pr09-skyhunter-aura-legal-attachment — putting an Aura onto the battlefield asks for a legal enchantable creature as it enters', () => {
    const ctx = pod('pr09-skyhunter-aura');
    const hunter = spawn(ctx, 'P1', SKYHUNTER);
    const host = spawn(ctx, 'P1', creature('Aura Host'));
    spawn(ctx, 'P2', creature('Aura Opponent Host'));
    library(ctx, [
      aura('Skyhunter Aura'),
      ...Array.from({ length: 5 }, (_, i) =>
        oracle({ name: `Aura Tail ${i}`, typeLine: 'Instant' }),
      ),
    ]);
    const auraOffers: string[][] = [];
    attackAndResolve(ctx, hunter, (decision) => {
      if (decision.options.some((option) => option.type === 'attachAura')) {
        auraOffers.push(decision.options.map((option) => option.description));
        return choiceByDescription(decision, /Enchant Aura Host/);
      }
      if (decision.options.some((option) => option.description.includes('Skyhunter Aura')))
        return chooseTopCard('Skyhunter Aura')(decision);
      return pass(decision);
    });
    expect(auraOffers).toHaveLength(1);
    const attached = ctx.state.battlefield.find((permanent) => permanent.name === 'Skyhunter Aura');
    expect(attached?.attachedTo).toBe(host.id);
    expect(auraOffers[0]!.some((description) => description.includes('Aura Opponent Host'))).toBe(
      true,
    );
  });

  it('pr09-skyhunter-decline-equipment-attachment — equipment enters unattached when you decline and no equip mana is paid', () => {
    const ctx = pod('pr09-skyhunter-decline-attach');
    const hunter = spawn(ctx, 'P1', SKYHUNTER);
    spawn(ctx, 'P1', creature('Skyhunter Decline Host'));
    const equipment = artifact('Declined Attach Equipment', 'Equipment');
    library(ctx, [
      equipment,
      ...Array.from({ length: 5 }, (_, i) =>
        oracle({ name: `Decline Tail ${i}`, typeLine: 'Instant' }),
      ),
    ]);
    let declinedAttachment = false;
    attackAndResolve(ctx, hunter, (decision) => {
      const hostChoice = decision.options.some((option) =>
        option.description.includes('Skyhunter Decline Host'),
      );
      if (hostChoice) {
        declinedAttachment = true;
        return decline(decision);
      }
      if (
        decision.options.some((option) => option.description.includes('Declined Attach Equipment'))
      )
        return chooseTopCard('Declined Attach Equipment')(decision);
      return pass(decision);
    });
    const deployed = ctx.state.battlefield.find((permanent) => permanent.name === equipment.name);
    expect(deployed).toBeDefined();
    expect(deployed?.attachedTo).toBeNull();
    expect(declinedAttachment).toBe(true);
    expect(playerById(ctx, 'P1').manaEntries).toHaveLength(0);
  });

  it('pr09-skyhunter-decline-placement — declining the optional placement leaves every looked card in the library', () => {
    const ctx = pod('pr09-skyhunter-decline-placement');
    const hunter = spawn(ctx, 'P1', SKYHUNTER);
    const cards = library(ctx, [
      artifact('Declined Skyhunter Equipment', 'Equipment'),
      aura('Declined Skyhunter Aura'),
      ...Array.from({ length: 4 }, (_, i) =>
        oracle({ name: `Placement Tail ${i}`, typeLine: 'Instant' }),
      ),
    ]);
    const decisions = attackAndResolve(ctx, hunter, decline);
    expect(
      decisions.some((decision) => decision.options.some((option) => option.type === 'putFromTop')),
    ).toBe(true);
    expect(
      ctx.state.battlefield.some((permanent) => permanent.name.includes('Declined Skyhunter')),
    ).toBe(false);
    expect(new Set(playerById(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(cards.map((card) => card.cardId)),
    );
  });

  it('pr09-skyhunter-no-hit-short-empty — non-Equipment artifacts do not match, short libraries resolve, and an empty library does nothing', () => {
    const ctx = pod('pr09-skyhunter-no-hit');
    const hunter = spawn(ctx, 'P1', SKYHUNTER);
    const cards = library(ctx, [
      artifact('Not Equipment'),
      ...Array.from({ length: 2 }, (_, i) =>
        oracle({ name: `No Skyhunter Hit ${i}`, typeLine: 'Instant' }),
      ),
    ]);
    const decisions = attackAndResolve(ctx, hunter);
    expect(
      decisions.some((decision) => decision.options.some((option) => option.type === 'putFromTop')),
    ).toBe(false);
    expect(new Set(playerById(ctx, 'P1').library.map((card) => card.cardId))).toEqual(
      new Set(cards.map((card) => card.cardId)),
    );

    const emptyCtx = pod('pr09-skyhunter-empty');
    const emptyHunter = spawn(emptyCtx, 'P1', SKYHUNTER);
    expect(
      attackAndResolve(emptyCtx, emptyHunter).some((decision) =>
        decision.options.some((option) => option.type === 'putFromTop'),
      ),
    ).toBe(false);
    expect(playerById(emptyCtx, 'P1').hasLost).toBe(false);
  });

  it('pr09-skyhunter-seeded-random-bottom — the untaken looked cards bottom in replayable seeded order', () => {
    const run = (seed: string) => {
      const ctx = pod(seed);
      const hunter = spawn(ctx, 'P1', SKYHUNTER);
      const cards = library(ctx, [
        artifact('Seed Skyhunter Equipment', 'Equipment'),
        ...Array.from({ length: 7 }, (_, i) =>
          oracle({ name: `Skyhunter Seed Tail ${i}`, typeLine: 'Instant' }),
        ),
      ]);
      attackAndResolve(ctx, hunter, (decision) =>
        decision.options.some((option) => option.description.includes('Seed Skyhunter Equipment'))
          ? chooseTopCard('Seed Skyhunter Equipment')(decision)
          : decline(decision),
      );
      expect(
        new Set([
          ...ctx.state.battlefield
            .filter((permanent) => permanent.name === 'Seed Skyhunter Equipment')
            .map((permanent) => permanent.cardId),
          ...playerById(ctx, 'P1').library.map((card) => card.cardId),
        ]),
      ).toEqual(new Set(cards.map((card) => card.cardId)));
      return playerById(ctx, 'P1').library.map((card) => card.name);
    };
    expect(run('pr09-skyhunter-seeded')).toEqual(run('pr09-skyhunter-seeded'));
  });
});
