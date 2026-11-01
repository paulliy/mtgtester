import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { interpretCard } from '@mtg/engine';
import type { OracleCard } from '@mtg/shared';
import { BUG_HUNT_SCENARIO_IDS } from './bug-hunt-scenarios';
import { strictCardTestScenario } from './card-test-scenarios';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

describe('bug-hunt card regression evidence', () => {
  it('pins complete Oracle cards and equal real/fixture interpretation', () => {
    const fixture = JSON.parse(
      readFileSync('packages/engine/tests/fixtures/bug-hunt-oracle.json', 'utf8'),
    ) as {
      cards: { card: OracleCard; sha256: string }[];
    };
    for (const { card, sha256 } of fixture.cards) {
      expect(
        createHash('sha256')
          .update(JSON.stringify(canonical(card)))
          .digest('hex'),
      ).toBe(sha256);
      const actual = interpretCard(card);
      const alias = interpretCard({
        ...card,
        oracleId: `oracle-${card.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      });
      expect(actual.modeled, card.name).toBe(true);
      expect(alias.modeled, card.name).toBe(true);
      const { oracleId: _actualId, ...actualDefinition } = actual;
      const { oracleId: _aliasId, ...aliasDefinition } = alias;
      expect(aliasDefinition, card.name).toEqual(actualDefinition);
    }
  });

  it.each(BUG_HUNT_SCENARIO_IDS)(
    'runs %s through legal actions, payment, priority and resolution',
    (id) => {
      const scenario = strictCardTestScenario(id, `lab-test-${id}`)!;
      expect(scenario).not.toBeNull();
      const engine = scenario.engine;
      let performed = false;
      for (let i = 0; i < 80; i++) {
        const step = engine.advance();
        if (step.kind === 'gameOver') break;
        if (step.kind !== 'decision') continue;
        const request = step.request;
        const main =
          !performed &&
          request.decidingPlayer === 'P1' &&
          request.legalActions.find((action) =>
            id.includes('token-characteristics')
              ? action.type === 'activateAbility' && action.description.includes('Dawn of Hope')
              : action.type === 'castSpell',
          );
        const action =
          main ||
          request.legalActions.find((a) => a.type === 'pass' || a.description === 'Find nothing') ||
          request.legalActions[0]!;
        if (main) performed = true;
        const targets =
          action.targets?.map((slot) => ({
            slot: slot.slot,
            choice:
              slot.options.find((option) => {
                const permanent = engine.view('P1').battlefield.find((p) => p.id === option);
                return action.type === 'castSpell' && id.includes('aura')
                  ? permanent?.name === 'Llanowar Elves'
                  : id.includes('aura')
                    ? permanent?.name === 'Solemn Simulacrum'
                    : option === 'P2';
              }) ?? slot.options[0]!,
          })) ?? [];
        engine.submit({ requestId: request.requestId, actionId: action.id, targets });
      }
      expect(performed).toBe(true);
      const view = engine.view('P1');
      if (id.includes('aura')) {
        const aura = engine.getState().battlefield.find((p) => p.name === 'Chains of Custody')!;
        expect(aura.attachedTo).toBe(view.battlefield.find((p) => p.name === 'Llanowar Elves')!.id);
        expect(view.battlefield.some((p) => p.name === 'Solemn Simulacrum')).toBe(false);
        expect(engine.getState().exile.some((p) => p.name === 'Solemn Simulacrum')).toBe(true);
      } else if (id.includes('mana-source')) {
        expect(view.battlefield.some((p) => p.name === 'Llanowar Elves')).toBe(false);
        expect(view.battlefield.find((p) => p.name === 'Phyrexian Tower')?.tapped).toBe(true);
        expect(
          engine
            .getState()
            .eventLog.some(
              (e) =>
                e.type === 'resolved' && String(e.payload['description']).includes('Cultivate'),
            ),
        ).toBe(true);
      } else if (id.includes('token')) {
        const soldiers = view.battlefield.filter((p) => p.name === 'Soldier');
        expect(soldiers).toHaveLength(2);
        expect(soldiers[0]!.keywords).toContain('lifelink');
        expect(soldiers[1]!.keywords ?? []).not.toContain('lifelink');
      } else {
        expect(view.opponents.find((p) => p.seat === 'P2')!.life).toBe(34);
      }
    },
  );
});
