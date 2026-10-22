import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DecisionRequest, LegalAction, OracleCard } from '@mtg/shared';
import { PR09_PERMANENT_SCENARIOS, pr09PermanentScenario } from './pr09-permanent-scenarios';

const pins = (
  JSON.parse(readFileSync('packages/engine/tests/fixtures/coverage-pr09-oracle.json', 'utf8')) as {
    cards: { sha256: string; card: OracleCard }[];
  }
).cards;
const pin = (name: string) => {
  const entry = pins.find((candidate) => candidate.card.name === name);
  if (!entry) throw new Error(`Missing PR09 pin ${name}`);
  return entry;
};

function submit(
  scenario: ReturnType<typeof pr09PermanentScenario>,
  request: DecisionRequest,
  action: LegalAction,
) {
  const targets = (action.targets ?? []).flatMap((slot) =>
    slot.options.length ? [{ slot: slot.slot, choice: slot.options[0]! }] : [],
  );
  scenario.engine.submit({
    requestId: request.requestId,
    actionId: action.id,
    ...(targets.length ? { targets } : {}),
  });
}

function runUntil(
  scenario: ReturnType<typeof pr09PermanentScenario>,
  stop: (request: DecisionRequest) => boolean,
) {
  let chosen = false;
  for (let i = 0; i < 300; i++) {
    const step = scenario.engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    const request = step.request as DecisionRequest;
    if (stop(request)) {
      chosen = true;
      break;
    }
    const selected =
      request.decisionType === 'declareAttackers'
        ? (request.legalActions.find(
            (action) => action.type !== 'pass' && action.type !== 'passAndYieldTurn',
          ) ?? request.legalActions[0]!)
        : (request.legalActions.find((action) => action.type === 'castFree') ??
          request.legalActions.find((action) => action.type === 'pass') ??
          request.legalActions[0]!);
    submit(scenario, request, selected);
  }
  return chosen;
}

