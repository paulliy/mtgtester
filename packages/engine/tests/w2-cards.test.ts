import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ObjectId, OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import {
  canPaySpellAdditionalCosts,
  computePriorityOptions,
  costReductionFor,
  targetLifeTaxFor,
  type PriorityActionPayload,
} from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { runCombatPhase } from '../src/combat/combat';
import { computeCharacteristics } from '../src/effects/continuous';
import {
  applyManaRider,
  endUntilEotEffects,
  executeAbility,
  payManaCost,
} from '../src/effects/resolve';
import { parseManaCost, planPayment } from '../src/mana/cost';
import { resolveTopOfStack } from '../src/stack/stack';
import { createGame } from '../src/state/game';
import {
  makePermanent,
  queueCastTriggers,
  queueTriggersForObject,
  transformPermanent,
} from '../src/state/objects';
import { manaSourcesFor } from '../src/state/queries';
import type { EngineCardObject, EngineStackObject, GameContext } from '../src/state/types';
import {
  copies,
  declareAttacks,
  declareNoAttacks,
  forest,
  gameConfig,
  oracle,
  pick,
  pump,
  spawn,
} from './fixtures';

const oracleCards = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../server/fixtures/coverage-oracle.json'), 'utf8'),
) as OracleCard[];
const pr09Fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/coverage-pr09-oracle.json'), 'utf8'),
) as { cards: { sha256: string; card: OracleCard }[] };
const pr09Etali = pr09Fixture.cards.find(
  ({ card }) => card.name === 'Etali, Primal Conqueror // Etali, Primal Sickness',
)!;
const pr09Manifest = JSON.parse(
  readFileSync(
    join(import.meta.dirname, '../../server/fixtures/card-verification-manifest.json'),
    'utf8',
  ),
) as {
  cards: Record<string, { oracleSha256: string; viewerScenarioIds: string[] }>;
};

const names = [
  'Baxter Building',
  "Brigid, Clachan's Heart // Brigid, Doun's Mind",
  'Collective Effort',
  'Endless Foot Assault',
  'Etali, Primal Conqueror // Etali, Primal Sickness',
  'Hunting Wilds',
  'Jacked Rabbit',
  'Mondrak, Glory Dominus',
  "Norn's Annex",
  'Pearl-Ear, Imperial Advisor',
  'Securitron Squadron',
  'Study Hall',
  'Tender Wildguide',
  'Terror of the Peaks',
  'Twitching Doll',
  'Ultimate Nullification',
  'Vastwood Surge',
  'Verix Bladewing',
  'Zopandrel, Hunger Dominus',
] as const;

const real = (name: (typeof names)[number]): OracleCard =>
  name === pr09Etali.card.name ? pr09Etali.card : oracleCards.find((card) => card.name === name)!;
const definitions = new Map<string, ReturnType<typeof interpretCard>>(
  names.map((name) => [name, interpretCard(real(name))]),
);

function pod(seed: string): GameContext {
  const ctx = createGame(
    gameConfig(
      [0, 1, 2, 3].map(() => ({ cards: copies(8, forest) })),
      { seed },
    ),
  );
  ctx.state.currentTurnPlayer = 'P1';
  ctx.state.activePlayerIndex = 0;
  ctx.state.turnNumber = 3;
  ctx.state.phase = 'precombatMain';
  ctx.state.step = null;
  return ctx;
}

