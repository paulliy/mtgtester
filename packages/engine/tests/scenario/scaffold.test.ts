/**
 * The promotion scaffold generator (hill-climb S4). A draft is only useful if it passes on the
 * real card, fails on a wrong one, and carries expectations read from the IR rather than from
 * the engine; these tests hold each of those.
 */
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '../../src/cards/interpret';
import { parseCardScenarioFile } from '../../src/testing/card-scenario';
import { installDefinitionTransform } from '../../src/testing/definition-transform';
import { pinStore } from './pin-store';
import { resolveScenarioCard, runScenario, scenarioFailures } from './runner';
import { SCAFFOLD_VERSION, scaffoldCard } from './scaffold';

const scaffold = (name: string) => scaffoldCard(pinStore.get(name), resolveScenarioCard);

// The EDHREC pinned pool, for shapes the pin store has no card for.
const pinned = new Map(
  (
    JSON.parse(
      readFileSync(
        new URL('../../../server/fixtures/edhrec-pinned-oracle.json', import.meta.url),
        'utf8',
      ),
    ) as Array<{ card: OracleCard }>
  ).map((pin) => [pin.card.name, pin.card]),
);
const resolvePool = (name: string): OracleCard => pinned.get(name) ?? resolveScenarioCard(name);
const scaffoldPool = (name: string) => scaffoldCard(resolvePool(name), resolvePool);

