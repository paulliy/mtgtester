import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, DecisionResponse, OracleCard } from '@mtg/shared';
import { NO_ATTACK_TARGET, NO_BLOCK_TARGET } from '@mtg/shared';
import type { EngineState } from '../../../engine/src/state/types';
import { PR09_CHOICE_SCENARIOS, pr09ChoiceScenario } from './pr09-choice-scenarios';

const pins = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/engine/tests/fixtures/coverage-pr09-oracle.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { cards: { sha256: string; card: OracleCard }[] }
).cards;
const pinned = (name: string) => {
  const entry = pins.find((candidate) => candidate.card.name === name);
  if (!entry) throw new Error(`Missing PR09 pin ${name}`);
  return entry;
};

function passAction(request: DecisionRequest) {
  return request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
}

function gameState(scenario: ReturnType<typeof pr09ChoiceScenario>): EngineState {
  return scenario.engine.getState() as EngineState;
}

function drive(scenario: ReturnType<typeof pr09ChoiceScenario>, id: string): void {
  const state = gameState(scenario);
  const cardName = PR09_CHOICE_SCENARIOS.find((entry) => entry.id === id)!.cardName;
  for (let count = 0; count < 600; count++) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') {
      if (step.result.halted)
        throw new Error(`${id} halted: ${step.result.haltReason ?? 'unspecified'}`);
      return;
    }
    if (step.kind === 'continue') continue;
    const request = step.request;
    const pass = passAction(request);
    const actions = request.legalActions;
    let action = pass;
    let targets: DecisionResponse['targets'];
    if (id.startsWith('pr09-celebrate-the-mountain-king') && request.decisionType === 'general') {
      action =
        actions.find((candidate) => candidate.description.includes('For each opponent, exile')) ??
        actions.find((candidate) => candidate.description.includes('Recruit:')) ??
        pass;
    }
    if (request.decidingPlayer === 'P1' && request.decisionType === 'declareAttackers') {
      const attack = actions.find((candidate) => candidate.type === 'attackDeclaration');
      const subjects = request.presentation?.attackDeclaration?.subjects ?? [];
      if (attack) {
        action = attack;
        targets = (attack.targets ?? []).map((slot) => {
          const subject = subjects[slot.slot];
          const shouldAttack =
            (id === 'pr09-rabble-rousing-viewer-positive' &&
              subject?.name === 'PR09 Rabble Attacker') ||
            (id === 'pr09-grenzo-havoc-raiser-viewer-positive' &&
              subject?.name === 'PR09 Path Creature') ||
            (id === 'pr09-grenzo-havoc-raiser-viewer-goad' &&
              subject?.name === 'PR09 Path Creature') ||
            (id === 'pr09-new-generation-s-technique-viewer-sneak-positive' &&
              subject?.name === 'PR09 Sneak Attacker') ||
            (id.startsWith('pr09-power-pack') && subject?.name === 'Power Pack');
          return {
            slot: slot.slot,
            choice: shouldAttack && slot.options.includes('P2') ? 'P2' : NO_ATTACK_TARGET,
          };
        });
      }
    }
    if (request.decidingPlayer === 'P1' && request.decisionType === 'priority') {
      const p1 = state.players.find((player) => player.id === 'P1')!;
      const wanted = id.startsWith('pr09-tibalt-s-trickery')
        ? state.stack.some((item) => item.card?.name === 'PR09 Opponent Instant')
          ? cardName
          : undefined
        : id.startsWith('pr09-path')
          ? p1.hand.find(
              (card) =>
                card.name === cardName ||
                card.name === 'PR09 Path Creature' ||
                card.name === 'PR09 Path Artifact',
            )?.name
          : id === 'pr09-lurking-predators-viewer-negative'
            ? p1.hand.find((card) => card.name === cardName || card.name === 'PR09 Own Instant')
                ?.name
            : p1.hand.find((card) => card.name === cardName)?.name;
      if (wanted)
        action =
          actions.find(
            (candidate) => candidate.type === 'castSpell' && candidate.description.includes(wanted),
          ) ?? pass;
      if (id === 'pr09-new-generation-s-technique-viewer-sneak-positive') {
        if (state.step === 'declareBlockers')
          action =
            actions.find(
              (candidate) =>
                candidate.type === 'castSpell' &&
                candidate.description.includes(cardName) &&
                /Sneak/i.test(candidate.description),
            ) ?? action;
        else action = pass;
      }
      if (id === 'pr09-grenzo-havoc-raiser-viewer-positive') {
        const freeCast = actions.find(
          (candidate) =>
            candidate.type === 'castSpell' && candidate.description.includes('PR09 Grenzo Reveal'),
        );
        if (freeCast) action = freeCast;
      }
      if (id === 'pr09-tibalt-s-trickery-viewer-positive') {
        const freeCast = actions.find(
          (candidate) =>
            candidate.type === 'castSpell' &&
            candidate.description.includes('PR09 Trickery Reveal'),
        );
        if (freeCast) action = freeCast;
      }
      const trickeryCast = id.startsWith('pr09-tibalt-s-trickery')
        ? actions.find(
            (candidate) =>
              candidate.type === 'castSpell' && candidate.description.includes("Tibalt's Trickery"),
          )
        : undefined;
      if (trickeryCast) {
        action = trickeryCast;
        const slot = trickeryCast.targets?.find((candidate) => candidate.options.length > 0);
        if (slot) {
          const opponentSpell = state.stack.find(
            (item) =>
              item.card?.name === 'PR09 Opponent Instant' ||
              item.description?.includes('PR09 Opponent Instant'),
          );
          const target =
            opponentSpell && slot.options.includes(opponentSpell.id)
              ? opponentSpell.id
              : slot.options[0]!;
          targets = [{ slot: slot.slot, choice: target }];
        }
      }
    }
    if (request.decidingPlayer === 'P1' && request.decisionType === 'general') {
      const discard =
        id === 'pr09-celebrate-the-mountain-king-viewer-positive'
          ? 'PR09 Recruit Discard'
          : id === 'pr09-celebrate-the-mountain-king-viewer-negative'
            ? 'PR09 Recruit Land'
            : undefined;
      const freeChoice = actions.find(
        (candidate) =>
          candidate.type === 'castFree' ||
          (id === 'pr09-tibalt-s-trickery-viewer-positive' &&
            candidate.description.includes('PR09 Trickery Reveal')),
      );
      const rabbleFreeCast = actions.find(
        (candidate) =>
          id === 'pr09-rabble-rousing-viewer-positive' &&
          candidate.description.includes('Play PR09 Rabble Hidden'),
      );
      const decline = actions.find(
        (candidate) => candidate.type === 'decline' || candidate.type === 'stopCasting',
      );
      const mode = actions.find(
        (candidate) =>
          id === 'pr09-grenzo-havoc-raiser-viewer-positive' &&
          /Exile their top card/.test(candidate.description),
      );
      const modeGoad = actions.find(
        (candidate) =>
          id === 'pr09-grenzo-havoc-raiser-viewer-goad' &&
          /Goad target creature/.test(candidate.description),
      );
      const sneakCost = actions.find(
        (candidate) =>
          id === 'pr09-new-generation-s-technique-viewer-sneak-positive' &&
          /PR09 Sneak Attacker/.test(candidate.description),
      );
      const stopCopiedCapstone =
        id === 'pr09-improvisation-capstone-viewer-positive' &&
        state.eventLog.some((event) => event.type === 'cardCopied')
          ? actions.find((candidate) => candidate.type === 'stopCasting')
          : undefined;
      const choice =
        stopCopiedCapstone ??
        rabbleFreeCast ??
        (id.includes('positive') && freeChoice
          ? freeChoice
          : id.endsWith('negative') && decline
            ? decline
            : (modeGoad ??
              mode ??
              sneakCost ??
              actions.find(
                (candidate) =>
                  candidate.type === 'hideawayExile' ||
                  (discard !== undefined && candidate.description.includes(discard)) ||
                  /Forest|Island|PR09 Celebrate Target|hand|put onto the battlefield/i.test(
                    candidate.description,
                  ),
              )));
      if (choice) {
        action = choice;
        const slot = choice.targets?.find((candidate) => candidate.options.length > 0);
        if (slot) {
          const target = state.battlefield.find(
            (permanent) =>
              permanent.name === 'PR09 Goad Target' && slot.options.includes(permanent.id),
          );
          if (target) targets = [{ slot: slot.slot, choice: target.id }];
        }
      }
    }
    if (request.decidingPlayer !== 'P1') {
      const provider = scenario.decisionProviderOverrides?.[request.decidingPlayer];
      if (request.decisionType === 'declareBlockers') {
        const blocks = actions.find((candidate) => candidate.type === 'blockDeclaration');
        if (blocks) {
          action = blocks;
          targets = (blocks.targets ?? []).map((slot) => ({
            slot: slot.slot,
            choice: NO_BLOCK_TARGET,
          }));
        }
        scenario.engine.submit({
          requestId: request.requestId,
          actionId: action.id,
          ...(targets === undefined ? {} : { targets }),
        });
      } else
        scenario.engine.submit(
          provider?.decide(request) ?? { requestId: request.requestId, actionId: pass.id },
        );
    } else {
      scenario.engine.submit({
        requestId: request.requestId,
        actionId: action.id,
        ...(targets === undefined ? {} : { targets }),
      });
    }
    if (
      id === 'pr09-grenzo-havoc-raiser-viewer-goad' &&
      gameState(scenario)
        .battlefield.some(
          (permanent) =>
            permanent.name === 'PR09 Goad Target' &&
            permanent.goadedBy?.some((requirement) => requirement.goaderId === 'P1'),
        )
    )
      return;
  }
  throw new Error(`${id} did not complete in the prepared lab turn limit`);
}

