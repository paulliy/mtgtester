import { describe, expect, it } from 'vitest';
import type { Value } from '../src/cards/value';
import type { Ability, Effect, TargetSpec } from '../src/cards/ability';
import type { Condition } from '../src/cards/condition';
import { validateCardDefinition } from '../src/cards/authoring-validation';
import { evaluateValueIn } from '../src/effects/values';
import { interpretCard } from '../src/cards/interpret';
import { createGame } from '../src/state/game';
import { applyPriorityAction } from '../src/actions/apply';
import { runPrioritySequence } from '../src/turn/priority';
import { queueStepTriggers } from '../src/turn/turn';
import { conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';

const values: Value[] = [
  { kind: 'powerOfTriggerObject' },
  { kind: 'countersOnTriggerObject', counter: 'charge' },
  { kind: 'powerOfTarget', target: 'triggerObject' },
  { kind: 'manaValueOfTarget', target: 'triggerObject' },
  { kind: 'countersOnTarget', target: 'triggerObject', counter: 'charge' },
];
const definition = () =>
  interpretCard(
    oracle({
      name: 'Independent event provenance witness',
      typeLine: 'Sorcery',
      manaCost: '{0}',
      oracleText: 'You gain 1 life.',
    }),
  );
describe('implicit event information requires an implemented owning event scope', () => {
  it('a checked player or an unguarded mixed domain cannot supply permanent event information', () => {
    const effect: Effect = {
      op: 'conditionalEffect',
      checkTarget: 0,
      condition: { kind: 'triggerObjectMatches', selector: { kind: 'type', value: 'Creature' } },
      then: [{ op: 'gainLife', amount: { kind: 'powerOfTriggerObject' } }],
      else: [],
    };
    const issues = (target: TargetSpec, branch: Effect) =>
      validateCardDefinition({
        ...definition(),
        spellAbility: { kind: 'spell', targets: [target], effects: [branch] },
      });
    expect(
      issues({ kind: 'player' }, effect).some((issue) => issue.message.includes('event object')),
    ).toBe(true);
    expect(
      issues({ kind: 'anyTarget' }, { ...effect, then: [], else: effect.then }).some((issue) =>
        issue.message.includes('event object'),
      ),
    ).toBe(true);
    expect(
      issues({ kind: 'anyTarget' }, { ...effect, condition: { kind: 'yourTurn' } }).some((issue) =>
        issue.message.includes('event object'),
      ),
    ).toBe(true);
    expect(issues({ kind: 'anyTarget' }, effect)).toEqual([]);
  });
  it('a normal command-zone move supplies the remembered battlefield object to a delayed ability', () => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'precombatMain';
    const player = ctx.state.players[0]!;
    const commander = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Independent remembered commander',
        typeLine: 'Legendary Creature',
        power: '7',
        toughness: '7',
      }),
      'command',
      { isCommander: true },
    );
    player.commanderCardIds.push(commander.cardId);
    const spell = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Independent commander delayed information',
        typeLine: 'Sorcery',
        manaCost: '{0}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    const delayed: Effect = {
      op: 'registerDelayedTrigger',
      target: 0,
      when: 'upkeep',
      expiry: 'onFire',
      ability: {
        kind: 'triggered',
        targets: [],
        effects: [{ op: 'gainLife', amount: { kind: 'powerOfTriggerObject' } }],
      },
    };
    const base = ctx.defs.get(spell.oracleId)!;
    const ability: Ability = {
      kind: 'spell',
      targets: [{ kind: 'commanderInCommandZone' }],
      effects: [{ op: 'commandZoneToBattlefield', target: 0 }, delayed],
    };
    const def = { ...base, spellAbility: ability };
    expect(validateCardDefinition(def)).toEqual([]);
    expect(
      validateCardDefinition({ ...base, spellAbility: { ...ability, effects: [delayed] } }).some(
        (issue) => issue.message.includes('event object'),
      ),
    ).toBe(true);
    expect(
      validateCardDefinition({
        ...base,
        spellAbility: { ...ability, effects: [delayed, ability.effects[0]!] },
      }).some((issue) => issue.message.includes('event object')),
    ).toBe(true);
    expect(
      validateCardDefinition({
        ...base,
        spellAbility: {
          ...ability,
          effects: [
            {
              op: 'conditionalEffect',
              condition: { kind: 'yourTurn' },
              then: [ability.effects[0]!],
              else: [],
            },
            delayed,
          ],
        },
      }).some((issue) => issue.message.includes('event object')),
    ).toBe(true);
    ctx.defs.set(spell.oracleId, def);
    pump(
      applyPriorityAction(
        ctx,
        player,
        { kind: 'castSpell', objectId: spell.id, fromCommand: false },
        { index: 0, targets: new Map([[0, commander.id]]) },
      ),
    );
    pump(runPrioritySequence(ctx));
    const permanent = ctx.state.battlefield.find((object) => object.cardId === commander.cardId)!;
    expect(permanent).toBeDefined();
    expect(ctx.state.delayedTriggers[0]!.targetObjectId).toBe(permanent.id);
    queueStepTriggers(ctx, 'upkeep');
    pump(runPrioritySequence(ctx));
    expect(player.life).toBe(47);
  });
  for (const nestedKind of ['spell', 'activated', 'triggered'] as const)
    it(`an outer event does not supply an unrelated nested ${nestedKind} ability`, () => {
      const nested: Ability = {
        kind: nestedKind,
        targets: [],
        effects: [{ op: 'gainLife', amount: { kind: 'powerOfTriggerObject' } }],
      };
      const def = {
        ...definition(),
        spellAbility: null,
        triggers: [
          {
            kind: 'triggered' as const,
            trigger: {
              when: 'enters' as const,
              subject: {
                kind: 'permanent' as const,
                selector: { kind: 'type' as const, value: 'Creature' },
              },
            },
            targets: [],
            effects: [
              {
                op: 'grantAbilityUntilEot' as const,
                target: 'triggerObject' as const,
                ability: nested,
              },
            ],
          },
        ],
      };
      expect(
        validateCardDefinition(def).some((issue) => issue.message.includes('event object')),
      ).toBe(true);
    });

  it('a conditional checked target provides its event binding to nested chosen effects', () => {
    const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
    ctx.state.currentTurnPlayer = 'P1';
    ctx.state.activePlayerIndex = 0;
    ctx.state.phase = 'precombatMain';
    const player = ctx.state.players[0]!;
    const target = spawn(
      ctx,
      'P2',
      oracle({ name: 'Independent checked event witness', power: '7', toughness: '7' }),
    );
    const card = conjure(
      ctx,
      'P1',
      oracle({
        name: 'Independent checked event binding',
        typeLine: 'Sorcery',
        manaCost: '{0}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    const def = {
      ...ctx.defs.get(card.oracleId)!,
      spellAbility: {
        kind: 'spell' as const,
        targets: [{ kind: 'creature' as const }],
        effects: [
          {
            op: 'conditionalEffect' as const,
            checkTarget: 0,
            condition: {
              kind: 'triggerObjectMatches' as const,
              selector: { kind: 'type' as const, value: 'Creature' },
            },
            then: [
              {
                op: 'chooseOne' as const,
                options: [
                  {
                    description: 'Read and mark the checked object',
                    effects: [
                      {
                        op: 'gainLife' as const,
                        amount: { kind: 'powerOfTriggerObject' as const },
                      },
                      {
                        op: 'putCounters' as const,
                        target: 'triggerObject' as const,
                        counter: 'charge',
                        count: 1,
                      },
                    ],
                  },
                ],
              },
            ],
            else: [],
          },
        ],
      },
    };
    expect(validateCardDefinition(def)).toEqual([]);
    ctx.defs.set(card.oracleId, def);
    pump(
      applyPriorityAction(
        ctx,
        player,
        { kind: 'castSpell', objectId: card.id, fromCommand: false },
        { index: 0, targets: new Map([[0, target.id]]) },
      ),
    );
    pump(runPrioritySequence(ctx));
    expect(player.life).toBe(47);
    expect(target.counters['charge']).toBe(1);
  });
  for (const value of values)
    for (const scope of ['spell', 'self trigger', 'card-zone trigger'] as const)
      it(`${value.kind} rejects ${scope} without a permanent event referent`, () => {
        const base = definition();
        const ability: Ability = {
          kind: scope === 'spell' ? 'spell' : 'triggered',
          targets: [],
          effects: [{ op: 'gainLife', amount: value }],
          ...(scope === 'spell'
            ? {}
            : {
                trigger:
                  scope === 'self trigger'
                    ? { when: 'enters' as const, subject: { kind: 'self' as const } }
                    : {
                        when: 'putIntoGraveyardFromAnywhere' as const,
                        subject: {
                          kind: 'permanent' as const,
                          selector: { kind: 'type' as const, value: 'Creature' },
                        },
                      },
              }),
        };
        const card =
          scope === 'spell'
            ? { ...base, spellAbility: ability }
            : { ...base, spellAbility: null, triggers: [ability] };
        expect(
          validateCardDefinition(card).some((issue) => issue.message.includes('event object')),
        ).toBe(true);
      });
  for (const condition of [
    { kind: 'triggerObjectMatches', selector: { kind: 'type', value: 'Creature' } },
    { kind: 'triggerObjectHadToAttackThisCombat' },
    { kind: 'triggerObjectAttackingOpponent' },
  ] satisfies Condition[])
    it(`${condition.kind} rejects a spell predicate lacking an event object`, () => {
      const card = {
        ...definition(),
        spellAbility: {
          kind: 'spell' as const,
          targets: [],
          effects: [
            {
              op: 'conditionalEffect' as const,
              condition,
              then: [{ op: 'gainLife' as const, amount: { kind: 'const' as const, n: 7 } }],
              else: [],
            },
          ],
        },
      };
      expect(
        validateCardDefinition(card).some((issue) => issue.message.includes('event object')),
      ).toBe(true);
    });
  for (const value of values)
    it(`${value.kind} rejects runtime evaluation with no bound event`, () => {
      const ctx = createGame(gameConfig([0, 1].map(() => ({ cards: copies(8, forest) }))));
      expect(() => evaluateValueIn(ctx, value, { controllerId: 'P1' })).toThrow('event object');
    });
});
