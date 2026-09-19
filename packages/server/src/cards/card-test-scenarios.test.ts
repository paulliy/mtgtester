import type { DecisionRequest } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { createCardTestScenario, listCardTestScenarios } from './card-test-scenarios';
import type { CardTestScenario } from './card-test-scenarios';

function chooseAction(request: DecisionRequest): number {
  const descriptions = request.legalActions.map((action) => action.description);
  if (descriptions.includes('Eligible Talisman')) {
    expect(descriptions).toEqual(['Eligible Talisman', 'Eligible Signet', 'Find nothing']);
    return request.legalActions.find((action) => action.description === 'Eligible Talisman')!.id;
  }
  const tribute = request.legalActions.find((action) =>
    action.description.includes('Cast Tribute Mage'),
  );
  if (tribute !== undefined) return tribute.id;
  const pass = request.legalActions.find((action) => action.type === 'pass');
  return (pass ?? request.legalActions[0]!).id;
}

function runScenario() {
  const scenario = createCardTestScenario(
    'tribute-viewer-cast-search-select-resolve',
    'card-lab-test',
  );
  expect(scenario).not.toBeNull();
  const engine = scenario!.engine;
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    decisions++;
    engine.submit({
      requestId: step.request.requestId,
      actionId: chooseAction(step.request),
    });
    if (decisions > 30) throw new Error('Card Test Lab scenario did not terminate');
  }
  return { scenario: scenario!, decisions };
}