describe('remaining PR09 viewer choice scenarios', () => {
  it('exports stable positive and negative IDs for the first three cards', () => {
    expect(new Set(PR09_CHOICE_SCENARIOS.map((scenario) => scenario.id)).size).toBe(
      PR09_CHOICE_SCENARIOS.length,
    );
    for (const scenario of PR09_CHOICE_SCENARIOS)
      expect(scenario.id).toMatch(
        /-viewer-(positive|negative|sneak-positive|sneak-negative|exile-positive|exile-negative|goad)$/,
      );
    expect(new Set(PR09_CHOICE_SCENARIOS.map((scenario) => scenario.cardName))).toEqual(
      new Set([
        'Path of Discovery',
        'Lurking Predators',
        "New Generation's Technique",
        'Celebrate the Mountain-king',
        'Rabble Rousing',
        "Tibalt's Trickery",
        'Grenzo, Havoc Raiser',
        'Power Pack',
        'Improvisation Capstone',
      ]),
    );
    for (const cardName of new Set(PR09_CHOICE_SCENARIOS.map((scenario) => scenario.cardName))) {
      expect(
        PR09_CHOICE_SCENARIOS.some(
          (scenario) => scenario.cardName === cardName && scenario.id.endsWith('-positive'),
        ),
      ).toBe(true);
      expect(
        PR09_CHOICE_SCENARIOS.some(
          (scenario) => scenario.cardName === cardName && scenario.id.endsWith('-negative'),
        ),
      ).toBe(true);
    }
  });

  it.each(PR09_CHOICE_SCENARIOS)(
    '$id uses the exact pinned card and ordered exercised clauses',
    ({ id, cardName }) => {
      const fixture = pinned(cardName);
      expect(createHash('sha256').update(JSON.stringify(fixture.card)).digest('hex')).toBe(
        fixture.sha256,
      );
      const scenario = pr09ChoiceScenario(id, `server-test-${id}` as never);
      expect(scenario.metadata.id).toBe(id);
      expect(scenario.metadata.oracleSha256).toBe(fixture.sha256);
      const slug = cardName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const expected = fixture.card.oracleText
        .split('\n')
        .map((_, index) => `pr09-${slug}-clause-${index + 1}`);
      expect(scenario.metadata.clauseIds.every((clause) => expected.includes(clause))).toBe(true);
      expect(scenario.metadata.clauseIds).toEqual(
        expected.filter((clause) => scenario.metadata.clauseIds.includes(clause)),
      );
      expect(
        gameState(scenario)
          .players.find((player) => player.id === 'P1')
          ?.hand.some((card) => card.name === cardName),
      ).toBe(true);
    },
  );

  it('Path positive casts both spells and explores the arranged land into hand', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-path-of-discovery-viewer-positive',
      'server-path-positive' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    const p1 = final.players.find((player) => player.id === 'P1')!;
    expect(final.battlefield.some((permanent) => permanent.name === 'Path of Discovery')).toBe(
      true,
    );
    expect(final.battlefield.some((permanent) => permanent.name === 'PR09 Path Creature')).toBe(
      true,
    );
    expect(p1.hand.some((card) => card.name === 'Forest')).toBe(true);
    expect(
      final.eventLog.some(
        (event) => event.type === 'revealCard' && event.payload['name'] === 'Forest',
      ),
    ).toBe(true);
  });

  it('Path negative casts the enchantment and a noncreature without an explore trigger', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-path-of-discovery-viewer-negative',
      'server-path-negative' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(final.battlefield.some((permanent) => permanent.name === 'Path of Discovery')).toBe(
      true,
    );
    expect(final.battlefield.some((permanent) => permanent.name === 'PR09 Path Artifact')).toBe(
      true,
    );
    expect(final.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
  });

  it('Lurking positive casts normally, then P2 casts an instant and the revealed creature enters', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-lurking-predators-viewer-positive',
      'server-lurking-positive' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(
      final.battlefield.some((permanent) => permanent.name === 'Lurking Predators'),
      JSON.stringify({
        hand: final.players.find((player) => player.id === 'P1')!.hand.map((card) => card.name),
        gy: final.players.find((player) => player.id === 'P1')!.graveyard.map((card) => card.name),
        log: final.eventLog.map((event) => event.type),
      }),
    ).toBe(true);
    expect(
      final.battlefield.some((permanent) => permanent.name === 'PR09 Predator Creature'),
      JSON.stringify({
        reveals: final.eventLog
          .filter((event) => event.type === 'revealCard')
          .map((event) => event.payload),
        field: final.battlefield.map((permanent) => permanent.name),
        p2gy: final.players
          .find((player) => player.id === 'P2')!
          .graveyard.map((card) => card.name),
      }),
    ).toBe(true);
    expect(
      final.eventLog.some(
        (event) =>
          event.type === 'revealCard' && event.payload['name'] === 'PR09 Predator Creature',
      ),
    ).toBe(true);
    expect(
      final.players
        .find((player) => player.id === 'P2')!
        .graveyard.some((card) => card.name === 'PR09 Opponent Instant'),
    ).toBe(true);
  });

  it('Lurking negative confirms your own instant causes no reveal', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-lurking-predators-viewer-negative',
      'server-lurking-negative' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(final.battlefield.some((permanent) => permanent.name === 'Lurking Predators')).toBe(
      true,
    );
    expect(
      final.players
        .find((player) => player.id === 'P1')!
        .graveyard.some((card) => card.name === 'PR09 Own Instant'),
    ).toBe(true);
    expect(final.eventLog.some((event) => event.type === 'revealCard')).toBe(false);
  });

  it('New Generation positive pays normally and puts two searched basics onto the battlefield tapped', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-new-generation-s-technique-viewer-positive',
      'server-newgen-positive' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(
      final.players
        .find((player) => player.id === 'P1')!
        .graveyard.some((card) => card.name === "New Generation's Technique"),
    ).toBe(true);
    const tappedBasics = final.battlefield.filter(
      (permanent) =>
        permanent.controllerId === 'P1' &&
        permanent.tapped &&
        ['Forest', 'Island'].includes(permanent.name),
    );
    expect(tappedBasics.length).toBeGreaterThanOrEqual(2);
    expect(final.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('New Generation negative is absent from legal casts with only two mana', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-new-generation-s-technique-viewer-negative',
      'server-newgen-negative' as never,
    );
    const step = scenario.engine.advance();
    expect(step.kind).toBe('gameOver');
    if (step.kind !== 'gameOver') throw new Error('expected no legal cast with insufficient mana');
    expect(step.result.halted).toBe(false);
    expect(
      gameState(scenario)
        .players.find((player) => player.id === 'P1')!
        .hand.some((card) => card.name === "New Generation's Technique"),
    ).toBe(true);
  });

  it('New Generation Sneak attacks, returns its unblocked attacker, then searches', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-new-generation-s-technique-viewer-sneak-positive',
      'server-newgen-sneak-positive' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    const p1 = final.players.find((player) => player.id === 'P1')!;
    expect(p1.hand.some((card) => card.name === 'PR09 Sneak Attacker')).toBe(true);
    expect(p1.graveyard.some((card) => card.name === "New Generation's Technique")).toBe(true);
    expect(
      final.battlefield.filter(
        (permanent) =>
          permanent.controllerId === 'P1' &&
          permanent.tapped &&
          ['Forest', 'Island'].includes(permanent.name),
      ).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('New Generation Sneak is not offered in precombat main', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-new-generation-s-technique-viewer-sneak-negative',
      'server-newgen-sneak-negative' as never,
    );
    const step = scenario.engine.advance();
    expect(step.kind).toBe('decision');
    if (step.kind !== 'decision') throw new Error('expected a main-phase priority request');
    expect(
      step.request.legalActions.some(
        (action) => action.type === 'castSpell' && /Sneak/i.test(action.description),
      ),
    ).toBe(false);
    expect(
      step.request.legalActions.some(
        (action) =>
          action.type === 'castSpell' && action.description.includes("New Generation's Technique"),
      ),
    ).toBe(true);
  });

  it('Celebrate positive draws, discards a nonland, and creates a Human Soldier', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-celebrate-the-mountain-king-viewer-positive',
      'server-celebrate-positive' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(
      final.battlefield.some((permanent) => permanent.name === 'Celebrate the Mountain-king'),
    ).toBe(true);
    expect(
      final.players
        .find((player) => player.id === 'P1')!
        .graveyard.some((card) => card.name === 'PR09 Recruit Discard'),
    ).toBe(true);
    expect(
      final.battlefield.some(
        (permanent) => permanent.isToken && permanent.name === 'Human Soldier',
      ),
    ).toBe(true);
  });

  it('Celebrate negative discards a land and creates no Soldier', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-celebrate-the-mountain-king-viewer-negative',
      'server-celebrate-negative' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(
      final.battlefield.some((permanent) => permanent.name === 'Celebrate the Mountain-king'),
    ).toBe(true);
    expect(
      final.players
        .find((player) => player.id === 'P1')!
        .graveyard.some((card) => card.name === 'PR09 Recruit Land'),
    ).toBe(true);
    expect(
      final.battlefield.some(
        (permanent) => permanent.isToken && permanent.name === 'Human Soldier',
      ),
    ).toBe(false);
  });

  it('Celebrate exile positive returns the targeted opposing object to its owner after the source leaves', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-celebrate-the-mountain-king-viewer-exile-positive',
      'server-celebrate-exile-positive' as never,
    );
    const original = gameState(scenario)
      .battlefield.find((permanent) => permanent.name === 'PR09 Celebrate Target')!;
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    const returned = final.battlefield.find(
      (permanent) => permanent.name === 'PR09 Celebrate Target',
    );
    const targetExile = final.eventLog.findIndex(
      (event) =>
        event.type === 'zoneChange' &&
        event.payload['name'] === 'PR09 Celebrate Target' &&
        event.payload['from'] === 'battlefield' &&
        event.payload['to'] === 'exile',
    );
    const sourceLeave = final.eventLog.findIndex(
      (event) =>
        event.type === 'zoneChange' &&
        event.payload['name'] === 'Celebrate the Mountain-king' &&
        event.payload['from'] === 'battlefield' &&
        event.payload['to'] === 'graveyard',
    );
    const targetReturn = final.eventLog.findIndex(
      (event) =>
        event.type === 'zoneChange' &&
        event.payload['name'] === 'PR09 Celebrate Target' &&
        event.payload['from'] === 'exile' &&
        event.payload['to'] === 'battlefield',
    );
    expect(targetExile).toBeGreaterThanOrEqual(0);
    expect(targetExile).toBeLessThan(sourceLeave);
    expect(sourceLeave).toBeLessThan(targetReturn);
    expect(returned?.controllerId).toBe('P2');
    expect(returned?.ownerId).toBe('P2');
    expect(returned?.id).not.toBe(original.id);
    expect(
      final.players
        .find((player) => player.id === 'P1')!
        .graveyard.some((card) => card.name === 'Celebrate the Mountain-king'),
    ).toBe(true);
    expect(final.exile.some((card) => card.name === 'PR09 Celebrate Target')).toBe(false);
  });

  it('Celebrate exile negative loses its source before resolution, leaving the chosen permanent in place', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-celebrate-the-mountain-king-viewer-exile-negative',
      'server-celebrate-exile-negative' as never,
    );
    const original = gameState(scenario)
      .battlefield.find((permanent) => permanent.name === 'PR09 Celebrate Target')!;
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    const unchanged = final.battlefield.find(
      (permanent) => permanent.name === 'PR09 Celebrate Target',
    );
    expect(unchanged?.controllerId).toBe('P2');
    expect(unchanged?.id).toBe(original.id);
    expect(
      final.players
        .find((player) => player.id === 'P1')!
        .graveyard.some((card) => card.name === 'Celebrate the Mountain-king'),
    ).toBe(true);
    expect(final.exile.some((card) => card.name === 'PR09 Celebrate Target')).toBe(false);
    expect(
      final.eventLog.some(
        (event) =>
          event.type === 'zoneChange' &&
          event.payload['name'] === 'PR09 Celebrate Target' &&
          event.payload['to'] === 'exile',
      ),
    ).toBe(false);
  });

  it('Rabble positive hides away a card and creates a Citizen for its attacker', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-rabble-rousing-viewer-positive',
      'server-rabble-positive' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(final.battlefield.some((permanent) => permanent.name === 'Rabble Rousing')).toBe(true);
    expect(
      final.battlefield.some((permanent) => permanent.isToken && permanent.name === 'Citizen'),
    ).toBe(true);
    expect(
      final.battlefield.filter(
        (permanent) =>
          permanent.name === 'PR09 Rabble Attacker' ||
          /^PR09 Rabble Helper [1-8]$/.test(permanent.name) ||
          (permanent.isToken && permanent.name === 'Citizen'),
      ),
    ).toHaveLength(10);
    expect(
      final.eventLog.some(
        (event) =>
          event.type === 'castSpell' &&
          event.payload['name'] === 'PR09 Rabble Hidden' &&
          event.payload['duringResolution'] === true,
      ),
    ).toBe(true);
    expect(
      final.battlefield.some((permanent) => permanent.name === 'PR09 Rabble Hidden'),
    ).toBe(true);
  });

  it('Rabble negative with no declared attackers creates no Citizen', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-rabble-rousing-viewer-negative',
      'server-rabble-negative' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(final.battlefield.some((permanent) => permanent.name === 'Rabble Rousing')).toBe(true);
    expect(
      final.battlefield.some((permanent) => permanent.isToken && permanent.name === 'Citizen'),
    ).toBe(false);
  });

  it('Trickery positive pays, counters the spell, then P2 casts the different revealed card', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-tibalt-s-trickery-viewer-positive',
      'server-trickery-positive' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(
      final.players
        .find((player) => player.id === 'P2')!
        .graveyard.some((card) => card.name === 'PR09 Opponent Instant'),
    ).toBe(true);
    expect(
      final.players.some((player) =>
        player.graveyard.some((card) => card.name === 'PR09 Trickery Reveal'),
      ),
    ).toBe(true);
    expect(final.players.find((player) => player.id === 'P2')!.life).toBe(41);
    expect(
      final.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'PR09 Trickery Reveal',
      ),
    ).toBe(true);
  });

  it('Trickery negative counters the target but P2 declines the free cast', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-tibalt-s-trickery-viewer-negative',
      'server-trickery-negative' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(
      final.players
        .find((player) => player.id === 'P2')!
        .graveyard.some((card) => card.name === 'PR09 Opponent Instant'),
    ).toBe(true);
    expect(final.players.find((player) => player.id === 'P2')!.life).toBe(40);
    expect(
      final.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'PR09 Trickery Reveal',
      ),
    ).toBe(false);
  });

  it('Grenzo positive attacks, exiles P2’s top card, and casts it with the granted permission', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-grenzo-havoc-raiser-viewer-positive',
      'server-grenzo-positive' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(final.battlefield.some((permanent) => permanent.name === 'Grenzo, Havoc Raiser')).toBe(
      true,
    );
    expect(
      final.battlefield.some((permanent) => permanent.name === 'PR09 Grenzo Reveal'),
      JSON.stringify({
        field: final.battlefield.map((permanent) => permanent.name),
        exile: final.exile.map((card) => card.name),
        events: final.eventLog.map((event) => event.type),
      }),
    ).toBe(true);
    expect(final.eventLog.some((event) => /damage/i.test(event.type))).toBe(true);
  });

  it('Grenzo negative resolves normally but does not trigger without a creature dealing damage', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-grenzo-havoc-raiser-viewer-negative',
      'server-grenzo-negative' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(final.battlefield.some((permanent) => permanent.name === 'Grenzo, Havoc Raiser')).toBe(
      true,
    );
    expect(final.battlefield.some((permanent) => permanent.name === 'PR09 Grenzo Reveal')).toBe(
      false,
    );
  });

  it('Grenzo goad mode targets and goads the creature controlled by the damaged player', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-grenzo-havoc-raiser-viewer-goad',
      'server-grenzo-goad' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(
      final.battlefield.some(
        (permanent) =>
          permanent.name === 'PR09 Goad Target' &&
          permanent.goadedBy?.some((requirement) => requirement.goaderId === 'P1'),
      ),
    ).toBe(true);
    expect(
      final.eventLog.some(
        (event) => /goad/i.test(event.type) || /goad/i.test(JSON.stringify(event.payload)),
      ),
    ).toBe(true);
  });

  it('Power Pack positive attacks, then casts its delayed spell at your next upkeep', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-power-pack-viewer-positive',
      'server-pack-positive' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(final.battlefield.some((permanent) => permanent.name === 'Power Pack')).toBe(true);
    expect(final.players.find((player) => player.id === 'P1')!.life).toBe(41);
    expect(final.exile.some((card) => card.name === 'PR09 Pack Spell')).toBe(true);
    expect(final.players.find((player) => player.id === 'P2')!.life).toBe(36);
    expect(
      final.eventLog.some(
        (event) => event.type === 'damage' && event.payload['amount'] === 4,
      ),
    ).toBe(true);
  });

  it('Power Pack negative has no eligible graveyard card to exile or cast', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-power-pack-viewer-negative',
      'server-pack-negative' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(final.battlefield.some((permanent) => permanent.name === 'Power Pack')).toBe(true);
    expect(final.players.find((player) => player.id === 'P1')!.life).toBe(40);
    expect(final.exile.some((card) => card.name === 'PR09 Pack Spell')).toBe(false);
  });

  it('Capstone positive casts a revealed spell and a later Paradigm copy', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-improvisation-capstone-viewer-positive',
      'server-capstone-positive' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(final.players.find((player) => player.id === 'P1')!.life).toBe(42);
    expect(final.eventLog.some((event) => event.type === 'cardCopied')).toBe(true);
    expect(
      final.players
        .find((player) => player.id === 'P1')!
        .resolvedSpellNames?.filter((name) => name === 'Improvisation Capstone'),
    ).toHaveLength(2);
  });

  it('Capstone negative declines revealed spells while the delayed Paradigm copy exists', () => {
    const scenario = pr09ChoiceScenario(
      'pr09-improvisation-capstone-viewer-negative',
      'server-capstone-negative' as never,
    );
    drive(scenario, scenario.metadata.id);
    const final = gameState(scenario);
    expect(final.players.find((player) => player.id === 'P1')!.life).toBe(40);
    expect(final.eventLog.some((event) => event.type === 'cardCopied')).toBe(true);
  });
});
