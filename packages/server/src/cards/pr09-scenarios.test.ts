import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { OracleCard } from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import type { DecisionRequest, DecisionResponse } from '@mtg/shared';
import { PR09_SCENARIOS, PR09_SCENARIO_IDS } from './pr09-scenario-catalog';
import { pr09Scenario } from './pr09-scenarios';

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
  if (entry === undefined) throw new Error(`Missing PR09 pin ${name}`);
  return entry;
};

describe('first-five PR09 viewer scenarios', () => {
  it('exports stable metadata ids and card names for the first five restored pins', () => {
    expect(PR09_SCENARIO_IDS).toEqual(PR09_SCENARIOS.map((scenario) => scenario.id));
    expect(new Set(PR09_SCENARIO_IDS).size).toBe(PR09_SCENARIO_IDS.length);
    expect(new Set(PR09_SCENARIOS.map((scenario) => scenario.cardName))).toEqual(
      new Set([
        'Chaos Warp',
        'Adaptive Omnitool',
        'Armored Skyhunter',
        'Keen Duelist',
        'Szarekh, the Silent King',
      ]),
    );
  });

  it.each(PR09_SCENARIOS)(
    '$id uses the exact pinned source and only real ordered Oracle clauses',
    ({ id, cardName }) => {
      const fixture = pinned(cardName);
      expect(createHash('sha256').update(JSON.stringify(fixture.card)).digest('hex')).toBe(
        fixture.sha256,
      );
      const scenario = pr09Scenario(id, `server-test-${id}` as never);
      expect(scenario.metadata.id).toBe(id);
      expect(scenario.metadata.oracleSha256).toBe(fixture.sha256);
      expect(scenario.metadata.clauseIds.length).toBeGreaterThan(0);
      const clauseIds = fixture.card.oracleText.split('\n').map((_, index) => {
        const slug = cardName
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '');
        return `pr09-${slug}-clause-${index + 1}`;
      });
      expect(scenario.metadata.clauseIds.every((clause) => clauseIds.includes(clause))).toBe(true);
      expect(scenario.metadata.clauseIds).toEqual(
        clauseIds.filter((clause) => scenario.metadata.clauseIds.includes(clause)),
      );
    },
  );

  it.each(PR09_SCENARIOS)(
    '$id reaches the real first P1 decision with the arranged game state',
    ({ id, cardName }) => {
      const scenario = pr09Scenario(id, `server-interaction-${id}` as never);
      const state = scenario.engine.getState();
      expect(state.players.map((player) => player.id)).toEqual(['P1', 'P2', 'P3', 'P4']);
      expect(
        state.battlefield.some((permanent) => permanent.name === cardName) ||
          state.players[0]!.hand.some((card) => card.name === cardName),
      ).toBe(true);
      let reachedP1 = false;
      for (let i = 0; i < 120; i++) {
        const step = scenario.engine.advance();
        if (step.kind === 'gameOver')
          throw new Error(
            `${id} ended before P1 received a decision: ${step.result.haltReason ?? 'prepared game ended normally'}`,
          );
        if (step.kind === 'continue') continue;
        const request = step.request as DecisionRequest;
        if (request.decidingPlayer === 'P1') {
          expect(request.legalActions.length).toBeGreaterThan(0);
          reachedP1 = true;
          break;
        }
        const override = scenario.decisionProviderOverrides?.[request.decidingPlayer];
        const fallback =
          request.legalActions.find((action) => action.type === 'pass') ?? request.legalActions[0]!;
        scenario.engine.submit(
          override?.decide(request) ?? { requestId: request.requestId, actionId: fallback.id },
        );
      }
      expect(reachedP1).toBe(true);
    },
  );

  it.each(PR09_SCENARIOS)(
    '$id produces its promised outcome through normal actions and triggers',
    ({ id, cardName }) => {
      const scenario = pr09Scenario(id, `server-outcome-${id}` as never);
      const state = scenario.engine.getState();
      const cardInHand =
        id.includes('viewer-cast') ||
        id.includes('chaos-warp') ||
        id.includes('adaptive-omnitool') ||
        id.includes('armored-skyhunter');
      let finished = false;
      for (let decisionCount = 0; decisionCount < 500; decisionCount++) {
        const step = scenario.engine.advance();
        if (step.kind === 'gameOver') {
          expect(step.result.halted, step.result.haltReason ?? '').toBe(false);
          finished = true;
          break;
        }
        if (step.kind === 'continue') continue;
        const request = step.request;
        const actions = request.legalActions;
        let action = actions.find((candidate) => candidate.type === 'pass') ?? actions[0]!;
        let targets: DecisionResponse['targets'];
        if (request.decidingPlayer === 'P1') {
          const targetPermanent = state.battlefield.find(
            (permanent) => permanent.name === 'Lab P2 Artifact',
          );
          const targetHost = state.battlefield.find((permanent) => permanent.name === 'Lab Host');
          const wantsCast =
            cardInHand &&
            state.players
              .find((player) => player.id === 'P1')!
              .hand.some((card) => card.name === cardName);
          if (wantsCast) {
            const cast = actions.find(
              (candidate) =>
                candidate.type === 'castSpell' && candidate.description.includes(cardName),
            );
            if (cast) {
              action = cast;
              const targetSlot = cast.targets?.find(
                (slot) =>
                  targetPermanent !== undefined && slot.options.includes(targetPermanent.id),
              );
              if (targetSlot && targetPermanent)
                targets = [{ slot: targetSlot.slot, choice: targetPermanent.id }];
            }
          }
          if (
            action.type === 'pass' &&
            id.startsWith('pr09-adaptive-omnitool') &&
            state.battlefield.some((permanent) => permanent.name === 'Adaptive Omnitool')
          ) {
            const tool = state.battlefield.find(
              (permanent) => permanent.name === 'Adaptive Omnitool',
            )!;
            if (tool.attachedTo === null) {
              const equip = actions.find(
                (candidate) =>
                  candidate.type === 'activateAbility' &&
                  candidate.description.includes('Equip {3}'),
              );
              if (equip && targetHost) {
                action = equip;
                const slot = equip.targets?.find((candidate) =>
                  candidate.options.includes(targetHost.id),
                );
                if (slot) targets = [{ slot: slot.slot, choice: targetHost.id }];
              }
            }
          }
          const targetChoice = actions.find(
            (candidate) =>
              candidate.targets?.some((slot) => slot.options.includes('P2')) &&
              (/Target|choose target|opponent/i.test(candidate.description) ||
                request.decisionType === 'chooseTargets'),
          );
          if (
            action.type === 'pass' &&
            targetChoice &&
            (id.startsWith('pr09-chaos-warp') || id.startsWith('pr09-keen-duelist'))
          ) {
            action = targetChoice;
            const slot = (targetChoice.targets ?? []).find((candidate) =>
              candidate.options.includes('P2'),
            )!;
            targets = [{ slot: slot.slot, choice: 'P2' }];
          }
          if (action.type === 'pass' && request.decisionType === 'declareAttackers') {
            const attackOption = actions.find(
              (candidate) => candidate.type === 'attackDeclaration',
            );
            const subjects = request.presentation?.attackDeclaration?.subjects ?? [];
            if (attackOption) {
              action = attackOption;
              targets = (attackOption.targets ?? []).map((slot) => {
                const subject = subjects[slot.slot];
                const desired = id.startsWith('pr09-adaptive-omnitool')
                  ? subject?.name === 'Lab Host'
                  : subject?.name === cardName;
                return {
                  slot: slot.slot,
                  choice: desired && slot.options.includes('P2') ? 'P2' : NO_ATTACK_TARGET,
                };
              });
            }
          }
          const wanted = id.includes('omnitool-viewer-positive')
            ? 'Lab Omnitool Hit'
            : id.includes('armored-skyhunter-viewer-positive')
              ? 'Lab Equipment'
              : id.includes('armored-skyhunter-viewer-aura')
                ? 'Lab Aura'
                : id.includes('szarekh-the-silent-king-viewer-positive')
                  ? 'Lab Vehicle'
                  : undefined;
          if (action.type === 'pass' && wanted) {
            const option = actions.find((candidate) => candidate.description.includes(wanted));
            if (option) action = option;
          }
          if (action.type === 'pass' && id.includes('szarekh-the-silent-king-viewer-negative')) {
            const no = actions.find(
              (candidate) =>
                candidate.type === 'decline' || /decline|put no card/i.test(candidate.description),
            );
            if (no) action = no;
          }
          if (
            action.type === 'pass' &&
            id.includes('armored-skyhunter-viewer-positive') &&
            targetHost
          ) {
            const attach = actions.find(
              (candidate) =>
                candidate.targets?.some((slot) => slot.options.includes(targetHost.id)) &&
                /attach/i.test(candidate.description),
            );
            if (attach) {
              action = attach;
              const slot = attach.targets!.find((candidate) =>
                candidate.options.includes(targetHost.id),
              )!;
              targets = [{ slot: slot.slot, choice: targetHost.id }];
            }
          }
        }
        if (request.decidingPlayer === 'P1' && targets === undefined && action.targets?.length) {
          targets = action.targets.map((slot) => ({ slot: slot.slot, choice: slot.options[0]! }));
        }
        if (request.decidingPlayer !== 'P1') {
          const provider = scenario.decisionProviderOverrides?.[request.decidingPlayer];
          const response = provider?.decide(request);
          scenario.engine.submit(response ?? { requestId: request.requestId, actionId: action.id });
        } else {
          scenario.engine.submit({
            requestId: request.requestId,
            actionId: action.id,
            ...(targets === undefined ? {} : { targets }),
          });
        }
      }
      expect(finished, `${id} did not reach its prepared-scenario finish`).toBe(true);
      const final = scenario.engine.getState();
      const p1 = final.players.find((player) => player.id === 'P1')!;
      const p2 = final.players.find((player) => player.id === 'P2')!;
      const events = final.eventLog;
      if (id === 'pr09-chaos-warp-viewer-positive') {
        expect(final.battlefield.some((permanent) => permanent.name === 'Lab P2 Artifact')).toBe(
          false,
        );
        expect(
          events.some(
            (event) =>
              event.type === 'revealCard' &&
              typeof event.payload['name'] === 'string' &&
              (event.payload['name'] === 'Lab Revealed Sorcery' ||
                event.payload['name'].startsWith('Lab Shuffle Filler')),
          ),
        ).toBe(true);
      } else if (id === 'pr09-chaos-warp-viewer-negative') {
        expect(final.battlefield.some((permanent) => permanent.name === 'Lab P2 Artifact')).toBe(
          false,
        );
        expect(
          events.some(
            (event) =>
              event.type === 'revealCard' &&
              typeof event.payload['name'] === 'string' &&
              (event.payload['name'] === 'Lab Revealed Sorcery' ||
                event.payload['name'].startsWith('Lab Shuffle Filler')),
          ),
        ).toBe(false);
      } else if (id.startsWith('pr09-adaptive-omnitool-viewer')) {
        const host = final.battlefield.find((permanent) => permanent.name === 'Lab Host')!;
        const tool = final.battlefield.find((permanent) => permanent.name === 'Adaptive Omnitool')!;
        expect(tool.attachedTo).toBe(host.id);
        expect(p1.hand.some((card) => card.name === 'Lab Omnitool Hit')).toBe(
          id.endsWith('positive'),
        );
        expect(
          events.some(
            (event) => event.type === 'revealCard' && event.payload['name'] === 'Lab Omnitool Hit',
          ),
        ).toBe(id.endsWith('positive'));
      } else if (id.startsWith('pr09-armored-skyhunter')) {
        const putName = id.endsWith('positive')
          ? 'Lab Equipment'
          : id.endsWith('aura')
            ? 'Lab Aura'
            : 'Lab Non-Equipment Artifact';
        const found = final.battlefield.find((permanent) => permanent.name === putName);
        expect(found !== undefined).toBe(!id.endsWith('negative'));
        if (found && id.endsWith('positive'))
          expect(found.attachedTo).toBe(
            final.battlefield.find((permanent) => permanent.name === 'Lab Host')?.id,
          );
        if (found && id.endsWith('aura'))
          expect(found.attachedTo).toBe(
            final.battlefield.find((permanent) => permanent.name === 'Lab Host')?.id,
          );
      } else if (id === 'pr09-keen-duelist-viewer-positive') {
        expect(p1.life).toBe(39);
        expect(p2.life).toBe(37);
        expect(p1.hand.some((card) => card.name === 'Lab P1 Reveal')).toBe(true);
        expect(p2.hand.some((card) => card.name === 'Lab P2 Reveal')).toBe(true);
        expect(events.filter((event) => event.type === 'revealCard')).toHaveLength(2);
      } else if (id === 'pr09-keen-duelist-viewer-negative') {
        expect(p1.hasLost).toBe(false);
        expect(p1.life).toBe(39);
        expect(p2.life).toBe(40);
        expect(p2.hand.some((card) => card.name === 'Lab P2 Reveal')).toBe(true);
      } else if (id === 'pr09-keen-duelist-viewer-cast') {
        expect(final.battlefield.some((permanent) => permanent.name === cardName)).toBe(true);
        expect(events.some((event) => event.type === 'revealCard')).toBe(false);
      } else if (id === 'pr09-szarekh-the-silent-king-viewer-positive') {
        expect(p1.hand.some((card) => card.name === 'Lab Vehicle')).toBe(true);
        expect(p1.graveyard).toHaveLength(2);
      } else if (id === 'pr09-szarekh-the-silent-king-viewer-negative') {
        expect(p1.graveyard.some((card) => card.name === 'Lab Old Artifact Creature')).toBe(true);
        expect(p1.hand.some((card) => card.name.startsWith('Lab Milled'))).toBe(false);
        expect(p1.graveyard).toHaveLength(4);
      } else if (id === 'pr09-szarekh-the-silent-king-viewer-cast') {
        expect(final.battlefield.some((permanent) => permanent.name === cardName)).toBe(true);
        expect(
          events.some((event) => event.type === 'castSpell' && event.payload['name'] === cardName),
        ).toBe(true);
      }
    },
  );
});