describe('deterministic Card Test Lab scenarios', () => {
  it('rejects unknown scenario IDs', () => {
    expect(createCardTestScenario('unknown', 'card-lab-unknown')).toBeNull();
  });

  it('lists every registered scenario in catalog order', () => {
    expect(listCardTestScenarios().map((entry) => entry.id)).toEqual([
      'tribute-viewer-cast-search-select-resolve',
      'gev-viewer-opponent-targets-ward',
      'nightscape-viewer-activate-regenerate-destroy',
      'thran-viewer-graveyard-departure-trigger',
      'harmonic-viewer-cast-and-double-trigger',
      'swords-viewer-exile-and-gain-life',
      'throat-viewer-destroy-nonartifact',
      'defense-viewer-pump-and-hexproof',
      'bog-viewer-exile-targeted-graveyard',
      'bust-viewer-destroy-toughness-four-or-greater',
      'defile-viewer-minus-one-per-swamp',
      'fury-viewer-double-power',
      'mutation-viewer-destroy-enchantment-make-saprolings',
      'mutilate-viewer-minus-one-per-swamp-all',
      'death-viewer-destroy-nonartifact-creatures',
      'chain-viewer-damage-equal-to-creature-count',
      'unconscious-viewer-draw-for-your-creatures',
      'camaraderie-viewer-life-draw-and-pump',
      'revelation-viewer-draw-and-life-for-power-four',
      'flayed-viewer-etb-mill-three-lifelink',
      'scythe-viewer-etb-necron-warrior',
      'trail-viewer-reveal-enters-untapped',
      'village-viewer-reveal-enters-untapped',
      'snarl-viewer-reveal-enters-untapped',
      'quake-viewer-x-damage-spares-flying',
      'prowess-viewer-pump-and-trample',
      'warden-viewer-etb-two-tapped-warriors',
      'provoke-viewer-damage-then-pump',
      'smelter-viewer-destroy-artifact-and-pump',
      'loaming-viewer-shuffle-chosen-graveyard-card',
      'chrono-viewer-sac-artifact-draw',
      'akoum-viewer-mountain-landfall-two',
      'dawn-viewer-make-lifelink-soldier',
      'rootborn-viewer-indestructible-no-token',
      'trostani-viewer-etb-two-lifelink-soldiers',
      'felidar-viewer-landfall-cat-beast',
      'nest-viewer-damage-makes-insects',
      'slate-viewer-discard-and-draw-for-creatures',
      'scarab-viewer-exile-graveyard-make-insects',
      'oak-viewer-pump-and-untap-target-player',
      'frostboil-viewer-reveal-enters-untapped',
      'vineglimmer-viewer-reveal-enters-untapped',
      'stroke-viewer-destroy-nonland-make-human',
      'gift-viewer-destroy-and-make-elephant',
      'garrison-viewer-bounce-forest-enters-tapped',
      'basilica-viewer-bounce-forest-enters-tapped',
      'pia-kiran-viewer-etb-two-thopters',
      'crackling-viewer-damage-and-greatest-sacrifice',
      'carnarium-viewer-bounce-forest-enters-tapped',
      'whirler-viewer-etb-two-thopters',
      'weaver-viewer-artifact-etb-pings-opponents',
      'spit-viewer-four-damage-to-ox',
      'sai-viewer-cast-artifact-makes-thopter',
      'rendezvous-viewer-you-and-opponent-draw-three',
      'demanding-viewer-five-damage-no-creature',
      'cryptothrall-viewer-hexproof-other-artifact-creatures',
      'boros-charm-viewer-four-damage-to-player',
      'rakdos-charm-viewer-destroy-artifact',
      'hellkite-viewer-plus-one-power-until-eot',
      'refiner-viewer-etb-draw-two-energy',
      'virtuoso-viewer-energy-makes-thopter',
      'ajani-viewer-plus-one-counter',
      'terror-viewer-etb-damage-to-player',
      'basker-viewer-plus-one-until-eot',
    ]);
  });

  it('runs Tribute Mage through normal casting, payment, priority, search, and shuffle', () => {
    const { scenario, decisions } = runScenario();
    const state = scenario.engine.getState();
    const player = state.players.find(({ id }) => id === 'P1')!;

    expect(decisions).toBeGreaterThanOrEqual(2);
    expect(player.hand.map((card) => card.name)).toContain('Eligible Talisman');
    expect(state.battlefield.map((permanent) => permanent.name)).toContain('Tribute Mage');
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('resets to the same state and produces the same authoritative event stream', () => {
    const first = runScenario().scenario.engine.getState();
    const second = runScenario().scenario.engine.getState();
    expect(second.eventLog).toEqual(first.eventLog);
    expect(second.players[0]!.hand.map((card) => card.name)).toEqual(
      first.players[0]!.hand.map((card) => card.name),
    );
  });
});

interface Choice {
  actionId: number;
  targets?: Array<{ slot: number; choice: string }>;
}

type Chooser = (request: DecisionRequest, scenario: CardTestScenario) => Choice;

/** Map every targetable object id in the arranged state to its card name. */
function objectNames(scenario: CardTestScenario): Map<string, string> {
  const names = new Map<string, string>();
  const state = scenario.engine.getState();
  for (const perm of state.battlefield) names.set(perm.id, perm.name);
  for (const player of state.players) {
    names.set(player.id, player.id);
    for (const card of player.graveyard) names.set(card.id, card.name);
    for (const card of player.hand) names.set(card.id, card.name);
  }
  return names;
}

/** Pick the action whose description matches, filling any target slot with the named object. */
function chooseWithTarget(
  request: DecisionRequest,
  scenario: CardTestScenario,
  descriptionIncludes: string,
  targetName?: string,
): Choice | null {
  const action = request.legalActions.find((candidate) =>
    candidate.description.includes(descriptionIncludes),
  );
  if (action === undefined) return null;
  if (targetName === undefined) return { actionId: action.id };
  const slots =
    (action.interaction as { targetSlots?: Array<{ slot: number; options: string[] }> } | undefined)
      ?.targetSlots ?? [];
  const names = objectNames(scenario);
  const slot = slots[0];
  if (slot === undefined) return { actionId: action.id };
  const choice = slot.options.find((id) => names.get(id) === targetName);
  if (choice === undefined) {
    throw new Error(
      `${descriptionIncludes}: no target named ${targetName} among [${slot.options
        .map((id) => names.get(id) ?? id)
        .join(', ')}]`,
    );
  }
  return { actionId: action.id, targets: [{ slot: slot.slot, choice }] };
}

function passChoice(request: DecisionRequest): Choice {
  const pass = request.legalActions.find((action) => action.type === 'pass');
  return { actionId: (pass ?? request.legalActions[0]!).id };
}

function runScenarioWith(scenarioId: string, chooser: Chooser) {
  const scenario = createCardTestScenario(scenarioId, 'card-lab-test');
  expect(scenario).not.toBeNull();
  const engine = scenario!.engine;
  let decisions = 0;
  for (;;) {
    const step = engine.advance();
    if (step.kind === 'gameOver') break;
    if (step.kind === 'continue') continue;
    decisions++;
    const choice = chooser(step.request, scenario!);
    engine.submit({ requestId: step.request.requestId, ...choice });
    if (decisions > 40) throw new Error(`${scenarioId} did not terminate`);
  }
  return { scenario: scenario!, decisions };
}

describe('deterministic Card Test Lab scenarios — reviewed cards', () => {
  it("Gev: an opponent's spell targeting Gev triggers ward — pay 2 life, countered when declined", () => {
    const { scenario } = runScenarioWith('gev-viewer-opponent-targets-ward', (request, sc) => {
      const descriptions = request.legalActions.map((action) => action.description);
      // Gev's controller declines the life payment so the spell is countered.
      const decline = request.legalActions.findIndex((action) =>
        /be countered/.test(action.description),
      );
      if (decline >= 0) return { actionId: request.legalActions[decline]!.id };
      const cast = chooseWithTarget(request, sc, 'Lab Doom', 'Gev, Scaled Scorch');
      if (cast !== null) return cast;
      expect(descriptions.every((d) => !d.includes('Gev')) || decline >= 0).toBe(true);
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const names = state.battlefield.map((perm) => perm.name);
    expect(names).toContain('Gev, Scaled Scorch'); // ward countered the spell
    expect(names).not.toContain('Lab Doom');
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.graveyard.map((card) => card.name)).toContain('Lab Doom');
    expect(p1.life).toBe(40);
    expect(
      state.eventLog.some(
        (event) =>
          JSON.stringify(event.payload).includes('Ward') ||
          JSON.stringify(event.payload).includes('ward'),
      ),
    ).toBe(true);
  });

  it('Nightscape Familiar: regeneration shield replaces the next destruction', () => {
    let activated = false;
    const { scenario } = runScenarioWith(
      'nightscape-viewer-activate-regenerate-destroy',
      (request, sc) => {
        const state = sc.engine.getState();
        const shieldOnStack = state.stack.some((entry) =>
          JSON.stringify(entry).includes('egenerate'),
        );
        if (!activated && !shieldOnStack) {
          const activate = request.legalActions.find(
            (action) =>
              action.type === 'activateAbility' && action.description.includes('Nightscape'),
          );
          if (activate !== undefined) {
            activated = true;
            return { actionId: activate.id };
          }
        }
        // Let the regenerate ability resolve before casting the Doom, so the shield is active.
        if (shieldOnStack) return passChoice(request);
        if (activated) {
          const cast = chooseWithTarget(request, sc, 'Lab Doom', 'Nightscape Familiar');
          if (cast !== null) return cast;
        }
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const familiar = state.battlefield.find((perm) => perm.name === 'Nightscape Familiar');
    expect(familiar).toBeDefined();
    expect(familiar!.tapped).toBe(true);
    // The destruction was prevented by the shield rather than the Doom simply missing.
    expect(
      state.eventLog.some(
        (event) =>
          event.type === 'regenerated' &&
          JSON.stringify(event.payload).includes('Nightscape Familiar'),
      ),
    ).toBe(true);
    expect(
      state.eventLog.some(
        (event) => event.type === 'destroy' && JSON.stringify(event.payload).includes('Nightscape'),
      ),
    ).toBe(false);
  });

  it('Thran Vigil: an artifact leaving your graveyard on your turn puts a counter on your creature', () => {
    const { scenario } = runScenarioWith(
      'thran-viewer-graveyard-departure-trigger',
      (request, sc) => {
        const activate = request.legalActions.find(
          (action) => action.type === 'activateAbility' && action.description.includes('Grave'),
        );
        if (activate !== undefined) {
          const filled = chooseWithTarget(request, sc, 'Grave', 'Eligible Talisman');
          if (filled !== null) return filled;
          return { actionId: activate.id };
        }
        const triggerTarget = request.legalActions.find((action) =>
          action.description.includes('Grave Picker'),
        );
        if (triggerTarget !== undefined && request.legalActions.length <= 2) {
          return { actionId: triggerTarget.id };
        }
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.hand.map((card) => card.name)).toContain('Eligible Talisman');
    expect(p1.graveyard.map((card) => card.name)).not.toContain('Eligible Talisman');
    const picker = state.battlefield.find((perm) => perm.name === 'Grave Picker');
    expect(picker).toBeDefined();
    expect(picker!.counters['+1/+1']).toBe(1);
  });

  it('Harmonic Prodigy: the Lab Shaman enter trigger fires exactly twice and gains 2 life', () => {
    const { scenario } = runScenarioWith(
      'harmonic-viewer-cast-and-double-trigger',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Lab Shaman');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.life).toBe(42);
    expect(state.battlefield.map((perm) => perm.name)).toContain('Lab Shaman');
    const triggerEvents = state.eventLog.filter(
      (event) =>
        event.type === 'triggerOnStack' && JSON.stringify(event.payload).includes('Lab Shaman'),
    );
    expect(triggerEvents.length).toBe(2);
  });

  it('Swords to Plowshares: exiles Lab Ox and its controller gains 4 life', () => {
    const { scenario } = runScenarioWith('swords-viewer-exile-and-gain-life', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Swords to Plowshares', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(state.exile.some((object) => object.name === 'Lab Ox')).toBe(true);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(p2.graveyard.map((card) => card.name)).not.toContain('Lab Ox');
    expect(p2.life).toBe(44);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Go for the Throat: destroys Lab Ox and leaves the artifact creature', () => {
    const { scenario } = runScenarioWith('throat-viewer-destroy-nonartifact', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Go for the Throat', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(true);
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(p2.graveyard.map((card) => card.name)).toContain('Lab Ox');
  });

  it('Blossoming Defense: pumps Lab Ox to 6/6 and grants hexproof', () => {
    const { scenario } = runScenarioWith('defense-viewer-pump-and-hexproof', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Blossoming Defense', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const ox = state.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox).toBeDefined();
    expect(
      state.eventLog.some(
        (event) =>
          event.type === 'grantKeyword' && JSON.stringify(event.payload).includes('hexproof'),
      ),
    ).toBe(true);
    expect(
      state.eventLog.some(
        (event) => event.type === 'pump' && JSON.stringify(event.payload).includes('Lab Ox'),
      ),
    ).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Bojuka Bog: exiles the targeted graveyard and leaves yours', () => {
    const { scenario } = runScenarioWith('bog-viewer-exile-targeted-graveyard', (request, sc) => {
      const play = chooseWithTarget(request, sc, 'Bojuka Bog', 'P2');
      if (play !== null) return play;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const bog = state.battlefield.find((permanent) => permanent.name === 'Bojuka Bog');
    expect(bog).toBeDefined();
    expect(bog?.tapped).toBe(true);
    expect(p2.graveyard.map((card) => card.name)).not.toContain('Lab Ox');
    expect(state.exile.some((object) => object.name === 'Lab Ox')).toBe(true);
    expect(p1.graveyard.map((card) => card.name)).toContain('Lab Servo');
  });

  it('Citywide Bust: destroys Lab Ox and leaves Lab Servo', () => {
    const { scenario } = runScenarioWith(
      'bust-viewer-destroy-toughness-four-or-greater',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Citywide Bust');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(true);
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(p2.graveyard.map((card) => card.name)).toContain('Lab Ox');
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Defile: Lab Ox becomes 2/2 from two Swamps; Lab Servo is untargeted', () => {
    const { scenario } = runScenarioWith('defile-viewer-minus-one-per-swamp', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Defile', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    const servo = spec.battlefield.find((permanent) => permanent.name === 'Lab Servo');
    expect(ox).toBeDefined();
    expect(servo).toBeDefined();
    expect(ox?.power).toBe(2);
    expect(ox?.toughness).toBe(2);
    expect(servo?.power).toBe(1);
    expect(servo?.toughness).toBe(1);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Unleash Fury: Lab Ox becomes 8/4', () => {
    const { scenario } = runScenarioWith('fury-viewer-double-power', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Unleash Fury', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.power).toBe(8);
    expect(ox?.toughness).toBe(4);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Aura Mutation: destroys Lab Hex and makes three Saprolings', () => {
    const { scenario } = runScenarioWith(
      'mutation-viewer-destroy-enchantment-make-saprolings',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Aura Mutation', 'Lab Hex');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Hex')).toBe(false);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(true);
    expect(state.battlefield.filter((permanent) => permanent.name === 'Saproling')).toHaveLength(3);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Mutilate: Lab Ox becomes 2/2 and Lab Servo dies', () => {
    const { scenario } = runScenarioWith(
      'mutilate-viewer-minus-one-per-swamp-all',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Mutilate');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.power).toBe(2);
    expect(ox?.toughness).toBe(2);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(false);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Their Name Is Death: destroys Lab Ox and leaves the artifact creature', () => {
    const { scenario } = runScenarioWith(
      'death-viewer-destroy-nonartifact-creatures',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Their Name Is Death');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(true);
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(p2.graveyard.map((card) => card.name)).toContain('Lab Ox');
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Chain Reaction: two creatures take 2 damage; Lab Servo dies', () => {
    const { scenario } = runScenarioWith(
      'chain-viewer-damage-equal-to-creature-count',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Chain Reaction');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.power).toBe(4);
    expect(ox?.toughness).toBe(4);
    expect(ox?.damageMarked).toBe(2);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(false);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Collective Unconscious: draws two cards for your two creatures', () => {
    const { scenario } = runScenarioWith(
      'unconscious-viewer-draw-for-your-creatures',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Collective Unconscious');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.hand).toHaveLength(2);
    expect(p1.life).toBe(40);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Camaraderie: gains 2 life, draws two, pumps only your creatures', () => {
    const { scenario } = runScenarioWith('camaraderie-viewer-life-draw-and-pump', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Camaraderie');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const spec = scenario.engine.spectatorState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.life).toBe(42);
    expect(p1.hand).toHaveLength(2);
    const yours = spec.battlefield.filter((permanent) => permanent.controller === 'P1');
    const theirs = spec.battlefield.filter((permanent) => permanent.controller === 'P2');
    expect(yours.find((permanent) => permanent.name === 'Lab Ox')?.power).toBe(5);
    expect(yours.find((permanent) => permanent.name === 'Lab Servo')?.power).toBe(2);
    expect(theirs.find((permanent) => permanent.name === 'Lab Ox')?.power).toBe(4);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Shamanic Revelation: draws two and gains 4 life for power 4', () => {
    const { scenario } = runScenarioWith(
      'revelation-viewer-draw-and-life-for-power-four',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Shamanic Revelation');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.hand).toHaveLength(2);
    expect(p1.life).toBe(44);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Flayed One: mills three from your library and has lifelink', () => {
    const { scenario } = runScenarioWith('flayed-viewer-etb-mill-three-lifelink', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Flayed One');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const spec = scenario.engine.spectatorState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const flayed = spec.battlefield.find((permanent) => permanent.name === 'Flayed One');
    expect(flayed?.power).toBe(4);
    expect(flayed?.toughness).toBe(1);
    expect(flayed?.keywords).toContain('lifelink');
    expect(p1.graveyard).toHaveLength(3);
    expect(p2.graveyard).toHaveLength(0);
    expect(state.eventLog.some((event) => event.type === 'mill')).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Night Scythe: creates a Necron Warrior token', () => {
    const { scenario } = runScenarioWith('scythe-viewer-etb-necron-warrior', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Night Scythe');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    expect(state.battlefield.some((permanent) => permanent.name === 'Night Scythe')).toBe(true);
    const warrior = state.battlefield.find((permanent) => permanent.name === 'Necron Warrior');
    expect(warrior).toBeDefined();
    expect(
      state.eventLog.some(
        (event) => event.type === 'tokenCreated' && event.payload['name'] === warrior?.name,
      ),
    ).toBe(true);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Game Trail: revealing a Forest enters untapped', () => {
    const { scenario } = runScenarioWith('trail-viewer-reveal-enters-untapped', (request, sc) => {
      const reveal = request.legalActions.find((action) =>
        action.description.includes('enters untapped'),
      );
      if (reveal !== undefined) return { actionId: reveal.id };
      const play = chooseWithTarget(request, sc, 'Game Trail');
      if (play !== null) return play;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const trail = state.battlefield.find((permanent) => permanent.name === 'Game Trail');
    expect(trail).toBeDefined();
    expect(trail?.tapped).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Forest');
    expect(state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Fortified Village: revealing a Plains enters untapped', () => {
    const { scenario } = runScenarioWith('village-viewer-reveal-enters-untapped', (request, sc) => {
      const reveal = request.legalActions.find((action) =>
        action.description.includes('enters untapped'),
      );
      if (reveal !== undefined) return { actionId: reveal.id };
      const play = chooseWithTarget(request, sc, 'Fortified Village');
      if (play !== null) return play;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const village = state.battlefield.find((permanent) => permanent.name === 'Fortified Village');
    expect(village).toBeDefined();
    expect(village?.tapped).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Plains');
    expect(state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Shineshadow Snarl: revealing a Swamp enters untapped', () => {
    const { scenario } = runScenarioWith('snarl-viewer-reveal-enters-untapped', (request, sc) => {
      const reveal = request.legalActions.find((action) =>
        action.description.includes('enters untapped'),
      );
      if (reveal !== undefined) return { actionId: reveal.id };
      const play = chooseWithTarget(request, sc, 'Shineshadow Snarl');
      if (play !== null) return play;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const snarl = state.battlefield.find((permanent) => permanent.name === 'Shineshadow Snarl');
    expect(snarl).toBeDefined();
    expect(snarl?.tapped).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Swamp');
    expect(state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Magmaquake: X=2 damages ground creatures and spares flying', () => {
    const { scenario } = runScenarioWith('quake-viewer-x-damage-spares-flying', (request, sc) => {
      const quake = request.legalActions.find(
        (action) => action.description.includes('Magmaquake') && action.data?.['x'] === 2,
      );
      if (quake !== undefined) return { actionId: quake.id };
      const fallback = chooseWithTarget(request, sc, 'Magmaquake');
      if (fallback !== null) return fallback;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    const bird = spec.battlefield.find((permanent) => permanent.name === 'Lab Bird');
    expect(ox?.damageMarked).toBe(2);
    expect(bird?.damageMarked).toBe(0);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(false);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it("Hunter's Prowess: Lab Ox becomes 7/7 with trample", () => {
    const { scenario } = runScenarioWith('prowess-viewer-pump-and-trample', (request, sc) => {
      const cast = chooseWithTarget(request, sc, "Hunter's Prowess", 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.power).toBe(7);
    expect(ox?.toughness).toBe(7);
    expect(ox?.keywords).toContain('trample');
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Royal Warden: ETB creates two tapped Necron Warriors', () => {
    const { scenario } = runScenarioWith('warden-viewer-etb-two-tapped-warriors', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Royal Warden');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const warriors = state.battlefield.filter((permanent) => permanent.name === 'Necron Warrior');
    expect(state.battlefield.some((permanent) => permanent.name === 'Royal Warden')).toBe(true);
    expect(warriors).toHaveLength(2);
    expect(warriors.every((token) => token.tapped)).toBe(true);
    expect(
      state.eventLog.filter(
        (event) => event.type === 'tokenCreated' && event.payload['name'] === 'Necron Warrior',
      ),
    ).toHaveLength(2);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Provoke the Trolls: Lab Ox takes 3 and becomes 9/4', () => {
    const { scenario } = runScenarioWith('provoke-viewer-damage-then-pump', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Provoke the Trolls', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.power).toBe(9);
    expect(ox?.toughness).toBe(4);
    expect(ox?.damageMarked).toBe(3);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Hoard-Smelter Dragon: destroys Wrong-MV Artifact and becomes 8/5', () => {
    const { scenario } = runScenarioWith(
      'smelter-viewer-destroy-artifact-and-pump',
      (request, sc) => {
        const activate = request.legalActions.find(
          (action) =>
            action.type === 'activateAbility' && action.description.includes('Hoard-Smelter'),
        );
        if (activate !== undefined) {
          const names = objectNames(sc);
          const slots =
            (
              activate.interaction as
                { targetSlots?: Array<{ slot: number; options: string[] }> } | undefined
            )?.targetSlots ?? [];
          const slot = slots[0];
          if (slot !== undefined) {
            const artifact = slot.options.find((id) => names.get(id) === 'Wrong-MV Artifact');
            if (artifact !== undefined) {
              return { actionId: activate.id, targets: [{ slot: slot.slot, choice: artifact }] };
            }
          }
          return { actionId: activate.id };
        }
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const dragon = spec.battlefield.find((permanent) => permanent.name === 'Hoard-Smelter Dragon');
    expect(dragon?.power).toBe(8);
    expect(dragon?.toughness).toBe(5);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Wrong-MV Artifact')).toBe(
      false,
    );
  });

  it('Loaming Shaman: shuffles P2 Lab Ox from the graveyard into the library', () => {
    const { scenario } = runScenarioWith(
      'loaming-viewer-shuffle-chosen-graveyard-card',
      (request, sc) => {
        const gy = request.legalActions.find((action) => action.description.includes('Lab Ox'));
        if (gy !== undefined) return { actionId: gy.id };
        const playerTarget = chooseWithTarget(request, sc, 'Loaming', 'P2');
        if (playerTarget !== null) return playerTarget;
        const cast = chooseWithTarget(request, sc, 'Loaming Shaman');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p2 = state.players.find((player) => player.id === 'P2')!;
    expect(state.battlefield.some((permanent) => permanent.name === 'Loaming Shaman')).toBe(true);
    expect(p2.graveyard.map((card) => card.name)).not.toContain('Lab Ox');
    expect(p2.library.map((card) => card.name)).toContain('Lab Ox');
    expect(state.eventLog.some((event) => event.type === 'shuffle')).toBe(true);
  });

  it('Chronomancer: sacrifices Lab Servo and draws Eligible Talisman', () => {
    const { scenario } = runScenarioWith('chrono-viewer-sac-artifact-draw', (request, sc) => {
      const activate = request.legalActions.find(
        (action) =>
          action.type === 'activateAbility' && action.description.includes('Chronomancer'),
      );
      if (activate !== undefined) {
        const names = objectNames(sc);
        const slots =
          (
            activate.interaction as
              { targetSlots?: Array<{ slot: number; options: string[] }> } | undefined
          )?.targetSlots ?? [];
        const slot = slots[0];
        if (slot !== undefined) {
          const servo = slot.options.find((id) => names.get(id) === 'Lab Servo');
          if (servo !== undefined) {
            return { actionId: activate.id, targets: [{ slot: slot.slot, choice: servo }] };
          }
        }
        return { actionId: activate.id };
      }
      const sac = request.legalActions.find((action) => action.description.includes('Lab Servo'));
      if (sac !== undefined) return { actionId: sac.id };
      return passChoice(request);
    });
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(state.battlefield.some((permanent) => permanent.name === 'Chronomancer')).toBe(true);
    expect(state.battlefield.some((permanent) => permanent.name === 'Lab Servo')).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Eligible Talisman');
  });

  it('Akoum Hellkite: playing a Mountain deals 2 to P2', () => {
    const { scenario } = runScenarioWith('akoum-viewer-mountain-landfall-two', (request, sc) => {
      const landfall = chooseWithTarget(request, sc, 'Akoum', 'P2');
      if (landfall !== null) return landfall;
      const play = chooseWithTarget(request, sc, 'Mountain');
      if (play !== null) return play;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const p2 = spec.seats.find((seat) => seat.seat === 'P2');
    expect(p2?.life).toBe(38);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Mountain')).toBe(true);
  });

  it('Dawn of Hope: activation makes a lifelink Soldier', () => {
    const { scenario } = runScenarioWith('dawn-viewer-make-lifelink-soldier', (request) => {
      const activate = request.legalActions.find(
        (action) => action.type === 'activateAbility' && action.description.includes('Dawn'),
      );
      if (activate !== undefined) return { actionId: activate.id };
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const soldier = spec.battlefield.find((permanent) => permanent.name === 'Soldier');
    expect(soldier).toBeDefined();
    expect(soldier?.power).toBe(1);
    expect(soldier?.toughness).toBe(1);
    expect(soldier?.keywords).toContain('lifelink');
  });

  it('Rootborn Defenses: Lab Ox gains indestructible without a token to copy', () => {
    const { scenario } = runScenarioWith(
      'rootborn-viewer-indestructible-no-token',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Rootborn Defenses');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    expect(ox?.keywords).toContain('indestructible');
    expect(spec.battlefield.filter((permanent) => permanent.name === 'Lab Ox')).toHaveLength(1);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Trostani Discordant: ETB two anthem-pumped lifelink Soldiers', () => {
    const { scenario } = runScenarioWith(
      'trostani-viewer-etb-two-lifelink-soldiers',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Trostani Discordant');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const soldiers = spec.battlefield.filter((permanent) => permanent.name === 'Soldier');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Trostani Discordant')).toBe(
      true,
    );
    expect(soldiers).toHaveLength(2);
    expect(soldiers.every((permanent) => permanent.power === 2 && permanent.toughness === 2)).toBe(
      true,
    );
    expect(soldiers.every((permanent) => permanent.keywords.includes('lifelink'))).toBe(true);
  });

  it('Felidar Retreat: playing a Forest makes a Cat Beast', () => {
    const { scenario } = runScenarioWith('felidar-viewer-landfall-cat-beast', (request, sc) => {
      const cat = request.legalActions.find((action) => /Beast|Cat/.test(action.description));
      if (cat !== undefined) return { actionId: cat.id };
      const play = chooseWithTarget(request, sc, 'Forest');
      if (play !== null) return play;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const beast = spec.battlefield.find((permanent) => permanent.name === 'Cat Beast');
    expect(beast?.power).toBe(2);
    expect(beast?.toughness).toBe(2);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Forest')).toBe(true);
  });

  it('Hornet Nest: 2 damage makes two flying deathtouch Insects and the Nest dies', () => {
    const { scenario } = runScenarioWith('nest-viewer-damage-makes-insects', (request, sc) => {
      const shock = chooseWithTarget(request, sc, 'Lab Shock', 'Hornet Nest');
      if (shock !== null) return shock;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const insects = spec.battlefield.filter((permanent) => permanent.name === 'Insect');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Hornet Nest')).toBe(false);
    expect(insects).toHaveLength(2);
    expect(
      insects.every(
        (permanent) =>
          permanent.keywords.includes('flying') && permanent.keywords.includes('deathtouch'),
      ),
    ).toBe(true);
  });

  it('Slate of Ancestry: discards two and draws two for your creatures', () => {
    const { scenario } = runScenarioWith(
      'slate-viewer-discard-and-draw-for-creatures',
      (request) => {
        const discard = request.legalActions.find((action) =>
          action.description.toLowerCase().includes('discard'),
        );
        if (discard !== undefined) return { actionId: discard.id };
        const activate = request.legalActions.find(
          (action) =>
            action.type === 'activateAbility' && action.description.includes('Slate of Ancestry'),
        );
        if (activate !== undefined) return { actionId: activate.id };
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    expect(p1.hand).toHaveLength(2);
    expect(p1.graveyard.map((card) => card.name).sort()).toEqual([
      'Eligible Signet',
      'Eligible Talisman',
    ]);
    expect(
      state.battlefield.find((permanent) => permanent.name === 'Slate of Ancestry')?.tapped,
    ).toBe(true);
  });

  it('Canoptek Scarab Swarm: exiles P2 graveyard and makes two flying Insects', () => {
    const { scenario } = runScenarioWith(
      'scarab-viewer-exile-graveyard-make-insects',
      (request, sc) => {
        const etb = chooseWithTarget(request, sc, 'Canoptek', 'P2');
        if (etb !== null) return etb;
        const cast = chooseWithTarget(request, sc, 'Canoptek Scarab Swarm');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const insects = spec.battlefield.filter((permanent) => permanent.name === 'Insect');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Canoptek Scarab Swarm')).toBe(
      true,
    );
    expect(p2.graveyard).toHaveLength(0);
    expect(state.exile).toHaveLength(3);
    expect(insects).toHaveLength(2);
    expect(insects.every((permanent) => permanent.keywords.includes('flying'))).toBe(true);
    expect(insects.every((permanent) => !permanent.keywords.includes('deathtouch'))).toBe(true);
  });

  it('Great Oak Guardian: P2 Lab Ox becomes 6/6 and untaps; Oak stays 4/5', () => {
    const { scenario } = runScenarioWith(
      'oak-viewer-pump-and-untap-target-player',
      (request, sc) => {
        const etb = chooseWithTarget(request, sc, 'Great Oak', 'P2');
        if (etb !== null) return etb;
        const cast = chooseWithTarget(request, sc, 'Great Oak Guardian');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    const oak = spec.battlefield.find((permanent) => permanent.name === 'Great Oak Guardian');
    expect(ox?.power).toBe(6);
    expect(ox?.toughness).toBe(6);
    expect(ox?.tapped).toBe(false);
    expect(oak?.power).toBe(4);
    expect(oak?.toughness).toBe(5);
  });

  it('Frostboil Snarl: revealing an Island enters untapped', () => {
    const { scenario } = runScenarioWith(
      'frostboil-viewer-reveal-enters-untapped',
      (request, sc) => {
        const reveal = request.legalActions.find((action) =>
          action.description.includes('enters untapped'),
        );
        if (reveal !== undefined) return { actionId: reveal.id };
        const play = chooseWithTarget(request, sc, 'Frostboil Snarl');
        if (play !== null) return play;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const snarl = state.battlefield.find((permanent) => permanent.name === 'Frostboil Snarl');
    expect(snarl).toBeDefined();
    expect(snarl?.tapped).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Island');
    expect(state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Vineglimmer Snarl: revealing a Forest enters untapped', () => {
    const { scenario } = runScenarioWith(
      'vineglimmer-viewer-reveal-enters-untapped',
      (request, sc) => {
        const reveal = request.legalActions.find((action) =>
          action.description.includes('enters untapped'),
        );
        if (reveal !== undefined) return { actionId: reveal.id };
        const play = chooseWithTarget(request, sc, 'Vineglimmer Snarl');
        if (play !== null) return play;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const snarl = state.battlefield.find((permanent) => permanent.name === 'Vineglimmer Snarl');
    expect(snarl).toBeDefined();
    expect(snarl?.tapped).toBe(false);
    expect(p1.hand.map((card) => card.name)).toContain('Forest');
    expect(state.eventLog.some((event) => event.type === 'revealCard')).toBe(true);
  });

  it('Stroke of Midnight: destroys Lab Ox and P2 gets a 1/1 Human', () => {
    const { scenario } = runScenarioWith(
      'stroke-viewer-destroy-nonland-make-human',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Stroke of Midnight', 'Lab Ox');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const human = spec.battlefield.find((permanent) => permanent.name === 'Human');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(human?.controller).toBe('P2');
    expect(human?.power).toBe(1);
    expect(human?.toughness).toBe(1);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Generous Gift: destroys Lab Ox and P2 gets a 3/3 Elephant', () => {
    const { scenario } = runScenarioWith('gift-viewer-destroy-and-make-elephant', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Generous Gift', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const elephant = spec.battlefield.find((permanent) => permanent.name === 'Elephant');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(elephant?.controller).toBe('P2');
    expect(elephant?.power).toBe(3);
    expect(elephant?.toughness).toBe(3);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Boros Garrison: bouncing Forest leaves Garrison tapped on the battlefield', () => {
    const { scenario } = runScenarioWith(
      'garrison-viewer-bounce-forest-enters-tapped',
      (request, sc) => {
        const bounceForest = request.legalActions.find((action) =>
          /Return Forest/i.test(action.description),
        );
        if (bounceForest !== undefined) return { actionId: bounceForest.id };
        const play = chooseWithTarget(request, sc, 'Boros Garrison');
        if (play !== null) return play;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const garrison = state.battlefield.find((permanent) => permanent.name === 'Boros Garrison');
    expect(garrison).toBeDefined();
    expect(garrison?.tapped).toBe(true);
    expect(p1.hand.map((card) => card.name)).toContain('Forest');
    expect(state.battlefield.some((permanent) => permanent.name === 'Forest')).toBe(false);
  });

  it('Orzhov Basilica: bouncing Forest leaves Basilica tapped on the battlefield', () => {
    const { scenario } = runScenarioWith(
      'basilica-viewer-bounce-forest-enters-tapped',
      (request, sc) => {
        const bounceForest = request.legalActions.find((action) =>
          /Return Forest/i.test(action.description),
        );
        if (bounceForest !== undefined) return { actionId: bounceForest.id };
        const play = chooseWithTarget(request, sc, 'Orzhov Basilica');
        if (play !== null) return play;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const basilica = state.battlefield.find((permanent) => permanent.name === 'Orzhov Basilica');
    expect(basilica).toBeDefined();
    expect(basilica?.tapped).toBe(true);
    expect(p1.hand.map((card) => card.name)).toContain('Forest');
    expect(state.battlefield.some((permanent) => permanent.name === 'Forest')).toBe(false);
  });

  it('Pia and Kiran Nalaar: ETB two 1/1 flying Thopters', () => {
    const { scenario } = runScenarioWith('pia-kiran-viewer-etb-two-thopters', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Pia and Kiran Nalaar');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const thopters = spec.battlefield.filter((permanent) => permanent.name === 'Thopter');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Pia and Kiran Nalaar')).toBe(
      true,
    );
    expect(thopters).toHaveLength(2);
    expect(thopters.every((permanent) => permanent.power === 1 && permanent.toughness === 1)).toBe(
      true,
    );
    expect(thopters.every((permanent) => permanent.keywords.includes('flying'))).toBe(true);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Crackling Doom: P2 sacs Lab Ox and each opponent loses 2 life', () => {
    const { scenario } = runScenarioWith(
      'crackling-viewer-damage-and-greatest-sacrifice',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Crackling Doom');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const p3 = state.players.find((player) => player.id === 'P3')!;
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(p1.life).toBe(40);
    expect(p2.life).toBe(38);
    expect(p3.life).toBe(38);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Rakdos Carnarium: bouncing Forest leaves Carnarium tapped on the battlefield', () => {
    const { scenario } = runScenarioWith(
      'carnarium-viewer-bounce-forest-enters-tapped',
      (request, sc) => {
        const bounceForest = request.legalActions.find((action) =>
          /Return Forest/i.test(action.description),
        );
        if (bounceForest !== undefined) return { actionId: bounceForest.id };
        const play = chooseWithTarget(request, sc, 'Rakdos Carnarium');
        if (play !== null) return play;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const carnarium = state.battlefield.find((permanent) => permanent.name === 'Rakdos Carnarium');
    expect(carnarium).toBeDefined();
    expect(carnarium?.tapped).toBe(true);
    expect(p1.hand.map((card) => card.name)).toContain('Forest');
    expect(state.battlefield.some((permanent) => permanent.name === 'Forest')).toBe(false);
  });

  it('Whirler Rogue: ETB two 1/1 flying Thopters', () => {
    const { scenario } = runScenarioWith('whirler-viewer-etb-two-thopters', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Cast Whirler Rogue');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const thopters = spec.battlefield.filter((permanent) => permanent.name === 'Thopter');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Whirler Rogue')).toBe(true);
    expect(thopters).toHaveLength(2);
    expect(thopters.every((permanent) => permanent.power === 1 && permanent.toughness === 1)).toBe(
      true,
    );
    expect(thopters.every((permanent) => permanent.keywords.includes('flying'))).toBe(true);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Reckless Fireweaver: artifact ETB deals 1 to each opponent', () => {
    const { scenario } = runScenarioWith(
      'weaver-viewer-artifact-etb-pings-opponents',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Eligible Talisman');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const p3 = state.players.find((player) => player.id === 'P3')!;
    expect(spec.battlefield.some((permanent) => permanent.name === 'Eligible Talisman')).toBe(true);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Reckless Fireweaver')).toBe(
      true,
    );
    expect(p1.life).toBe(40);
    expect(p2.life).toBe(39);
    expect(p3.life).toBe(39);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Spit Flame: 4 damage destroys Lab Ox', () => {
    const { scenario } = runScenarioWith('spit-viewer-four-damage-to-ox', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Spit Flame', 'Lab Ox');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(false);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Sai, Master Thopterist: casting an artifact makes a flying Thopter', () => {
    const { scenario } = runScenarioWith(
      'sai-viewer-cast-artifact-makes-thopter',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Eligible Talisman');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const thopter = spec.battlefield.find((permanent) => permanent.name === 'Thopter');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Eligible Talisman')).toBe(true);
    expect(spec.battlefield.some((permanent) => permanent.name === 'Sai, Master Thopterist')).toBe(
      true,
    );
    expect(thopter).toBeDefined();
    expect(thopter?.power).toBe(1);
    expect(thopter?.toughness).toBe(1);
    expect(thopter?.keywords).toContain('flying');
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Secret Rendezvous: you and P2 each draw three nonlands', () => {
    const { scenario } = runScenarioWith(
      'rendezvous-viewer-you-and-opponent-draw-three',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Secret Rendezvous', 'P2');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const p3 = state.players.find((player) => player.id === 'P3')!;
    expect(p1.hand).toHaveLength(3);
    expect(p1.hand.every((card) => !card.typeLine.includes('Land'))).toBe(true);
    expect(p2.hand).toHaveLength(3);
    expect(p2.hand.every((card) => !card.typeLine.includes('Land'))).toBe(true);
    expect(p3.hand).toHaveLength(0);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Demanding Dragon: 5 damage when P2 has no creature to sacrifice', () => {
    const { scenario } = runScenarioWith(
      'demanding-viewer-five-damage-no-creature',
      (request, sc) => {
        const etb = chooseWithTarget(request, sc, 'Demanding', 'P2');
        if (etb !== null) return etb;
        const cast = chooseWithTarget(request, sc, 'Cast Demanding Dragon');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = spec.seats.find((seat) => seat.seat === 'P2');
    const p3 = spec.seats.find((seat) => seat.seat === 'P3');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Demanding Dragon')).toBe(true);
    expect(p1.life).toBe(40);
    expect(p2?.life).toBe(35);
    expect(p3?.life).toBe(40);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Cryptothrall: other artifact creatures you control have hexproof', () => {
    const { scenario } = runScenarioWith(
      'cryptothrall-viewer-hexproof-other-artifact-creatures',
      (request, sc) => {
        const cast = chooseWithTarget(request, sc, 'Cast Cryptothrall');
        if (cast !== null) return cast;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const yours = spec.battlefield.find(
      (permanent) => permanent.name === 'Lab Servo' && permanent.controller === 'P1',
    );
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    const theirs = spec.battlefield.find(
      (permanent) => permanent.name === 'Lab Servo' && permanent.controller === 'P2',
    );
    const self = spec.battlefield.find((permanent) => permanent.name === 'Cryptothrall');
    expect(yours?.keywords).toContain('hexproof');
    expect(ox?.keywords ?? []).not.toContain('hexproof');
    expect(theirs?.keywords ?? []).not.toContain('hexproof');
    expect(self?.keywords ?? []).not.toContain('hexproof');
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Boros Charm: 4 damage to P2; double strike is not offered', () => {
    const { scenario } = runScenarioWith(
      'boros-charm-viewer-four-damage-to-player',
      (request, sc) => {
        const damage = chooseWithTarget(request, sc, 'Deal 4 damage', 'P2');
        if (damage !== null) return damage;
        return passChoice(request);
      },
    );
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = spec.seats.find((seat) => seat.seat === 'P2');
    const p3 = spec.seats.find((seat) => seat.seat === 'P3');
    expect(p1.life).toBe(40);
    expect(p2?.life).toBe(36);
    expect(p3?.life).toBe(40);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Rakdos Charm: destroy the artifact, not Lab Ox', () => {
    const { scenario } = runScenarioWith('rakdos-charm-viewer-destroy-artifact', (request, sc) => {
      const destroy = chooseWithTarget(request, sc, 'Destroy target artifact', 'Wrong-MV Artifact');
      if (destroy !== null) return destroy;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    expect(spec.battlefield.some((permanent) => permanent.name === 'Wrong-MV Artifact')).toBe(
      false,
    );
    expect(spec.battlefield.some((permanent) => permanent.name === 'Lab Ox')).toBe(true);
    expect(scenario.engine.getState().eventLog.some((event) => event.type === 'castSpell')).toBe(
      true,
    );
  });

  it('Steel Hellkite: {2} pumps +1/+0 until end of turn', () => {
    const { scenario } = runScenarioWith('hellkite-viewer-plus-one-power-until-eot', (request) => {
      const pump = request.legalActions.find((action) => action.description.includes('+1/+0'));
      if (pump !== undefined) return { actionId: pump.id };
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const hellkite = spec.battlefield.find((permanent) => permanent.name === 'Steel Hellkite');
    expect(hellkite?.power).toBe(6);
    expect(hellkite?.toughness).toBe(5);
  });

  it('Rogue Refiner: ETB draws a nonland and grants two energy', () => {
    const { scenario } = runScenarioWith('refiner-viewer-etb-draw-two-energy', (request, sc) => {
      const cast = chooseWithTarget(request, sc, 'Cast Rogue Refiner');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = state.players.find((player) => player.id === 'P2')!;
    const you = spec.seats.find((seat) => seat.seat === 'P1');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Rogue Refiner')).toBe(true);
    expect(p1.hand).toHaveLength(1);
    expect(p1.hand.every((card) => !card.typeLine.includes('Land'))).toBe(true);
    expect(p2.hand).toHaveLength(0);
    expect(you?.energy).toBe(2);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Whirler Virtuoso: three energy makes a flying Thopter', () => {
    const { scenario } = runScenarioWith('virtuoso-viewer-energy-makes-thopter', (request, sc) => {
      const thopter = request.legalActions.find((action) => /thopter/i.test(action.description));
      if (thopter !== undefined) return { actionId: thopter.id };
      const cast = chooseWithTarget(request, sc, 'Cast Whirler Virtuoso');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const you = spec.seats.find((seat) => seat.seat === 'P1');
    const token = spec.battlefield.find((permanent) => permanent.name === 'Thopter');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Whirler Virtuoso')).toBe(true);
    expect(token).toBeDefined();
    expect(token?.power).toBe(1);
    expect(token?.toughness).toBe(1);
    expect(token?.keywords).toContain('flying');
    expect(you?.energy).toBe(0);
  });

  it('Ajani, Caller of the Pride: +1 puts a counter on Lab Ox', () => {
    const { scenario } = runScenarioWith('ajani-viewer-plus-one-counter', (request, sc) => {
      const plus = request.legalActions.find((action) =>
        action.description.includes('+1: Put a +1/+1 counter'),
      );
      if (plus !== undefined) {
        const names = objectNames(sc);
        const slot = plus.targets?.[0];
        const ox = slot?.options.find((id) => names.get(id) === 'Lab Ox');
        if (slot !== undefined && ox !== undefined) {
          return { actionId: plus.id, targets: [{ slot: slot.slot, choice: ox }] };
        }
        return { actionId: plus.id };
      }
      const targeted = chooseWithTarget(request, sc, 'Ajani', 'Lab Ox');
      if (targeted !== null) return targeted;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const ox = spec.battlefield.find((permanent) => permanent.name === 'Lab Ox');
    const ajani = spec.battlefield.find(
      (permanent) => permanent.name === 'Ajani, Caller of the Pride',
    );
    expect(ox?.power).toBe(5);
    expect(ox?.toughness).toBe(5);
    expect(ox?.keywords ?? []).not.toContain('flying');
    expect(ox?.keywords ?? []).not.toContain('double strike');
    expect(ajani?.counters['loyalty']).toBe(5);
  });

  it('Terror of the Peaks: entering Two-Mana Bear deals 2 to P2', () => {
    const { scenario } = runScenarioWith('terror-viewer-etb-damage-to-player', (request, sc) => {
      const damage = chooseWithTarget(request, sc, 'Terror', 'P2');
      if (damage !== null) return damage;
      const cast = chooseWithTarget(request, sc, 'Cast Two-Mana Bear');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const state = scenario.engine.getState();
    const p1 = state.players.find((player) => player.id === 'P1')!;
    const p2 = spec.seats.find((seat) => seat.seat === 'P2');
    const p3 = spec.seats.find((seat) => seat.seat === 'P3');
    expect(spec.battlefield.some((permanent) => permanent.name === 'Terror of the Peaks')).toBe(
      true,
    );
    expect(spec.battlefield.some((permanent) => permanent.name === 'Two-Mana Bear')).toBe(true);
    expect(p1.life).toBe(40);
    expect(p2?.life).toBe(38);
    expect(p3?.life).toBe(40);
    expect(state.eventLog.some((event) => event.type === 'castSpell')).toBe(true);
  });

  it('Aetherwind Basker: pay one energy to become 8/8 until end of turn', () => {
    const { scenario } = runScenarioWith('basker-viewer-plus-one-until-eot', (request, sc) => {
      const pump = request.legalActions.find((action) => action.description.includes('+1/+1'));
      if (pump !== undefined) return { actionId: pump.id };
      const cast = chooseWithTarget(request, sc, 'Cast Aetherwind Basker');
      if (cast !== null) return cast;
      return passChoice(request);
    });
    const spec = scenario.engine.spectatorState();
    const basker = spec.battlefield.find((permanent) => permanent.name === 'Aetherwind Basker');
    const you = spec.seats.find((seat) => seat.seat === 'P1');
    expect(basker?.power).toBe(8);
    expect(basker?.toughness).toBe(8);
    expect(basker?.keywords).toContain('trample');
    expect(you?.energy).toBe(0);
  });
});
