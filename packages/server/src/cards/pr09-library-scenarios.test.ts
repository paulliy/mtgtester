import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { DecisionRequest, OracleCard } from '@mtg/shared';
import { NO_ATTACK_TARGET } from '@mtg/shared';
import type { EnginePermanent } from '../../../engine/src/state/types';
import { PR09_LIBRARY_SCENARIOS, pr09LibraryScenario } from './pr09-library-scenarios';

const pinFile = JSON.parse(
  readFileSync('packages/engine/tests/fixtures/coverage-pr09-oracle.json', 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };

function run(id: string) {
  const scenario = pr09LibraryScenario(id, `viewer-${id}`);
  const initialP1View = JSON.stringify(scenario.engine.view('P1'));
  const initialP2View = JSON.stringify(scenario.engine.view('P2'));
  let cast = false;
  let activated = false;
  let reboundCast = false;
  let etaliExiledAllBeforeChoice = false;
  let decisions = 0;
  for (;;) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const req = step.request as DecisionRequest;
    if (
      id.startsWith('pr09-etali') &&
      !etaliExiledAllBeforeChoice &&
      req.legalActions.some(
        (candidate) =>
          candidate.type === 'castSpell' && candidate.description.includes('PR09 Library Spell'),
      )
    ) {
      etaliExiledAllBeforeChoice = ['P1', 'P2', 'P3', 'P4'].every((seat) =>
        scenario.engine
          .getState()
          .exile.some((card) => card.ownerId === seat && card.name === 'PR09 Library Spell'),
      );
    }
    const expectedCard = scenario.metadata.title.split(':')[0]!;
    let action = req.legalActions.find(
      (candidate) =>
        !cast &&
        candidate.type === 'castSpell' &&
        candidate.description.startsWith(`Cast ${expectedCard}`),
    );
    if (action) cast = true;
    if (!action && id === 'pr09-mystic-forge-viewer-positive') {
      action = req.legalActions.find(
        (candidate) =>
          candidate.type === 'castSpell' && candidate.description.includes('PR09 Forge Artifact'),
      );
    }
    if (!action && id.startsWith('pr09-sunbirds-invocation') && cast) {
      action = req.legalActions.find(
        (candidate) =>
          candidate.type === 'castSpell' && candidate.description.includes('PR09 Library Spell'),
      );
    }
    if (!action && id.startsWith('pr09-minds-dilation')) {
      action = req.legalActions.find(
        (candidate) =>
          candidate.type === 'castSpell' && candidate.description.includes('PR09 Library Spell'),
      );
      if (action) cast = true;
    }
    if (
      !action &&
      id.startsWith('pr09-into-the-time-vortex') &&
      /Rebound: cast this card/i.test(req.prompt)
    ) {
      action = req.legalActions.find((candidate) =>
        /Cast .* without paying its mana cost/i.test(candidate.description),
      );
      reboundCast = action !== undefined;
    }
    if (!action && id.endsWith('activation')) {
      action = req.legalActions.find(
        (candidate) =>
          candidate.type === 'activateAbility' && candidate.description.includes('Mystic Forge'),
      );
      if (action) activated = true;
    }
    if (!action && id.endsWith('viewer-transform')) {
      action = req.legalActions.find(
        (candidate) =>
          candidate.type === 'activateAbility' && /transform/i.test(candidate.description),
      );
      if (action) activated = true;
    }
    let targets: { slot: number; choice: string }[] | undefined;
    if (req.decisionType === 'declareAttackers') {
      const attack = req.legalActions.find((candidate) => candidate.type === 'attackDeclaration');
      if (attack) {
        action = attack;
        targets = (attack.targets ?? []).map((slot) => ({
          slot: slot.slot,
          choice:
            (req.presentation?.attackDeclaration?.subjects?.[slot.slot]?.name ===
              'PR09 Library Host' ||
              (id.endsWith('viewer-transform') &&
                String(req.presentation?.attackDeclaration?.subjects?.[slot.slot]?.name).includes(
                  'Etali',
                ))) &&
            slot.options.includes('P2')
              ? 'P2'
              : NO_ATTACK_TARGET,
        }));
      }
    }
    action ??=
      req.legalActions.find((candidate) => candidate.type === 'pass') ?? req.legalActions[0]!;
    scenario.engine.submit({
      requestId: req.requestId,
      actionId: action.id,
      ...(targets ? { targets } : {}),
    });
    if (++decisions > 300) throw new Error(`${id} exceeded 300 decisions`);
  }
  return {
    scenario,
    cast,
    activated,
    reboundCast,
    etaliExiledAllBeforeChoice,
    decisions,
    initialP1View,
    initialP2View,
    state: scenario.engine.getState(),
  };
}