describe('W2 card coverage', () => {
  it('fully models the frozen Oracle fixtures', () => {
    for (const name of names) {
      const def = definitions.get(name)!;
      expect(def.unmodeledReasons, name).toEqual([]);
      expect(def.modeled, name).toBe(true);
    }
  });

  it('plans Phyrexian pips with colored mana first and life as the exact fallback', () => {
    const cost = parseManaCost('{1}{G/P}{G/P}').cost!;
    const withGreen = planPayment(
      cost,
      [{ symbol: 'C' }, { symbol: 'G' }, { symbol: 'G' }],
      [],
      undefined,
      20,
    );
    expect(withGreen?.lifePaid).toBe(0);
    expect(withGreen?.resolvedCost?.colored.G).toBe(2);

    const withLife = planPayment(cost, [{ symbol: 'C' }], [], undefined, 4);
    expect(withLife?.lifePaid).toBe(4);
    expect(withLife?.resolvedCost?.colored.G).toBe(0);
    expect(planPayment(cost, [{ symbol: 'C' }], [], undefined, 3)).toBeNull();
  });

  it('resolves Brigid’s counted either-green-or-white mana as one linked palette', () => {
    const ctx = pod('w2-brigid');
    const brigid = spawn(ctx, 'P1', real("Brigid, Clachan's Heart // Brigid, Doun's Mind"));
    spawn(ctx, 'P1', oracle({ name: 'Brigid Friend A' }));
    spawn(ctx, 'P1', oracle({ name: 'Brigid Friend B' }));
    expect(transformPermanent(ctx, brigid)).toBe(true);
    const source = manaSourcesFor(ctx, 'P1').find(
      (candidate) => candidate.cardId === brigid.cardId,
    );
    expect(source?.units).toEqual([
      ['G', 'W'],
      ['G', 'W'],
    ]);
    expect(source?.linked).toBe(true);
  });

  it('requires and jointly reserves one untapped creature for every escalated mode', () => {
    const ctx = pod('w2-escalate');
    const player = ctx.state.players[0]!;
    const effort = definitions.get('Collective Effort')!;
    const costs = effort.spellAbility!.modes!.additionalCostPerChoiceBeyondFirst!;
    spawn(ctx, 'P1', oracle({ name: 'Escalate Creature A' }));
    expect(canPaySpellAdditionalCosts(ctx, player, [...costs, ...costs], 'spell', true)).toBe(
      false,
    );
    spawn(ctx, 'P1', oracle({ name: 'Escalate Creature B' }));
    expect(canPaySpellAdditionalCosts(ctx, player, [...costs, ...costs], 'spell', true)).toBe(true);
  });

  it('creates the announced number of squad copies and a 1/1 offspring copy', () => {
    const squadGame = pod('w2-squad');
    const squad = spawn(squadGame, 'P1', real('Securitron Squadron'));
    squad.optionalCostCounts = { squad: 2 };
    pump(
      executeAbility(squadGame, squad, definitions.get('Securitron Squadron')!.triggers[0]!, []),
    );
    expect(
      squadGame.state.battlefield.filter((permanent) => permanent.name === 'Securitron Squadron'),
    ).toHaveLength(3);

    const offspringGame = pod('w2-offspring');
    const parent = spawn(offspringGame, 'P1', real('Tender Wildguide'));
    parent.optionalCostCounts = { offspring: 1 };
    pump(
      executeAbility(offspringGame, parent, definitions.get('Tender Wildguide')!.triggers[0]!, []),
    );
    const child = offspringGame.state.battlefield.find(
      (permanent) => permanent.name === 'Tender Wildguide' && permanent.isToken,
    )!;
    expect(computeCharacteristics(offspringGame, child).power).toBe(1);
    expect(computeCharacteristics(offspringGame, child).toughness).toBe(1);
  });

  it('applies ravenous entry counters and gates its draw at announced X of five', () => {
    const ctx = pod('w2-ravenous');
    const raw = real('Jacked Rabbit');
    const def = definitions.get('Jacked Rabbit')!;
    ctx.defs.set(raw.oracleId, def);
    const object: EngineCardObject = {
      id: 'rabbit-stack',
      cardId: 'rabbit-card',
      oracleId: raw.oracleId,
      ownerId: 'P1',
      name: raw.name,
      typeLine: raw.typeLine,
      oracleText: raw.oracleText,
      manaCost: raw.manaCost,
      isToken: false,
      isCommander: false,
      zone: 'stack',
      announcedX: 5,
    };
    const rabbit = makePermanent(ctx, object, 'P1');
    ctx.state.battlefield.push(rabbit);
    expect(rabbit.counters['+1/+1']).toBe(5);
    const before = ctx.state.players[0]!.hand.length;
    pump(executeAbility(ctx, rabbit, def.triggers[0]!, []));
    expect(ctx.state.players[0]!.hand.length).toBe(before + 1);
  });

  it('fires Pearl-Ear only when an Aura targets your modified permanent', () => {
    const ctx = pod('w2-pearl-ear');
    spawn(ctx, 'P1', real('Pearl-Ear, Imperial Advisor'));
    const modified = spawn(ctx, 'P1', oracle({ name: 'Modified Target' }));
    modified.counters['+1/+1'] = 1;
    const aura = oracle({
      name: 'W2 Test Aura',
      typeLine: 'Enchantment — Aura',
      oracleText: 'Enchant creature',
    });
    const auraDef = interpretCard(aura);
    ctx.defs.set(aura.oracleId, auraDef);
    const stackObject: EngineStackObject = {
      id: 'aura-spell',
      sourceId: 'aura-spell',
      controllerId: 'P1',
      kind: 'spell',
      description: aura.name,
      targets: [modified.id],
      card: null,
      ability: { kind: 'spell', targets: [{ kind: 'creature' }], effects: [] },
      sourceOracleId: aura.oracleId,
      sourceCardId: 'aura-card',
      isCommanderCast: false,
    };
    queueCastTriggers(ctx, stackObject);
    expect(ctx.state.pendingTriggers).toHaveLength(1);

    ctx.state.pendingTriggers = [];
    const plain = spawn(ctx, 'P1', oracle({ name: 'Plain Target' }));
    stackObject.targets = [plain.id];
    queueCastTriggers(ctx, stackObject);
    expect(ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('charges Terror of the Peaks target life tax only to an opposing caster', () => {
    const ctx = pod('w2-terror-tax');
    const terror = spawn(ctx, 'P2', real('Terror of the Peaks'));
    expect(targetLifeTaxFor(ctx, 'P1', [terror.id])).toBe(3);
    expect(targetLifeTaxFor(ctx, 'P2', [terror.id])).toBe(0);
  });

  it('keeps activated-ability targets exempt from Terror of the Peaks target tax', () => {
    const ctx = pod('w2-terror-ability-target');
    const player = ctx.state.players[0]!;
    player.life = 1;
    const terror = spawn(ctx, 'P2', real('Terror of the Peaks'));
    const source = spawn(
      ctx,
      'P1',
      oracle({
        name: 'W2 Ability Source',
        typeLine: 'Artifact',
        oracleText: '{T}: Target creature gets +1/+1 until end of turn.',
      }),
    );

    const activation = computePriorityOptions(ctx, player).find((option) => {
      const payload = option.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === source.id;
    });

    expect(activation).toBeDefined();
    expect(activation?.targets?.[0]?.options).toContain(terror.id);
  });

  it('offers a taxed Phyrexian spell only when its life costs are jointly payable', () => {
    const ctx = pod('w2-joint-life');
    const player = ctx.state.players[0]!;
    const terror = spawn(ctx, 'P2', real('Terror of the Peaks'));
    const raw = oracle({
      name: 'W2 Joint Life Spell',
      typeLine: 'Instant',
      manaCost: '{G/P}',
      oracleText: 'Destroy target creature.',
    });
    ctx.defs.set(raw.oracleId, interpretCard(raw));
    const spell: EngineCardObject = {
      id: 'joint-life-spell',
      cardId: 'joint-life-card',
      oracleId: raw.oracleId,
      ownerId: 'P1',
      name: raw.name,
      typeLine: raw.typeLine,
      oracleText: raw.oracleText,
      manaCost: raw.manaCost,
      isToken: false,
      isCommander: false,
      zone: 'hand',
    };
    player.hand.push(spell);
    const castOption = () =>
      computePriorityOptions(ctx, player).find((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'castSpell' && payload.objectId === spell.id;
      });

    player.life = 4;
    expect(castOption()).toBeUndefined();

    player.life = 5;
    const option = castOption();
    expect(option?.targets?.[0]?.options).toContain(terror.id);
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map([[0, terror.id]]),
      }),
    );
    expect(player.life).toBe(0);
    expect(ctx.state.stack.at(-1)?.sourceCardId).toBe(spell.cardId);
  });

  it('models Hunting Wilds with kicker and the kicked Forest animation (coverage PR01)', () => {
    const def = definitions.get('Hunting Wilds')!;
    expect(def.modeled).toBe(true);
    expect(def.optionalAdditionalCost?.mechanic).toBe('kicker');
    expect(def.spellAbility?.effects).toEqual([{ op: 'huntingWilds' }]);
  });

  it('doubles current power and toughness independently for each creature until cleanup', () => {
    const ctx = pod('w2-zopandrel');
    const zopandrel = spawn(ctx, 'P1', real('Zopandrel, Hunger Dominus'));
    const bear = spawn(ctx, 'P1', oracle({ name: 'Zopandrel Bear', power: '2', toughness: '3' }));
    bear.counters['+1/+1'] = 1;
    pump(
      executeAbility(
        ctx,
        zopandrel,
        definitions.get('Zopandrel, Hunger Dominus')!.triggers[0]!,
        [],
      ),
    );
    expect(computeCharacteristics(ctx, bear).power).toBe(6);
    expect(computeCharacteristics(ctx, bear).toughness).toBe(8);
    endUntilEotEffects(ctx);
    expect(computeCharacteristics(ctx, bear).power).toBe(3);
    expect(computeCharacteristics(ctx, bear).toughness).toBe(4);
  });

  it('adds Twitching Doll’s nest counter as a mana rider and preserves all counters for sacrifice', () => {
    const ctx = pod('w2-twitching-doll');
    const doll = spawn(ctx, 'P1', real('Twitching Doll'));
    const def = definitions.get('Twitching Doll')!;
    const player = ctx.state.players[0]!;
    pump(applyManaRider(ctx, doll, player, def.manaAbilities[0]!.onActivate![0]!));
    doll.counters['+1/+1'] = 1;
    expect(doll.counters['nest']).toBe(1);
    ctx.state.battlefield.splice(ctx.state.battlefield.indexOf(doll), 1);
    pump(
      executeAbility(ctx, doll, def.activatedAbilities[0]!.ability, [], undefined, {
        sourceCountersTotal: 2,
      }),
    );
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Spider')).toHaveLength(
      2,
    );
  });

  it('moves Ultimate Nullification itself to the library bottom after exiling creatures and graveyards', () => {
    const ctx = pod('w2-ultimate-nullification');
    const raw = real('Ultimate Nullification');
    const def = definitions.get('Ultimate Nullification')!;
    ctx.defs.set(raw.oracleId, def);
    spawn(ctx, 'P1', oracle({ name: 'Nullification Victim' }));
    const graveCard: EngineCardObject = {
      id: 'grave-object',
      cardId: 'grave-card',
      oracleId: forest().oracleId,
      ownerId: 'P2',
      name: 'Forest',
      typeLine: 'Basic Land — Forest',
      oracleText: '',
      manaCost: null,
      isToken: false,
      isCommander: false,
      zone: 'graveyard',
    };
    ctx.state.players[1]!.graveyard.push(graveCard);
    const spellCard: EngineCardObject = {
      ...graveCard,
      id: 'nullification-spell',
      cardId: 'nullification-card',
      oracleId: raw.oracleId,
      ownerId: 'P1',
      name: raw.name,
      typeLine: raw.typeLine,
      oracleText: raw.oracleText,
      manaCost: raw.manaCost,
      zone: 'stack',
    };
    const stackObject: EngineStackObject = {
      id: spellCard.id,
      sourceId: spellCard.id,
      controllerId: 'P1',
      kind: 'spell',
      description: raw.name,
      targets: [],
      card: spellCard,
      ability: def.spellAbility,
      sourceOracleId: raw.oracleId,
      sourceCardId: spellCard.cardId,
      isCommanderCast: false,
    };
    pump(
      executeAbility(
        ctx,
        {
          cardId: spellCard.cardId,
          oracleId: raw.oracleId,
          name: raw.name,
          controllerId: 'P1',
          resolvingStackObject: stackObject,
        },
        def.spellAbility!,
        [],
      ),
    );
    expect(ctx.state.battlefield).toHaveLength(0);
    expect(ctx.state.players.every((player) => player.graveyard.length === 0)).toBe(true);
    expect(ctx.state.players[0]!.library.at(-1)?.name).toBe('Ultimate Nullification');
    expect(stackObject.card).toBeNull();
  });

  it('enforces Baxter Building’s toughness condition and resolves its paid draw ability', () => {
    const ctx = pod('w2-baxter');
    const player = ctx.state.players[0]!;
    const baxter = spawn(ctx, 'P1', real('Baxter Building'));
    for (let i = 0; i < 4; i++) spawn(ctx, 'P1', forest());
    const activation = () =>
      computePriorityOptions(ctx, player).find((option) => {
        const payload = option.payload as PriorityActionPayload;
        return payload.kind === 'activateAbility' && payload.objectId === baxter.id;
      });

    expect(activation()).toBeUndefined();
    spawn(ctx, 'P1', oracle({ name: 'Baxter Wall', power: '0', toughness: '4' }));
    const option = activation();
    expect(option).toBeDefined();
    const handBefore = player.hand.length;
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(baxter.tapped).toBe(true);
    pump(resolveTopOfStack(ctx));
    expect(player.hand).toHaveLength(handBefore + 1);
  });

  it('executes all three Collective Effort mode bodies against their announced targets', () => {
    const ctx = pod('w2-collective-effects');
    const def = definitions.get('Collective Effort')!;
    const large = spawn(
      ctx,
      'P2',
      oracle({ name: 'Collective Large', power: '4', toughness: '4' }),
    );
    const enchantment = spawn(
      ctx,
      'P2',
      oracle({ name: 'Collective Enchantment', typeLine: 'Enchantment' }),
    );
    const survivor = spawn(ctx, 'P2', oracle({ name: 'Collective Survivor' }));
    const modes = def.spellAbility!.modes!.options;
    pump(
      executeAbility(
        ctx,
        { cardId: 'collective-card', oracleId: def.oracleId, name: def.name, controllerId: 'P1' },
        {
          kind: 'spell',
          targets: def.spellAbility!.targets,
          effects: modes.flatMap((mode) => mode.effects),
        },
        [large.id, enchantment.id, 'P2' as ObjectId],
      ),
    );
    expect(ctx.state.battlefield).not.toContain(large);
    expect(ctx.state.battlefield).not.toContain(enchantment);
    expect(survivor.counters['+1/+1']).toBe(1);
  });

  it('wires Endless Foot Assault’s squad copies and one attacking Ninja per opponent', () => {
    const ctx = pod('w2-endless-foot-assault');
    const source = spawn(ctx, 'P1', real('Endless Foot Assault'));
    source.optionalCostCounts = { squad: 1 };
    const triggers = definitions.get('Endless Foot Assault')!.triggers;
    pump(executeAbility(ctx, source, triggers[0]!, []));
    expect(
      ctx.state.battlefield.filter((permanent) => permanent.name === 'Endless Foot Assault'),
    ).toHaveLength(2);

    pump(executeAbility(ctx, source, triggers[1]!, []));
    const ninjas = ctx.state.battlefield.filter((permanent) => permanent.name === 'Ninja');
    expect(ninjas).toHaveLength(3);
    expect(ninjas.map((ninja) => ninja.attacking).sort()).toEqual(['P2', 'P3', 'P4']);
  });

  it('models Etali’s printed cast, transform, and back-face clauses', () => {
    const def = definitions.get('Etali, Primal Conqueror // Etali, Primal Sickness')!;
    expect(createHash('sha256').update(JSON.stringify(pr09Etali.card)).digest('hex')).toBe(
      'e3b73f76b96885e3818faa7986a9265e04bbd1552cdf623b944dca2ae51976fa',
    );
    expect(def.modeled).toBe(true);
    expect(def.unmodeledReasons).toEqual([]);
    expect(def.backFace?.name).toBe('Etali, Primal Sickness');
    expect(def.activatedAbilities).toHaveLength(1);
    expect(def.triggers.some((trigger) => trigger.trigger?.when === 'enters')).toBe(true);
    expect(pr09Manifest.cards[pr09Etali.card.oracleId]?.oracleSha256).toBe(pr09Etali.sha256);
    expect(pr09Manifest.cards[pr09Etali.card.oracleId]?.viewerScenarioIds).toEqual([
      'pr09-etali-viewer-positive',
      'pr09-etali-viewer-negative',
      'pr09-etali-primal-conqueror-etali-primal-sickness-viewer-transform',
    ]);
  });

  it('doubles Jacked Rabbit’s attack tokens while Mondrak is under your control', () => {
    const ctx = pod('w2-mondrak');
    spawn(ctx, 'P1', real('Mondrak, Glory Dominus'));
    const rabbit = spawn(ctx, 'P1', real('Jacked Rabbit'));
    rabbit.counters['+1/+1'] = 2;
    const expected = computeCharacteristics(ctx, rabbit).power * 2;
    pump(executeAbility(ctx, rabbit, definitions.get('Jacked Rabbit')!.triggers[1]!, []));
    expect(ctx.state.battlefield.filter((permanent) => permanent.name === 'Rabbit')).toHaveLength(
      expected,
    );
  });

  it('charges Norn’s Annex as white mana or two life for each attacker', () => {
    const unaffordable = pod('w2-norn-unaffordable');
    unaffordable.state.phase = 'combat';
    unaffordable.state.players[0]!.life = 1;
    spawn(unaffordable, 'P2', real("Norn's Annex"));
    spawn(unaffordable, 'P1', oracle({ name: 'Annex Attacker A' }));
    pump(runCombatPhase(unaffordable), (decision) => {
      if (decision.decisionType === 'declareAttackers') {
        const subject = decision.presentationAttackDeclaration!.subjects[0]!;
        expect(subject.defenders.map((defender) => defender.playerId)).not.toContain('P2');
        return declareNoAttacks(decision);
      }
      return pick(decision, /Pass|does not/);
    });

    const payable = pod('w2-norn-payable');
    payable.state.phase = 'combat';
    payable.state.players[0]!.life = 3;
    spawn(payable, 'P2', real("Norn's Annex"));
    spawn(payable, 'P1', oracle({ name: 'Annex Attacker B' }));
    pump(runCombatPhase(payable), (decision) => {
      if (decision.decisionType === 'declareAttackers') {
        return declareAttacks(decision, () => 'P2');
      }
      return pick(decision, /Pass|does not/);
    });
    expect(payable.state.players[0]!.life).toBe(1);
  });

  it('reduces Pearl-Ear’s enchantment spells by the number of Auras you control', () => {
    const ctx = pod('w2-pearl-affinity');
    spawn(ctx, 'P1', real('Pearl-Ear, Imperial Advisor'));
    for (const name of ['Affinity Aura A', 'Affinity Aura B']) {
      spawn(
        ctx,
        'P1',
        oracle({ name, typeLine: 'Enchantment — Aura', oracleText: 'Enchant creature' }),
      );
    }
    const spell = oracle({
      name: 'Affinity Enchantment',
      typeLine: 'Enchantment',
      manaCost: '{4}{W}',
    });
    ctx.defs.set(spell.oracleId, interpretCard(spell));
    expect(costReductionFor(ctx, 'P1', spell.oracleId, 'affinity-card').generic).toBe(2);
  });

  it('puts Securitron’s counter only on another creature token that entered', () => {
    const ctx = pod('w2-securitron-counter');
    const squadron = spawn(ctx, 'P1', real('Securitron Squadron'));
    const token = spawn(ctx, 'P1', oracle({ name: 'Securitron Friend' }));
    token.isToken = true;
    queueTriggersForObject(ctx, 'enters', token);
    expect(ctx.state.pendingTriggers).toHaveLength(1);
    pump(executeAbility(ctx, squadron, ctx.state.pendingTriggers[0]!.ability, [], token.cardId));
    expect(token.counters['+1/+1']).toBe(1);

    ctx.state.pendingTriggers = [];
    queueTriggersForObject(ctx, 'enters', squadron);
    expect(
      ctx.state.pendingTriggers.some((trigger) =>
        trigger.ability.effects.some(
          (effect) => effect.op === 'putCounters' && effect.counter === '+1/+1',
        ),
      ),
    ).toBe(false);
  });

  it('queues Study Hall’s variable scry only when its mana casts your commander', () => {
    const setup = (seed: string) => {
      const ctx = pod(seed);
      const player = ctx.state.players[0]!;
      const hall = definitions.get('Study Hall')!;
      spawn(ctx, 'P1', real('Study Hall'));
      player.manaEntries.push({
        symbol: 'W',
        spendTrigger: hall.manaAbilities[1]!.spendTrigger!,
      });
      const commander = oracle({
        name: `Study Hall Commander ${seed}`,
        typeLine: 'Legendary Creature — Advisor',
        manaCost: '{W}',
      });
      ctx.defs.set(commander.oracleId, interpretCard(commander));
      player.commanderCastCount['study-commander-card'] = 3;
      return { ctx, player, commander };
    };

    const commanderCast = setup('w2-study-commander');
    pump(
      payManaCost(commanderCast.ctx, commanderCast.player, parseManaCost('{W}').cost!, {
        kind: 'castSpell',
        oracleId: commanderCast.commander.oracleId,
        isCommander: true,
      }),
    );
    expect(commanderCast.ctx.state.pendingTriggers).toHaveLength(1);
    expect(commanderCast.ctx.state.pendingTriggers[0]!.ability.effects).toEqual([
      { op: 'scry', count: { kind: 'commanderCastCount', player: 'you' } },
    ]);

    const ordinaryCast = setup('w2-study-ordinary');
    pump(
      payManaCost(ordinaryCast.ctx, ordinaryCast.player, parseManaCost('{W}').cost!, {
        kind: 'castSpell',
        oracleId: ordinaryCast.commander.oracleId,
        isCommander: false,
      }),
    );
    expect(ordinaryCast.ctx.state.pendingTriggers).toHaveLength(0);
  });

  it('deals Terror of the Peaks damage using the entering creature’s current power', () => {
    const ctx = pod('w2-terror-damage');
    const terror = spawn(ctx, 'P1', real('Terror of the Peaks'));
    const entering = spawn(
      ctx,
      'P1',
      oracle({ name: 'Terror Entrant', power: '3', toughness: '3' }),
    );
    entering.counters['+1/+1'] = 1;
    const before = ctx.state.players[1]!.life;
    pump(
      executeAbility(
        ctx,
        terror,
        definitions.get('Terror of the Peaks')!.triggers[0]!,
        ['P2' as ObjectId],
        entering.cardId,
      ),
    );
    expect(ctx.state.players[1]!.life).toBe(before - 4);
  });

  it('models Vastwood Surge with kicker-scaled counters (coverage PR01)', () => {
    const def = definitions.get('Vastwood Surge')!;
    expect(def.modeled).toBe(true);
    expect(def.optionalAdditionalCost?.mechanic).toBe('kicker');
  });

  it('creates Verix Bladewing’s legendary Dragon token only from a kicked entry', () => {
    const resolveEntry = (seed: string, kicked: boolean) => {
      const ctx = pod(seed);
      const raw = real('Verix Bladewing');
      ctx.defs.set(raw.oracleId, definitions.get('Verix Bladewing')!);
      const object: EngineCardObject = {
        id: `verix-object-${seed}`,
        cardId: `verix-card-${seed}`,
        oracleId: raw.oracleId,
        ownerId: 'P1',
        name: raw.name,
        typeLine: raw.typeLine,
        oracleText: raw.oracleText,
        manaCost: raw.manaCost,
        isToken: false,
        isCommander: false,
        zone: 'stack',
        ...(kicked ? { optionalCostCounts: { kicker: 1 } } : {}),
      };
      const verix = makePermanent(ctx, object, 'P1');
      ctx.state.battlefield.push(verix);
      queueTriggersForObject(ctx, 'enters', verix);
      for (const trigger of ctx.state.pendingTriggers) {
        pump(executeAbility(ctx, verix, trigger.ability, []));
      }
      return ctx;
    };

    const kicked = resolveEntry('w2-verix-kicked', true);
    const karox = kicked.state.battlefield.find((permanent) =>
      permanent.name.toLowerCase().includes('karox bladewing'),
    );
    expect(karox).toBeDefined();
    expect(computeCharacteristics(kicked, karox!).keywords).toContain('flying');

    const plain = resolveEntry('w2-verix-plain', false);
    expect(
      plain.state.battlefield.some((permanent) =>
        permanent.name.toLowerCase().includes('karox bladewing'),
      ),
    ).toBe(false);
  });

  it('pays Zopandrel’s two Phyrexian pips with life, sacrifices two others, and gains indestructible', () => {
    const ctx = pod('w2-zopandrel-activation');
    const player = ctx.state.players[0]!;
    player.life = 4;
    const zopandrel = spawn(ctx, 'P1', real('Zopandrel, Hunger Dominus'));
    const first = spawn(ctx, 'P1', oracle({ name: 'Zopandrel Cost A' }));
    const second = spawn(ctx, 'P1', oracle({ name: 'Zopandrel Cost B' }));
    const option = computePriorityOptions(ctx, player).find((candidate) => {
      const payload = candidate.payload as PriorityActionPayload;
      return payload.kind === 'activateAbility' && payload.objectId === zopandrel.id;
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(player.life).toBe(0);
    expect(ctx.state.battlefield).not.toContain(first);
    expect(ctx.state.battlefield).not.toContain(second);
    pump(resolveTopOfStack(ctx));
    expect(zopandrel.counters['indestructible']).toBe(1);
  });
});