describe('PR09 remaining permanent viewer scenarios', () => {
  it('exports stable scenario ids and the requested pinned cards', () => {
    expect(new Set(PR09_PERMANENT_SCENARIOS.map((entry) => entry.id)).size).toBe(
      PR09_PERMANENT_SCENARIOS.length,
    );
    expect(new Set(PR09_PERMANENT_SCENARIOS.map((entry) => entry.cardName))).toEqual(
      new Set([
        'Dark Confidant',
        'Dream Pillager',
        'Aetherworks Marvel',
        'Herald of Amity',
        'Cosmic Cube',
        'Franklin Richards, Ascendant',
        'Monstrous Vortex',
        'Chimil, the Inner Sun',
        'Trumpeting Carnosaur',
      ]),
    );
    for (const { id, cardName } of PR09_PERMANENT_SCENARIOS) {
      expect(id).toMatch(/^pr09-[a-z0-9-]+-viewer-(positive|negative|activation|attack|discard)$/);
      const fixture = pin(cardName);
      expect(createHash('sha256').update(JSON.stringify(fixture.card)).digest('hex')).toBe(
        fixture.sha256,
      );
      const scenario = pr09PermanentScenario(id, `server-test-${id}` as never);
      expect(scenario.metadata.id).toBe(id);
      expect(scenario.metadata.oracleSha256).toBe(fixture.sha256);
      const slug = cardName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      const orderedClauses = fixture.card.oracleText
        .split('\n')
        .map((_, index) => `pr09-${slug}-clause-${index + 1}`);
      expect(scenario.metadata.clauseIds.length).toBeGreaterThan(0);
      expect(scenario.metadata.clauseIds.every((clause) => orderedClauses.includes(clause))).toBe(
        true,
      );
      expect(scenario.metadata.clauseIds).toEqual(
        orderedClauses.filter((clause) => scenario.metadata.clauseIds.includes(clause)),
      );
      expect(scenario.engine.getState().players.map((player) => player.id)).toEqual([
        'P1',
        'P2',
        'P3',
        'P4',
      ]);
    }
  });

  it('drives Aetherworks Marvel through its real activation and casts the selected library spell', () => {
    const scenario = pr09PermanentScenario(
      'pr09-aetherworks-marvel-viewer-activation',
      'viewer-marvel' as never,
    );
    expect(
      runUntil(scenario, (request) => {
        if (request.decidingPlayer !== 'P1') return false;
        const action = request.legalActions.find(
          (item) =>
            item.type === 'activateAbility' && item.description.includes('Aetherworks Marvel'),
        );
        if (!action) return false;
        submit(scenario, request, action);
        return true;
      }),
    ).toBe(true);
    runUntil(scenario, (request) => {
      if (request.decidingPlayer !== 'P1') return false;
      const action = request.legalActions.find(
        (item) => item.type === 'castFree' && item.description.includes('PR09 Viewer Spell'),
      );
      if (!action) return false;
      submit(scenario, request, action);
      return true;
    });
    runUntil(scenario, () => false);
    expect(
      scenario.engine.getState().eventLog.map((event) => [event.type, event.payload['name']]),
      JSON.stringify(scenario.engine.getState().eventLog.at(-1)?.payload),
    ).toContainEqual(['castSpell', 'PR09 Viewer Spell']);
  });

  it('casts Herald normally, resolves its ETB, and puts the selected Aura on its prepared host', () => {
    const scenario = pr09PermanentScenario(
      'pr09-herald-of-amity-viewer-positive',
      'viewer-herald' as never,
    );
    expect(
      runUntil(scenario, (request) => {
        if (request.decidingPlayer !== 'P1') return false;
        const action = request.legalActions.find(
          (item) => item.type === 'castSpell' && item.description.includes('Herald of Amity'),
        );
        if (!action) return false;
        submit(scenario, request, action);
        return true;
      }),
    ).toBe(true);
    runUntil(scenario, (request) => {
      if (request.decidingPlayer !== 'P1') return false;
      const action = request.legalActions.find(
        (item) => item.type === 'castFree' && item.description.includes('PR09 Viewer Aura'),
      );
      if (!action) return false;
      const hostId = scenario.engine
        .getState()
        .battlefield.find((permanent) => permanent.name === 'PR09 Viewer Host')?.id;
      const targets = (action.targets ?? []).map((slot) => ({
        slot: slot.slot,
        choice: slot.options.find((candidate) => candidate === hostId) ?? slot.options[0]!,
      }));
      scenario.engine.submit({
        requestId: request.requestId,
        actionId: action.id,
        ...(targets.length ? { targets } : {}),
      });
      return true;
    });
    runUntil(scenario, () => false);
    const state = scenario.engine.getState();
    expect(state.eventLog.map((event) => [event.type, event.payload['name']])).toContainEqual([
      'castSpell',
      'PR09 Viewer Aura',
    ]);
    expect(
      state.battlefield.some(
        (permanent) =>
          permanent.name === 'PR09 Viewer Aura' &&
          permanent.attachedTo ===
            state.battlefield.find((permanent) => permanent.name === 'PR09 Viewer Host')?.id,
      ),
    ).toBe(true);
  });

  it('casts Herald with no eligible Aura and leaves the Aura-creature in the library', () => {
    const scenario = pr09PermanentScenario(
      'pr09-herald-of-amity-viewer-negative',
      'viewer-herald-negative' as never,
    );
    runUntil(scenario, (request) => {
      if (request.decidingPlayer !== 'P1') return false;
      const action = request.legalActions.find(
        (item) => item.type === 'castSpell' && item.description.includes('Herald of Amity'),
      );
      if (!action) return false;
      submit(scenario, request, action);
      return true;
    });
    runUntil(scenario, () => false);
    const state = scenario.engine.getState();
    expect(
      state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'PR09 Aura Creature',
      ),
    ).toBe(false);
    expect(
      state.players
        .find((player) => player.id === 'P1')
        ?.library.some((card) => card.name === 'PR09 Aura Creature'),
    ).toBe(true);
  });

  it('attacks with Herald of Amity and applies its Aura-count pump', () => {
    const scenario = pr09PermanentScenario(
      'pr09-herald-of-amity-viewer-attack',
      'viewer-herald-attack' as never,
    );
    runUntil(scenario, () => false);
    const state = scenario.engine.getState();
    const herald = state.battlefield.find((permanent) => permanent.name === 'Herald of Amity');
    expect(
      state.eventLog.some(
        (event) => event.type === 'attack' && event.payload['attacker'] === 'Herald of Amity',
      ),
    ).toBe(true);
    expect(herald).toBeDefined();
    expect(
      state.eventLog.some(
        (event) =>
          event.type === 'pump' &&
          String(event.payload['source']).startsWith('Herald of Amity') &&
          event.payload['target'] === 'Herald of Amity' &&
          event.payload['power'] === 1 &&
          event.payload['toughness'] === 1,
      ),
    ).toBe(true);
  });

  it('casts Trumpeting Carnosaur normally, resolves Discover, and casts the eligible result', () => {
    const scenario = pr09PermanentScenario(
      'pr09-trumpeting-carnosaur-viewer-positive',
      'viewer-carnosaur' as never,
    );
    runUntil(scenario, (request) => {
      if (request.decidingPlayer !== 'P1') return false;
      const action = request.legalActions.find(
        (item) => item.type === 'castSpell' && item.description.includes('Trumpeting Carnosaur'),
      );
      if (!action) return false;
      submit(scenario, request, action);
      return true;
    });
    runUntil(scenario, (request) => {
      if (request.decidingPlayer !== 'P1') return false;
      const action = request.legalActions.find(
        (item) => item.type === 'castFree' && item.description.includes('PR09 Viewer Spell'),
      );
      if (!action) return false;
      submit(scenario, request, action);
      return true;
    });
    runUntil(scenario, () => false);
    expect(
      scenario.engine
        .getState()
        .eventLog.some(
          (event) => event.type === 'castSpell' && event.payload['name'] === 'PR09 Viewer Spell',
        ),
      JSON.stringify(
        scenario.engine.getState().eventLog.map((event) => [event.type, event.payload]),
      ),
    ).toBe(true);
  });

  it('keeps Chimil own spell uncountered before resolving its prepared end-step trigger', () => {
    const scenario = pr09PermanentScenario(
      'pr09-chimil-the-inner-sun-viewer-positive',
      'viewer-chimil-uncounterable' as never,
    );
    expect(
      runUntil(scenario, (request) => {
        if (request.decidingPlayer !== 'P1') return false;
        const action = request.legalActions.find(
          (item) => item.type === 'castSpell' && item.description.includes('PR09 Viewer Instant'),
        );
        if (!action) return false;
        submit(scenario, request, action);
        return true;
      }),
    ).toBe(true);
    expect(
      runUntil(scenario, (request) => {
        if (request.decidingPlayer !== 'P1') return false;
        const action = request.legalActions.find(
          (item) => item.type === 'castSpell' && item.description.includes('PR09 Viewer Counter'),
        );
        if (!action) return false;
        const target = action.targets?.find((slot) =>
          slot.options.some((option) =>
            scenario.engine.getState().stack.some((item) => item.id === option),
          ),
        );
        expect(target?.options).toContain(scenario.engine.getState().stack.at(-1)?.id);
        submit(scenario, request, action);
        return true;
      }),
    ).toBe(true);
    runUntil(scenario, () => false);
    const state = scenario.engine.getState();
    expect(state.players.find((player) => player.id === 'P1')?.life).toBe(42);
    expect(
      state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'PR09 Viewer Spell',
      ),
    ).toBe(true);
    expect(
      state.eventLog.some(
        (event) =>
          event.type === 'zoneChange' &&
          event.payload['name'] === 'PR09 Viewer Instant' &&
          event.payload['to'] === 'graveyard',
      ),
    ).toBe(true);
  });

  it('activates Trumpeting Carnosaur from hand, pays its discard cost, and deals three damage', () => {
    const scenario = pr09PermanentScenario(
      'pr09-trumpeting-carnosaur-viewer-discard',
      'viewer-carnosaur-discard' as never,
    );
    runUntil(scenario, (request) => {
      if (request.decidingPlayer !== 'P1') return false;
      const action = request.legalActions.find(
        (item) =>
          item.type === 'activateAbility' && item.description.includes('Trumpeting Carnosaur'),
      );
      if (!action) return false;
      submit(scenario, request, action);
      return true;
    });
    runUntil(scenario, () => false);
    const events = scenario.engine.getState().eventLog;
    expect(
      events.some(
        (event) =>
          event.type === 'damage' &&
          String(event.payload['source']).includes('Trumpeting Carnosaur') &&
          event.payload['amount'] === 3,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === 'zoneChange' &&
          event.payload['name'] === 'Trumpeting Carnosaur' &&
          event.payload['from'] === 'hand' &&
          event.payload['to'] === 'graveyard',
      ),
    ).toBe(true);
    expect(
      scenario.engine
        .getState()
        .players.find((player) => player.id === 'P2')
        ?.graveyard.some((card) => card.name === 'PR09 Viewer Creature'),
    ).toBe(true);
  });

  it.each([
    ['pr09-dream-pillager-viewer-positive', 'PR09 Viewer Spell'],
    ['pr09-cosmic-cube-viewer-positive', 'PR09 Viewer Spell'],
    ['pr09-franklin-richards-ascendant-viewer-positive', 'PR09 Viewer Discover Hit'],
    ['pr09-monstrous-vortex-viewer-positive', 'PR09 Viewer Spell'],
    ['pr09-chimil-the-inner-sun-viewer-positive', 'PR09 Viewer Spell'],
  ])('%s resolves its real prepared trigger and casts %s', (id, pickedName) => {
    const scenario = pr09PermanentScenario(id, `viewer-${id}` as never);
    if (
      id === 'pr09-franklin-richards-ascendant-viewer-positive' ||
      id === 'pr09-monstrous-vortex-viewer-positive'
    ) {
      const castName = id.startsWith('pr09-franklin')
        ? 'PR09 Viewer Spell'
        : 'PR09 Viewer Creature';
      runUntil(scenario, (request) => {
        if (request.decidingPlayer !== 'P1') return false;
        const action = request.legalActions.find(
          (item) => item.type === 'castSpell' && item.description.includes(castName),
        );
        if (!action) return false;
        submit(scenario, request, action);
        return true;
      });
    }
    runUntil(scenario, (request) => {
      if (request.decidingPlayer !== 'P1') return false;
      const actionType = id === 'pr09-dream-pillager-viewer-positive' ? 'castSpell' : 'castFree';
      const action = request.legalActions.find(
        (item) => item.type === actionType && item.description.includes(pickedName),
      );
      if (!action) return false;
      submit(scenario, request, action);
      return true;
    });
    runUntil(scenario, () => false);
    expect(
      scenario.engine
        .getState()
        .eventLog.some(
          (event) => event.type === 'castSpell' && event.payload['name'] === pickedName,
        ),
      JSON.stringify(
        scenario.engine.getState().eventLog.map((event) => [event.type, event.payload]),
      ),
    ).toBe(true);
  });

  it('Dark Confidant reveals the upkeep top card, puts it in hand, and loses its mana value in life', () => {
    const scenario = pr09PermanentScenario(
      'pr09-dark-confidant-viewer-positive',
      'viewer-dark-confidant' as never,
    );
    runUntil(scenario, () => false);
    const state = scenario.engine.getState();
    expect(state.players.find((player) => player.id === 'P1')?.life).toBe(39);
    expect(
      state.players
        .find((player) => player.id === 'P1')
        ?.hand.some((card) => card.name === 'PR09 Viewer Spell'),
    ).toBe(true);
  });

  it('Dark Confidant with an empty library causes no life loss or deck-out', () => {
    const scenario = pr09PermanentScenario(
      'pr09-dark-confidant-viewer-negative',
      'viewer-dark-empty' as never,
    );
    runUntil(scenario, () => false);
    expect(scenario.engine.getState().players.find((player) => player.id === 'P1')?.life).toBe(40);
    expect(
      scenario.engine.getState().players.find((player) => player.id === 'P1')?.lossReason,
    ).toBeNull();
  });

  it('Aetherworks Marvel has no activation without the six energy counters', () => {
    const scenario = pr09PermanentScenario(
      'pr09-aetherworks-marvel-viewer-negative',
      'viewer-marvel-no-energy' as never,
    );
    const step = scenario.engine.advance();
    expect(step.kind).toBe('decision');
    if (step.kind !== 'decision') return;
    expect(
      step.request.legalActions.some(
        (action) =>
          action.type === 'activateAbility' && action.description.includes('Aetherworks Marvel'),
      ),
    ).toBe(false);
  });

  it('Aetherworks positive viewer scenario earns the sixth energy and activates Marvel', () => {
    const scenario = pr09PermanentScenario(
      'pr09-aetherworks-marvel-viewer-positive',
      'viewer-marvel-energy' as never,
    );
    expect(
      runUntil(scenario, (request) => {
        if (request.decidingPlayer !== 'P1') return false;
        const action = request.legalActions.find(
          (item) =>
            item.type === 'castSpell' && item.description.includes('PR09 Viewer Artifact Removal'),
        );
        if (!action) return false;
        const sacrificeArtifact = scenario.engine
          .view('P1')
          .battlefield.find((permanent) => permanent.name === 'PR09 Viewer Sacrifice Artifact');
        const targets = (action.targets ?? []).flatMap((slot) => {
          const choice = slot.options.find((option) => option === sacrificeArtifact?.id);
          return choice ? [{ slot: slot.slot, choice }] : [];
        });
        scenario.engine.submit({
          requestId: request.requestId,
          actionId: action.id,
          ...(targets.length ? { targets } : {}),
        });
        return true;
      }),
    ).toBe(true);
    expect(
      runUntil(scenario, (request) => {
        if (request.decidingPlayer !== 'P1') return false;
        const action = request.legalActions.find(
          (item) =>
            item.type === 'activateAbility' && item.description.includes('Aetherworks Marvel'),
        );
        if (!action) return false;
        submit(scenario, request, action);
        return true;
      }),
    ).toBe(true);
    expect(
      runUntil(scenario, (request) => {
        if (request.decidingPlayer !== 'P1') return false;
        const action = request.legalActions.find(
          (item) => item.type === 'castFree' && item.description.includes('PR09 Viewer Spell'),
        );
        if (!action) return false;
        submit(scenario, request, action);
        return true;
      }),
    ).toBe(true);
    runUntil(scenario, () => false);
    const state = scenario.engine.getState();
    expect(state.players.find((player) => player.id === 'P1')?.energy).toBe(0);
    expect(
      state.eventLog.some(
        (event) =>
          event.type === 'activateAbility' && event.payload['source'] === 'Aetherworks Marvel',
      ),
    ).toBe(true);
    expect(
      state.eventLog.some(
        (event) =>
          event.type === 'energy' &&
          event.payload['player'] === 'P1' &&
          event.payload['total'] === 6,
      ),
    ).toBe(true);
    expect(
      state.eventLog.some(
        (event) => event.type === 'castSpell' && event.payload['name'] === 'PR09 Viewer Spell',
      ),
    ).toBe(true);
  });

  it.each([
    ['pay', true],
    ['decline', false],
  ] as const)(
    'Cosmic Cube Ward %s controls whether the targeted Cube is destroyed',
    (_choice, payWard) => {
      const scenario = pr09PermanentScenario(
        'pr09-cosmic-cube-viewer-positive',
        `viewer-cosmic-ward-${payWard}` as never,
      );
      const targetId = scenario.engine
        .getState()
        .battlefield.find(
          (permanent) => permanent.name === 'Cosmic Cube' && permanent.controllerId === 'P2',
        )?.id;
      expect(targetId).toBeDefined();
      expect(
        runUntil(scenario, (request) => {
          if (request.decidingPlayer !== 'P1') return false;
          const action = request.legalActions.find(
            (item) =>
              item.type === 'castSpell' &&
              item.description.includes('PR09 Viewer Artifact Removal'),
          );
          if (!action) return false;
          const targets = (action.targets ?? []).map((slot) => {
            expect(slot.options).toContain(targetId);
            return { slot: slot.slot, choice: targetId! };
          });
          scenario.engine.submit({
            requestId: request.requestId,
            actionId: action.id,
            targets,
          });
          return true;
        }),
      ).toBe(true);
      let wardRequest: DecisionRequest | null = null;
      expect(
        runUntil(scenario, (request) => {
          if (request.decidingPlayer !== 'P1' || request.decisionType !== 'general') return false;
          const hasWardChoices =
            request.legalActions.some((action) => action.type === 'payCost') &&
            request.legalActions.some((action) => action.type === 'decline');
          if (hasWardChoices) wardRequest = request;
          return hasWardChoices;
        }),
      ).toBe(true);
      expect(wardRequest).not.toBeNull();
      const request = wardRequest!;
      expect(request.prompt).toMatch(/pay \{2\}/i);
      const wardChoice = request.legalActions.find(
        (action) => action.type === (payWard ? 'payCost' : 'decline'),
      );
      expect(wardChoice).toBeDefined();
      submit(scenario, request, wardChoice!);
      runUntil(scenario, () => false);
      const state = scenario.engine.getState();
      expect(state.battlefield.some((permanent) => permanent.id === targetId)).toBe(!payWard);
      expect(
        state.players
          .find((player) => player.id === 'P2')
          ?.graveyard.some((card) => card.name === 'Cosmic Cube'),
      ).toBe(payWard);
      expect(
        state.players
          .find((player) => player.id === 'P1')
          ?.graveyard.some((card) => card.name === 'PR09 Viewer Artifact Removal'),
      ).toBe(true);
    },
  );

  it.each([
    ['pr09-dream-pillager-viewer-negative', 'PR09 Viewer Spell', null],
    ['pr09-cosmic-cube-viewer-negative', 'PR09 Viewer Spell', null],
    [
      'pr09-franklin-richards-ascendant-viewer-negative',
      'PR09 Viewer Discover Hit',
      'PR09 Viewer Spell',
    ],
    ['pr09-monstrous-vortex-viewer-negative', 'PR09 Viewer Spell', 'PR09 Viewer Creature'],
    ['pr09-chimil-the-inner-sun-viewer-negative', 'PR09 Viewer Spell', null],
    ['pr09-trumpeting-carnosaur-viewer-negative', 'PR09 Viewer Spell', 'Trumpeting Carnosaur'],
  ])(
    '%s performs the setup action without casting an ineligible library card',
    (id, excludedName, setupCast) => {
      const scenario = pr09PermanentScenario(id, `viewer-${id}` as never);
      if (setupCast !== null) {
        runUntil(scenario, (request) => {
          if (request.decidingPlayer !== 'P1') return false;
          const action = request.legalActions.find(
            (item) => item.type === 'castSpell' && item.description.includes(setupCast),
          );
          if (!action) return false;
          submit(scenario, request, action);
          return true;
        });
      }
      runUntil(scenario, () => false);
      expect(
        scenario.engine
          .getState()
          .eventLog.some(
            (event) => event.type === 'castSpell' && event.payload['name'] === excludedName,
          ),
      ).toBe(false);
    },
  );
});