describe('scaffoldCard', () => {
  it('drafts a removal spell from its IR: cast it on a legal target, expect the target destroyed', () => {
    const result = scaffold('Doom Blade');
    expect(result.units).toEqual([
      expect.objectContaining({ part: 'spellAbility', clause: 1, status: 'scaffolded' }),
    ]);
    const [scenario] = result.file.scenarios;
    expect(scenario!.title).toContain(`generated scaffold v${SCAFFOLD_VERSION}`);
    expect(scenario!.script[0]).toMatchObject({ player: 'P1', targets: ['Scaffold Foe'] });
    expect(scenario!.expect).toContainEqual({
      zone: { player: 'P2', zone: 'graveyard', has: ['Scaffold Foe'] },
    });
  });

  it('writes a file the strict parser accepts and the runner passes, after a JSON round trip', () => {
    for (const name of [
      'Doom Blade',
      'Thraben Inspector',
      'Monastery Swiftspear',
      'Noble Hierarch',
    ]) {
      const { file } = scaffold(name);
      expect(file.scenarios.length, name).toBeGreaterThan(0);
      const parsed = parseCardScenarioFile(JSON.parse(JSON.stringify(file)), name);
      for (const scenario of parsed.scenarios)
        expect(scenarioFailures(runScenario(parsed, scenario), scenario), scenario.id).toEqual([]);
    }
  });

  it('pins exact counts: a draw of one expects the top card in hand and the next one not', () => {
    const { file } = scaffold('Thraben Inspector');
    // Thraben Inspector investigates: one Clue, by event count and on the battlefield.
    expect(file.scenarios[0]!.expect).toContainEqual({
      event: { type: 'tokenCreated', payload: '"Clue', count: 1 },
    });
  });

  it('drafts each symbol of a mana ability as its own payment', () => {
    const { file, units } = scaffold('Noble Hierarch');
    expect(units.find((unit) => unit.part === 'manaAbilities[0]')?.status).toBe('scaffolded');
    expect(
      file.scenarios.map((scenario) => scenario.id).filter((id) => id.includes('mana')),
    ).toHaveLength(3);
  });

  it('keeps a draft that the card under test fails out of the file, and reports it', () => {
    // A wrong card: Doom Blade that exiles instead of destroying. The draft is generated from the
    // right IR, so the engine run under the wrong one must fail it.
    const right = scaffold('Doom Blade').file;
    const previous = installDefinitionTransform((definition) =>
      definition.name === 'Doom Blade'
        ? {
            ...definition,
            spellAbility: {
              ...definition.spellAbility!,
              effects: [{ op: 'exile', target: 0 }],
            },
          }
        : definition,
    );
    try {
      const scenario = right.scenarios[0]!;
      expect(scenarioFailures(runScenario(right, scenario), scenario)).not.toEqual([]);
      // And drafting under the wrong IR describes the wrong IR, which the review must catch.
      const wrong = scaffold('Doom Blade');
      expect(wrong.file.scenarios[0]!.expectedOutcome).toMatch(/exiled/);
    } finally {
      installDefinitionTransform(previous);
    }
  });

  it('reports shapes it does not draft instead of guessing', () => {
    const result = scaffold('Innocuous Rat');
    expect(result.file.scenarios).toEqual([]);
    expect(result.units[0]).toMatchObject({ status: 'unsupported' });
    expect(result.units[0]!.reason).toMatch(/manifestDread/);
  });

  it('drafts nothing for an unmodeled card', () => {
    const card = pinStore.get('Doom Blade');
    const unmodeled = { ...card, name: 'Scaffold Riddle', oracleText: 'Frobnicate the zorp.' };
    expect(interpretCard(unmodeled).modeled).toBe(false);
    expect(scaffoldCard(unmodeled, resolveScenarioCard).units).toEqual([
      expect.objectContaining({ part: 'card', status: 'unsupported' }),
    ]);
  });

  it('drafts a static on both sides of its selector, so a widened selector fails too', () => {
    const { file, units } = scaffoldPool('Glorious Anthem');
    expect(units).toEqual([
      expect.objectContaining({ part: 'staticEffects[0]', status: 'scaffolded' }),
    ]);
    expect(file.scenarios[0]!.expect).toEqual([
      { stats: { card: 'Scaffold Squire', player: 'P1', power: 3, toughness: 3 } },
      { stats: { card: 'Scaffold Rival', player: 'P2', power: 2, toughness: 2 } },
    ]);
  });

  it('attaches an Equipment to its subject for an attached static', () => {
    const { file } = scaffoldPool('Lightning Greaves');
    const [haste] = file.scenarios;
    expect(haste!.seats.P1!.battlefield).toContainEqual({
      card: 'Lightning Greaves',
      attachedTo: { player: 'P1', card: 'Scaffold Squire' },
    });
    expect(haste!.expect).toContainEqual({
      keywords: { card: 'Scaffold Rival', player: 'P2', lacks: ['haste'] },
    });
  });

  it('reaches an upkeep trigger through the turn structure, from the seat before P1', () => {
    const { file, units } = scaffoldPool('Phyrexian Arena');
    expect(units[0]).toMatchObject({ part: 'triggers[0]', status: 'scaffolded' });
    expect(file.scenarios[0]).toMatchObject({
      turn: { player: 'P4' },
      continue: { throughUpkeeps: 1 },
      end: 'gameOver',
      script: [],
    });
    expect(file.scenarios[0]!.expect).toContainEqual({ life: { player: 'P1', equals: 39 } });
  });

  it('bottoms a scried card so the draw after it shows the scry happened', () => {
    const { file } = scaffoldPool('Opt');
    const [scenario] = file.scenarios;
    expect(scenario!.clauses).toEqual([1, 2]);
    expect(scenario!.expect).toContainEqual({
      zone: { player: 'P1', zone: 'hand', has: ['Scaffold Page 2'] },
    });
    expect(scenario!.expect).toContainEqual({
      event: { type: 'scry', payload: '"looked":1,"bottomed":1', count: 1 },
    });
  });

  it('expects the exact power and toughness a pump gives its target', () => {
    const { file } = scaffoldPool('Giant Growth');
    expect(file.scenarios[0]!.expect).toContainEqual({
      stats: { card: 'Scaffold Ally', power: 4, toughness: 5, player: 'P1' },
    });
  });

  it('expects a negative power when a shrink takes the target below zero', () => {
    const { file, units } = scaffoldPool('Grasp of Darkness');
    expect(units.map((unit) => unit.status)).toEqual(['scaffolded']);
    expect(file.scenarios[0]!.expect).toContainEqual(
      expect.objectContaining({ stats: expect.objectContaining({ power: -3 }) }),
    );
  });

  it('drafts each mode of a modal spell through the cast action that names it', () => {
    const { file, units } = scaffold('Rakdos Charm');
    expect(units.map((unit) => unit.status)).toEqual(['unsupported', 'scaffolded', 'unsupported']);
    expect(file.scenarios.map((scenario) => scenario.id)).toEqual([
      'rakdos-charm-scaffold-spellability-mode-2',
    ]);
    expect(file.scenarios[0]!.script[0]!.choose).toMatch(/Destroy target artifact/);
  });

  it('fails a static draft under a wrong power change', () => {
    const right = scaffoldPool('Glorious Anthem').file;
    const previous = installDefinitionTransform((definition) =>
      definition.name === 'Glorious Anthem'
        ? {
            ...definition,
            staticEffects: definition.staticEffects.map((effect) => ({
              ...effect,
              op: { ...effect.op, power: 2 } as typeof effect.op,
            })),
          }
        : definition,
    );
    try {
      const scenario = right.scenarios[0]!;
      expect(
        scenarioFailures(runScenario(right, scenario, { resolve: resolvePool }), scenario),
      ).toContain('Scaffold Squire has power 4, expected 3');
    } finally {
      installDefinitionTransform(previous);
    }
  });
});