describe('PR09 library viewer scenarios', () => {
  it('pins the eight restored production Oracle definitions', () => {
    for (const item of pinFile.cards)
      expect(createHash('sha256').update(JSON.stringify(item.card)).digest('hex')).toBe(
        item.sha256,
      );
    expect(PR09_LIBRARY_SCENARIOS).toHaveLength(18);
    for (const item of PR09_LIBRARY_SCENARIOS) {
      const pin = pinFile.cards.find((entry) => entry.card.name === item.cardName);
      expect(pin, item.cardName).toBeDefined();
      expect(pr09LibraryScenario(item.id, `pin-${item.id}`).metadata.oracleSha256).toBe(
        pin!.sha256,
      );
    }
  });

  it.each(PR09_LIBRARY_SCENARIOS)(
    '$id uses the prepared engine cast/activation path and records actual events',
    ({ id }) => {
      const result = run(id);
      const { scenario } = result;
      const sourceName = PR09_LIBRARY_SCENARIOS.find((entry) => entry.id === id)!.cardName;
      const pinnedCard = pinFile.cards.find((entry) => entry.card.name === sourceName)!.card;
      const canonicalSlug = sourceName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const indexes =
        id === 'pr09-mystic-forge-viewer-activation'
          ? [2]
          : id.startsWith('pr09-mystic-forge')
            ? [0, 1]
            : id.startsWith('pr09-songbirds-blessing')
              ? [0, 1]
              : id.endsWith('viewer-transform')
                ? [2, 3, 4]
                : id.startsWith('pr09-etali')
                  ? [0, 1]
                  : Array.from(
                      { length: pinnedCard.oracleText.split(/\r?\n/).length },
                      (_, index) => index,
                    );
      expect(scenario.metadata.clauseIds).toEqual(
        indexes.map((index) => `pr09-${canonicalSlug}-clause-${index + 1}`),
      );
      expect(result.decisions).toBeLessThanOrEqual(300);
      if (id.endsWith('activation') || id.endsWith('viewer-transform'))
        expect(result.activated).toBe(true);
      else if (!id.startsWith('pr09-minds-dilation') && id !== 'pr09-mystic-forge-viewer-negative')
        expect(result.cast).toBe(true);
      const log = scenario.engine.getState().eventLog;
      if (id.endsWith('activation') || id.endsWith('viewer-transform')) {
        const sourceName = id.endsWith('viewer-transform')
          ? 'Etali, Primal Conqueror // Etali, Primal Sickness'
          : 'Mystic Forge';
        expect(
          log.some(
            (event) =>
              event.type === 'activateAbility' &&
              String(event.payload['source']).includes(sourceName.split(' // ')[0]!),
          ),
        ).toBe(true);
      } else if (
        !id.startsWith('pr09-minds-dilation') &&
        id !== 'pr09-mystic-forge-viewer-negative'
      ) {
        const cardName = scenario.metadata.title.split(':')[0]!;
        expect(
          log.some(
            (event) =>
              event.type === 'castSpell' &&
              (cardName.startsWith('Etali,')
                ? String(event.payload['name']).startsWith('Etali, Primal Conqueror')
                : event.payload['name'] === cardName),
          ),
        ).toBe(true);
      }
      if (id.startsWith('pr09-songbirds-blessing')) {
        const auraOnField = result.state.battlefield.find(
          (permanent) => permanent.name === 'PR09 Library Aura',
        );
        const p1 = result.state.players.find((player) => player.id === 'P1')!;
        if (id.endsWith('positive'))
          expect(auraOnField?.attachedTo).toBe(
            result.state.battlefield.find((permanent) => permanent.name === 'PR09 Library Host')
              ?.id,
          );
        else {
          expect(auraOnField).toBeUndefined();
          expect(log.filter((event) => event.type === 'revealCard').length).toBeGreaterThan(0);
          expect(p1.hand.some((card) => card.name === 'PR09 Library Aura')).toBe(false);
        }
      }
      if (id === 'pr09-mystic-forge-viewer-positive')
        expect(
          result.state.battlefield.some((permanent) => permanent.name === 'PR09 Forge Artifact'),
        ).toBe(true);
      if (id.startsWith('pr09-mystic-forge')) {
        const topName = id.endsWith('negative')
          ? 'PR09 Forge Colored Spell'
          : 'PR09 Forge Artifact';
        expect(result.initialP1View).toContain(topName);
        expect(result.initialP2View).not.toContain(topName);
      }
      if (id === 'pr09-mystic-forge-viewer-negative')
        expect(
          result.state.eventLog.some(
            (event) =>
              event.type === 'castSpell' && event.payload['name'] === 'PR09 Forge Colored Spell',
          ),
        ).toBe(false);
      if (id.endsWith('activation'))
        expect(result.state.exile.some((card) => card.name === 'PR09 Forge Artifact')).toBe(true);
      if (id.startsWith('pr09-etali')) {
        expect(
          log.filter((event) => event.type === 'zoneChange' && event.payload['to'] === 'exile')
            .length,
        ).toBeGreaterThanOrEqual(id.endsWith('positive') ? 4 : 0);
        expect(
          log.some(
            (event) =>
              event.type === 'castSpell' &&
              String(event.payload['name']).includes('PR09 Library Spell'),
          ),
        ).toBe(id.endsWith('positive'));
      }
      if (id.startsWith('pr09-sunbirds-invocation')) {
        expect(
          log.filter(
            (event) => event.type === 'castSpell' && event.payload['name'] === 'PR09 Library Spell',
          ),
        ).toHaveLength(id.endsWith('positive') ? 2 : 1);
        expect(log.filter((event) => event.type === 'revealCard').length).toBeGreaterThan(0);
      }
      if (id.startsWith('pr09-minds-dilation')) {
        expect(
          log.filter(
            (event) => event.type === 'castSpell' && event.payload['name'] === 'PR09 Library Spell',
          ),
        ).toHaveLength(id.endsWith('positive') ? 2 : 1);
      }
      if (id.startsWith('pr09-expressive-iteration')) {
        expect(
          log.some((event) => event.type === 'zoneChange' && event.payload['to'] === 'exile'),
        ).toBe(true);
        if (id.endsWith('positive')) {
          const named = ['PR09 Library Spell', 'PR09 Library Miss', 'PR09 Library Aura'];
          expect(
            named.filter((name) =>
              result.state.players
                .find((player) => player.id === 'P1')!
                .hand.some((card) => card.name === name),
            ),
          ).toHaveLength(1);
          expect(
            named.filter((name) => result.state.exile.some((card) => card.name === name)),
          ).toHaveLength(1);
        }
      }
      if (id.startsWith('pr09-genesis-ultimatum') && id.endsWith('positive')) {
        expect(
          result.state.battlefield.some((permanent) => permanent.name === 'PR09 Genesis Creature'),
        ).toBe(true);
        expect(
          result.state.players
            .find((player) => player.id === 'P1')!
            .hand.some((card) => card.name === 'PR09 Library Spell'),
        ).toBe(true);
        expect(result.state.exile.some((card) => card.name === 'Genesis Ultimatum')).toBe(true);
      }
      if (id.startsWith('pr09-into-the-time-vortex') && id.endsWith('positive')) {
        expect(
          log.some(
            (event) =>
              event.type === 'castFree' ||
              (event.type === 'castSpell' && event.payload['name'] === 'PR09 Library Spell'),
          ),
        ).toBe(true);
        expect(
          result.state.players
            .find((player) => player.id === 'P1')!
            .graveyard.some((card) => card.name === 'Into the Time Vortex'),
        ).toBe(true);
        expect(result.reboundCast).toBe(true);
        expect(
          log.filter(
            (event) =>
              event.type === 'castSpell' && event.payload['name'] === 'Into the Time Vortex',
          ),
        ).toHaveLength(2);
      }
      if (id.endsWith('viewer-transform')) {
        const transformed = result.state.battlefield.find((permanent) =>
          permanent.name.includes('Etali'),
        ) as EnginePermanent | undefined;
        expect(transformed?.transformed).toBe(true);
        const p2 = result.state.players.find((player) => player.id === 'P2')!;
        expect(p2.life).toBe(29);
        expect(p2.poisonCounters).toBe(11);
      }
    },
  );
});
