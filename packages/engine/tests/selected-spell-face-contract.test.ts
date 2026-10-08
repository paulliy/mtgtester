import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OracleCard } from '@mtg/shared';
import { describe, expect, it } from 'vitest';
import { applyPriorityAction } from '../src/actions/apply';
import { computePriorityOptions, type PriorityActionPayload } from '../src/actions/legal';
import { interpretCard } from '../src/cards/interpret';
import { assertValidModeledDefinition } from '../src/cards/authoring-validation';
import { addMana } from '../src/mana/pool';
import { createGame } from '../src/state/game';
import { computeCharacteristics } from '../src/effects/continuous';
import { spellDefinitionOf } from '../src/state/queries';
import { resolveTopOfStack } from '../src/stack/stack';
import { isCreatureSpell, spellMatchesSelector } from '../src/targets/legality';
import { buildPlayerView } from '../src/view/view';
import { buildSpectatorState } from '../src/view/spectator';
import { bear, conjure, copies, forest, gameConfig, oracle, pump, spawn } from './fixtures';
import { cloneContractContext } from './helpers/contract-harness';

const pinned = JSON.parse(
  readFileSync(new URL('./fixtures/selected-spell-faces-oracle.json', import.meta.url), 'utf8'),
) as {
  cards: { sha256: string; card: OracleCard }[];
};

// Independent Oracle expectations; never infer success or support from the interpreted IR.
const faceCases = [
  { name: 'Faerie Guidemother', pt: [4, 3], keyword: 'flying' },
  { name: 'Tuinvale Treefolk', counters: 2 },
  { name: 'Two-Headed Hunter', keyword: 'double strike' },
  { name: 'Foulmire Knight', draw: 1, life: 39 },
  {
    name: 'An Unexpected Party',
    tokens: 1,
    tokenType: 'Dwarf',
    tokenPt: [2, 2],
    tokenColor: 'R',
    x: 1,
  },
  { name: "Obyra's Attendants", pt: [-2, 2] },
  { name: 'Garenbrig Carver', pt: [4, 4] },
  {
    name: 'Lindblum, Industrial Regency',
    tokens: 1,
    tokenType: 'Wizard',
    tokenPt: [0, 1],
    tokenColor: 'B',
  },
  { name: 'Tempest Hart', draw: 2, discard: 2 },
  {
    name: "Imodane's Recruiter",
    tokens: 2,
    tokenType: 'Knight',
    tokenPt: [2, 2],
    tokenColor: 'W',
    tokenKeyword: 'vigilance',
  },
  { name: 'Embereth Shieldbreaker', destroyArtifact: true },
  { name: 'Glóin the Mighty', damage: 1, opponentsOnly: true },
  { name: 'Shepherd of the Flock', bounce: true },
  { name: 'Sagu Wildling', search: true, omen: true },
  { name: 'Silverflame Squire', pt: [4, 4], untap: true },
  { name: 'Oakhame Ranger', tokens: 2, tokenType: 'Human', tokenPt: [1, 1], tokenColor: 'W' },
  { name: 'Realm-Cloaked Giant', destroyNonGiants: true },
  { name: 'Frolicking Familiar', damage: 1 },
  {
    name: 'Lonesome Unicorn',
    tokens: 1,
    tokenType: 'Knight',
    tokenPt: [2, 2],
    tokenColor: 'W',
    tokenKeyword: 'vigilance',
  },
  { name: 'Topaz Dragon', ownKeyword: 'deathtouch' },
  {
    name: 'Horn of Valhalla',
    tokens: 1,
    tokenType: 'Soldier',
    tokenPt: [1, 1],
    tokenColor: 'W',
    x: 1,
  },
  { name: 'Minecart Daredevil', pt: [4, 3] },
  { name: 'Curious Pair', tokens: 1, tokenType: 'Food' },
  { name: 'Gingerbread Hunter', pt: [0, 0] },
  { name: 'Bilbo Baggins, Burglar', scry: 2 },
  { name: 'Smaug, the Great Calamity', damage: 5 },
  { name: 'Young Blue Dragon', scry: 1, draw: 1 },
] as const;
interface FaceExpectation {
  name: string;
  pt?: readonly number[];
  keyword?: string;
  counters?: number;
  draw?: number;
  discard?: number;
  life?: number;
  tokens?: number;
  tokenType?: string;
  tokenPt?: readonly number[];
  tokenColor?: string;
  tokenKeyword?: string;
  x?: number;
  destroyArtifact?: boolean;
  damage?: number;
  opponentsOnly?: boolean;
  bounce?: boolean;
  search?: boolean;
  omen?: boolean;
  untap?: boolean;
  destroyNonGiants?: boolean;
  ownKeyword?: string;
  scry?: number;
}

function plentifulMana(player: ReturnType<typeof setup>['player']) {
  for (const symbol of ['W', 'U', 'B', 'R', 'G', 'C'] as const)
    addMana(
      player,
      Array.from({ length: 12 }, () => ({ symbol })),
    );
}

function setup(input?: OracleCard, printedFaceCost = '{0}') {
  const ctx = createGame(
    gameConfig([{ cards: copies(10, forest) }, { cards: copies(10, forest) }]),
  );
  const player = ctx.state.players[0]!;
  ctx.state.currentTurnPlayer = player.id;
  ctx.state.phase = 'precombatMain';
  ctx.state.turnNumber = 3;
  const card = conjure(
    ctx,
    player.id,
    input ??
      oracle({
        name: 'Face contract dragon',
        typeLine: 'Creature — Dragon',
        manaCost: '{8}{G}',
        colors: ['G'],
        oracleText: 'Flying',
        power: '5',
        toughness: '5',
      }),
    'hand',
  );
  if (!input) {
    const face = interpretCard(
      oracle({
        name: 'Red face contract',
        typeLine: 'Instant — Adventure',
        manaCost: printedFaceCost,
        colors: ['R'],
        oracleText: 'Red face contract deals 2 damage to target creature.',
      }),
    );
    expect(face.modeled).toBe(true);
    ctx.defs.set(card.oracleId, {
      ...ctx.defs.get(card.oracleId)!,
      alternativeCasts: [
        {
          kind: 'adventure',
          manaCost: face.manaCost!,
          description: face.name,
          name: face.name,
          typeLine: face.typeLine,
          ability: face.spellAbility!,
          spellFace: face,
        },
      ],
    });
  }
  const options = () =>
    computePriorityOptions(ctx, player).filter((option) => {
      const payload = option.payload as PriorityActionPayload;
      return (
        payload.kind === 'castSpell' &&
        payload.objectId === card.id &&
        payload.alternativeCast !== undefined
      );
    });
  const cast = (targets = new Map<number, string>()) => {
    const option = options()[0];
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(ctx, player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets,
      }),
    );
    return ctx.state.stack.at(-1)!;
  };
  return { ctx, player, card, options, cast };
}

describe('independent selected spell face contracts', () => {
  it('face-pronoun-scope rejects an unbound spell pronoun instead of untapping its source', () => {
    expect(
      interpretCard(
        oracle({
          name: 'Unbound untap',
          typeLine: 'Instant',
          manaCost: '{U}',
          oracleText: 'Untap it.',
        }),
      ).modeled,
    ).toBe(false);
    expect(
      interpretCard(
        oracle({
          name: 'Unknown untap subject',
          typeLine: 'Instant',
          manaCost: '{U}',
          oracleText: 'Draw a card. Untap it.',
        }),
      ).modeled,
    ).toBe(false);
  });
  it.each(pinned.cards)('pins both canonical Oracle halves: $card.name', ({ sha256, card }) => {
    expect(createHash('sha256').update(JSON.stringify(card)).digest('hex')).toBe(sha256);
    expect(card.backFace?.oracleText).toBeTruthy();
  });

  it('face-stack-characteristics uses selected types, colors, mana value and public name', () => {
    const state = setup(undefined, '{2}{R}');
    addMana(state.player, [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'R' }]);
    const target = spawn(state.ctx, 'P2', bear());
    const entry = state.cast(new Map([[0, target.id]]));
    expect(isCreatureSpell(state.ctx, entry)).toBe(false);
    expect(spellMatchesSelector(state.ctx, entry, { kind: 'type', value: 'Instant' }, 'P2')).toBe(
      true,
    );
    expect(spellMatchesSelector(state.ctx, entry, { kind: 'subtype', value: 'Dragon' }, 'P2')).toBe(
      false,
    );
    expect(spellMatchesSelector(state.ctx, entry, { kind: 'color', value: 'R' }, 'P2')).toBe(true);
    expect(
      spellMatchesSelector(
        state.ctx,
        entry,
        {
          kind: 'allOf',
          of: [
            { kind: 'manaValueAtMost', n: 3 },
            { kind: 'manaValueAtLeast', n: 3 },
          ],
        },
        'P2',
      ),
    ).toBe(true);
    expect(spellDefinitionOf(state.ctx, entry).keywords).not.toContain('flying');
    expect(buildPlayerView(state.ctx, 'P1').stack[0]?.description).toBe('Red face contract');
    expect(buildSpectatorState(state.ctx).stack[0]?.description).toBe('Red face contract');
    expect(entry.card?.name).toBe('Face contract dragon');
  });

  it('face-protection uses selected colors at announcement and resolution', () => {
    const state = setup();
    const target = spawn(state.ctx, 'P2', bear());
    const def = state.ctx.defs.get(target.oracleId)!;
    state.ctx.defs.set(target.oracleId, { ...def, protectionFrom: ['G'] });
    expect(state.options()[0]?.targets?.[0]?.options).toContain(target.id);
    state.ctx.defs.set(target.oracleId, { ...def, protectionFrom: ['R'] });
    expect(state.options()).toEqual([]);
    state.ctx.defs.set(target.oracleId, def);
    state.cast(new Map([[0, target.id]]));
    const responder = state.ctx.state.players[1]!;
    const protection = conjure(
      state.ctx,
      responder.id,
      oracle({
        name: 'Protection response',
        typeLine: 'Instant',
        manaCost: '{0}',
        oracleText: 'You gain 1 life.',
      }),
      'hand',
    );
    state.ctx.defs.set(protection.oracleId, {
      ...state.ctx.defs.get(protection.oracleId)!,
      spellAbility: {
        kind: 'spell',
        targets: [],
        effects: [
          {
            op: 'grantProtectionEachUntilEot',
            selector: { kind: 'controller', who: 'you' },
            colors: ['R'],
          },
        ],
      },
    });
    const response = computePriorityOptions(state.ctx, responder).find(
      (option) => (option.payload as { objectId?: string }).objectId === protection.id,
    )!;
    pump(
      applyPriorityAction(state.ctx, responder, response.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    pump(resolveTopOfStack(state.ctx));
    pump(resolveTopOfStack(state.ctx));
    expect(target.damageMarked).toBe(0);
    expect(state.player.graveyard.some((card) => card.cardId === state.card.cardId)).toBe(true);
    expect(state.ctx.state.exile).toEqual([]);
  });

  it('face-restricted-mana cannot spend creature-only mana on the spell half', () => {
    const state = setup(undefined, '{1}');
    spawn(state.ctx, 'P2', bear());
    addMana(state.player, [
      {
        symbol: 'C',
        restriction: {
          description: 'Creature spells only',
          purposes: ['castSpell'],
          filter: { kind: 'type', value: 'Creature' },
        },
      },
    ]);
    expect(state.options()).toEqual([]);
    state.player.manaEntries[0]!.restriction!.filter = { kind: 'type', value: 'Instant' };
    const target = state.ctx.state.battlefield[0]!;
    state.cast(new Map([[0, target.id]]));
    expect(state.player.manaEntries).toEqual([]);
  });

  it('face-reduction matches the selected face rather than the front Dragon', () => {
    const state = setup(undefined, '{2}');
    const target = spawn(state.ctx, 'P2', bear());
    const reducer = spawn(state.ctx, 'P1', oracle({ name: 'Face reducer', typeLine: 'Artifact' }));
    const def = state.ctx.defs.get(reducer.oracleId)!;
    const reduction = { kind: 'costReduction' as const, amount: { kind: 'const' as const, n: 1 } };
    state.ctx.defs.set(reducer.oracleId, {
      ...def,
      ruleStatics: [{ ...reduction, filter: { kind: 'subtype', value: 'Dragon' } }],
    });
    addMana(state.player, [{ symbol: 'C' }]);
    expect(state.options()).toEqual([]);
    state.ctx.defs.set(reducer.oracleId, {
      ...def,
      ruleStatics: [{ ...reduction, filter: { kind: 'type', value: 'Instant' } }],
    });
    state.cast(new Map([[0, target.id]]));
    expect(state.player.manaEntries).toEqual([]);
  });

  it('face-cast-triggers count a noncreature spell and capture its own mana value', () => {
    const state = setup(undefined, '{1}');
    addMana(state.player, [{ symbol: 'C' }]);
    const target = spawn(state.ctx, 'P2', bear());
    const watcher = spawn(state.ctx, 'P1', oracle({ name: 'Face watcher', typeLine: 'Artifact' }));
    state.ctx.defs.set(watcher.oracleId, {
      ...state.ctx.defs.get(watcher.oracleId)!,
      triggers: [
        {
          kind: 'triggered',
          targets: [],
          effects: [{ op: 'gainLife', amount: { kind: 'const', n: 1 } }],
          trigger: {
            when: 'castsSpell',
            caster: 'you',
            filter: { kind: 'type', value: 'Instant' },
          },
        },
      ],
    });
    state.cast(new Map([[0, target.id]]));
    expect(state.player.noncreatureSpellsCastThisTurn).toBe(1);
    expect(
      state.ctx.state.pendingTriggers
        .filter((trigger) => trigger.sourceCardId === watcher.cardId)
        .map((trigger) => trigger.scope?.spellManaValue),
    ).toEqual([1]);
  });

  it('face-front-costs does not inherit front life costs, kicker, or Cascade', () => {
    const state = setup();
    const target = spawn(state.ctx, 'P2', bear());
    state.ctx.defs.set(state.card.oracleId, {
      ...state.ctx.defs.get(state.card.oracleId)!,
      spellAdditionalCosts: [{ kind: 'payLife', amount: 30 }],
      keywords: ['cascade'],
      optionalAdditionalCost: {
        mechanic: 'kicker',
        cost: { generic: 1, colorless: 0, colored: { W: 0, U: 0, B: 0, R: 0, G: 0 } },
      },
    });
    expect(state.options()).toHaveLength(1);
    state.cast(new Map([[0, target.id]]));
    expect(state.player.life).toBe(40);
    expect(state.ctx.state.pendingTriggers).toEqual([]);
  });

  it('face-invalid-descriptor fails authoring and direct casting without mutation', () => {
    const state = setup();
    const definition = state.ctx.defs.get(state.card.oracleId)!;
    const alternative = { ...definition.alternativeCasts![0]! };
    delete alternative.spellFace;
    const invalid = { ...definition, alternativeCasts: [alternative] };
    expect(() => assertValidModeledDefinition(invalid)).toThrow('spell face');
    state.ctx.defs.set(state.card.oracleId, invalid);
    const before = cloneContractContext(state.ctx);
    expect(() =>
      pump(
        applyPriorityAction(
          state.ctx,
          state.player,
          {
            kind: 'castSpell',
            objectId: state.card.id,
            fromCommand: false,
            alternativeCast: 'adventure',
          },
          { index: 0, targets: new Map() },
        ),
      ),
    ).toThrow('spell face');
    expect(state.ctx.state).toEqual(before.state);
  });

  it.each([
    { name: 'different public name', fields: { name: 'Wrong face' } },
    { name: 'different type line', fields: { typeLine: 'Sorcery — Adventure' } },
    { name: 'different spell subtype', fields: { kind: 'omen' as const } },
    {
      name: 'different executable ability',
      fields: { ability: { kind: 'spell' as const, targets: [], effects: [] } },
    },
    { name: 'ignored nonmana cost', fields: { costs: [{ kind: 'payLife' as const, amount: 1 }] } },
    { name: 'incorrect exile replacement', fields: { exileOnResolution: true } },
    { name: 'incorrect escape marker', fields: { escaped: true as const } },
  ])('face-inconsistent-fields rejects $name before casting', ({ fields }) => {
    const state = setup();
    const definition = state.ctx.defs.get(state.card.oracleId)!;
    const invalid = {
      ...definition,
      alternativeCasts: [{ ...definition.alternativeCasts![0]!, ...fields }],
    };
    expect(() => assertValidModeledDefinition(invalid)).toThrow('spell face');
    state.ctx.defs.set(state.card.oracleId, invalid);
    const before = cloneContractContext(state.ctx);
    expect(() => state.options()).toThrow('spell face');
    expect(state.ctx.state).toEqual(before.state);
  });

  it.each(['copyTargetSpell', 'copyEachTargetedSpell'] as const)(
    'face-copy %s retains original spell characteristics after a differently colored spell copies it',
    (op) => {
      const state = setup();
      const target = spawn(
        state.ctx,
        'P2',
        oracle({
          name: 'Copy target',
          typeLine: 'Creature',
          manaCost: '{3}',
          power: '3',
          toughness: '5',
        }),
      );
      const original = state.cast(new Map([[0, target.id]]));
      const copyingCard = conjure(
        state.ctx,
        'P1',
        oracle({
          name: 'Green copier',
          typeLine: 'Instant',
          manaCost: '{0}',
          colors: ['G'],
          oracleText: 'You gain 1 life.',
        }),
        'hand',
      );
      state.ctx.defs.set(copyingCard.oracleId, {
        ...state.ctx.defs.get(copyingCard.oracleId)!,
        spellAbility: {
          kind: 'spell',
          targets: [
            {
              kind: 'spell',
              ...(op === 'copyEachTargetedSpell' ? { count: { min: 1, max: 1 } } : {}),
            },
          ],
          effects: [op === 'copyEachTargetedSpell' ? { op, targetSlot: 0 } : { op, target: 0 }],
        },
      });
      const option = computePriorityOptions(state.ctx, state.player).find(
        (option) => (option.payload as { objectId?: string }).objectId === copyingCard.id,
      )!;
      pump(
        applyPriorityAction(state.ctx, state.player, option.payload as PriorityActionPayload, {
          index: 0,
          targets: op === 'copyEachTargetedSpell' ? new Map() : new Map([[0, original.id]]),
        }),
      );
      pump(resolveTopOfStack(state.ctx));
      const copy = state.ctx.state.stack.at(-1)!;
      expect(copy.card).toBeNull();
      expect(copy.sourceCardId).toBe(copy.id);
      expect(copy.sourceOracleId).toBe(original.sourceOracleId);
      expect(copy.sourceColors).toEqual(['R']);
      expect(copy.isCommanderCast).toBe(false);
      expect(isCreatureSpell(state.ctx, copy)).toBe(false);
      expect(spellDefinitionOf(state.ctx, copy).colors).toEqual(['R']);
      expect(
        spellMatchesSelector(state.ctx, copy, { kind: 'subtype', value: 'Adventure' }, 'P2'),
      ).toBe(true);
      state.ctx.defs.set(target.oracleId, {
        ...state.ctx.defs.get(target.oracleId)!,
        protectionFrom: ['G'],
      });
      pump(resolveTopOfStack(state.ctx));
      expect(target.damageMarked).toBe(2);
      expect(state.ctx.state.stack).toEqual([original]);
    },
  );

  it('profane-insight-normal-cast resolves its draw and life loss, then permits the front from exile', () => {
    const input = pinned.cards.find((row) => row.card.name.startsWith('Foulmire Knight'))!.card;
    const state = setup(input);
    addMana(state.player, [{ symbol: 'C' }, { symbol: 'C' }, { symbol: 'B' }]);
    const beforeHand = state.player.hand.length;
    const entry = state.cast();
    expect(entry.description).toBe('Profane Insight');
    pump(resolveTopOfStack(state.ctx));
    expect(state.player.life).toBe(39);
    expect(state.player.hand).toHaveLength(beforeHand);
    expect(state.ctx.state.exile[0]?.onAdventure).toBe(true);
    expect(state.ctx.state.exile[0]?.name).toBe(input.name);
    addMana(state.player, [{ symbol: 'B' }]);
    const front = computePriorityOptions(state.ctx, state.player).find(
      (option) => (option.payload as { fromExile?: boolean }).fromExile,
    )!;
    pump(
      applyPriorityAction(state.ctx, state.player, front.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    expect(isCreatureSpell(state.ctx, state.ctx.state.stack.at(-1)!)).toBe(true);
    pump(resolveTopOfStack(state.ctx));
    expect(
      state.ctx.state.battlefield.some((permanent) => permanent.cardId === state.card.cardId),
    ).toBe(true);
  });

  it('roost-seek-normal-cast is an Omen under the adventure layout and shuffles itself into the library', () => {
    const input = pinned.cards.find((row) => row.card.name.startsWith('Sagu Wildling'))!.card;
    const state = setup(input);
    const cost = state.ctx.defs.get(state.card.oracleId)!.alternativeCasts![0]!.manaCost;
    addMana(state.player, [
      ...Array.from({ length: cost.generic }, () => ({ symbol: 'C' as const })),
      { symbol: 'G' },
    ]);
    const entry = state.cast();
    expect(entry.alternativeCastKind).toBe('omen');
    pump(resolveTopOfStack(state.ctx));
    expect(state.player.library.some((card) => card.cardId === state.card.cardId)).toBe(true);
    expect(state.ctx.state.exile.some((card) => card.cardId === state.card.cardId)).toBe(false);
    expect(state.player.graveyard.some((card) => card.cardId === state.card.cardId)).toBe(false);
  });

  it.each(faceCases)(
    'face-canonical-normal-path executes the declared spell clause for $name',
    (expected: FaceExpectation) => {
      const input = pinned.cards.find((row) => row.card.name.startsWith(expected.name))!.card;
      const state = setup(input);
      const own = spawn(state.ctx, 'P1', bear());
      const opponent = spawn(state.ctx, 'P2', bear());
      const artifact = spawn(
        state.ctx,
        'P2',
        oracle({ name: 'Face artifact target', typeLine: 'Artifact', manaCost: '{2}' }),
      );
      const giant = spawn(
        state.ctx,
        'P1',
        oracle({
          name: 'Face Giant witness',
          typeLine: 'Creature — Giant',
          manaCost: '{3}',
          power: '3',
          toughness: '3',
        }),
      );
      if (expected.untap) opponent.tapped = true;
      plentifulMana(state.player);
      const handBefore = state.player.hand.length;
      const libraryBefore = state.player.library.length;
      const option = state
        .options()
        .find((option) => ((option.payload as { x?: number }).x ?? 0) === (expected.x ?? 0));
      expect(option, input.name).toBeDefined();
      const targets = new Map(
        (option!.targets ?? []).map((slot) => {
          const preferred = expected.bounce
            ? own.id
            : expected.destroyArtifact
              ? artifact.id
              : opponent.id;
          expect(slot.options).toContain(preferred);
          return [slot.slot, preferred];
        }),
      );
      pump(
        applyPriorityAction(state.ctx, state.player, option!.payload as PriorityActionPayload, {
          index: 0,
          targets,
        }),
      );
      pump(resolveTopOfStack(state.ctx));
      expect(state.ctx.state.stack).toEqual([]);
      if (expected.omen) {
        expect(state.player.library.some((card) => card.cardId === state.card.cardId)).toBe(true);
        expect(state.ctx.state.exile.some((card) => card.cardId === state.card.cardId)).toBe(false);
      } else {
        expect(
          state.ctx.state.exile.find((card) => card.cardId === state.card.cardId)?.onAdventure,
        ).toBe(true);
        expect(state.player.library.some((card) => card.cardId === state.card.cardId)).toBe(false);
      }
      if (expected.pt) {
        const chars = computeCharacteristics(state.ctx, opponent);
        expect([chars.power, chars.toughness]).toEqual(expected.pt);
      }
      if (expected.keyword)
        expect(computeCharacteristics(state.ctx, opponent).keywords).toContain(expected.keyword);
      if (expected.counters !== undefined)
        expect(opponent.counters['+1/+1']).toBe(expected.counters);
      if (expected.damage !== undefined) expect(opponent.damageMarked).toBe(expected.damage);
      if (expected.opponentsOnly) expect(own.damageMarked).toBe(0);
      if (expected.untap) expect(opponent.tapped).toBe(false);
      if (expected.life !== undefined) expect(state.player.life).toBe(expected.life);
      if (expected.draw !== undefined) {
        expect(state.player.library).toHaveLength(libraryBefore - expected.draw);
        expect(state.player.hand).toHaveLength(
          handBefore - 1 + expected.draw - (expected.discard ?? 0),
        );
      }
      if (expected.discard !== undefined)
        expect(state.player.graveyard).toHaveLength(expected.discard);
      if (expected.search) expect(state.player.hand).toHaveLength(handBefore);
      if (expected.bounce) {
        expect(state.player.hand.some((card) => card.cardId === own.cardId)).toBe(true);
        expect(state.ctx.state.battlefield.some((permanent) => permanent.id === own.id)).toBe(
          false,
        );
      }
      if (expected.destroyArtifact)
        expect(
          state.ctx.state.players[1]!.graveyard.some((card) => card.cardId === artifact.cardId),
        ).toBe(true);
      if (expected.destroyNonGiants) {
        expect(state.player.graveyard.some((card) => card.cardId === own.cardId)).toBe(true);
        expect(
          state.ctx.state.players[1]!.graveyard.some((card) => card.cardId === opponent.cardId),
        ).toBe(true);
        expect(state.ctx.state.battlefield.some((permanent) => permanent.id === giant.id)).toBe(
          true,
        );
      }
      if (expected.ownKeyword) {
        expect(computeCharacteristics(state.ctx, own).keywords).toContain(expected.ownKeyword);
        expect(computeCharacteristics(state.ctx, opponent).keywords).not.toContain(
          expected.ownKeyword,
        );
      }
      if (expected.tokens !== undefined) {
        const tokens = state.ctx.state.battlefield.filter((permanent) => permanent.isToken);
        expect(tokens).toHaveLength(expected.tokens);
        for (const token of tokens) {
          const chars = computeCharacteristics(state.ctx, token);
          expect(token.controllerId).toBe('P1');
          expect(chars.subtypes).toContain(expected.tokenType);
          if (expected.tokenPt) expect([chars.power, chars.toughness]).toEqual(expected.tokenPt);
          if (expected.tokenColor) expect(chars.colors).toEqual([expected.tokenColor]);
          if (expected.tokenKeyword) expect(chars.keywords).toContain(expected.tokenKeyword);
        }
      }
      if (expected.scry !== undefined)
        expect(
          state.ctx.state.eventLog.find((event) => event.type === 'scry')?.payload['looked'],
        ).toBe(expected.scry);
    },
  );

  it.each(faceCases)('face-canonical-front-path casts the ordinary front of $name', ({ name }) => {
    const input = pinned.cards.find((row) => row.card.name.startsWith(name))!.card;
    const state = setup(input);
    plentifulMana(state.player);
    const kind = input.types.includes('Land') ? 'playLand' : 'castSpell';
    const option = computePriorityOptions(state.ctx, state.player).find((option) => {
      const payload = option.payload as {
        kind: string;
        objectId?: string;
        alternativeCast?: string;
      };
      return (
        payload.kind === kind &&
        payload.objectId === state.card.id &&
        payload.alternativeCast === undefined
      );
    });
    expect(option).toBeDefined();
    pump(
      applyPriorityAction(state.ctx, state.player, option!.payload as PriorityActionPayload, {
        index: 0,
        targets: new Map(),
      }),
    );
    if (kind === 'castSpell') pump(resolveTopOfStack(state.ctx));
    const permanent = state.ctx.state.battlefield.find(
      (permanent) => permanent.cardId === state.card.cardId,
    )!;
    expect(permanent).toBeDefined();
    const chars = computeCharacteristics(state.ctx, permanent);
    expect(chars.types).toEqual(input.types);
    expect(chars.colors).toEqual(input.colors);
    if (input.power !== null && /^\d+$/.test(input.power))
      expect(chars.power).toBe(Number(input.power));
    if (input.toughness !== null && /^\d+$/.test(input.toughness))
      expect(chars.toughness).toBe(Number(input.toughness));
  });

  it.each(faceCases)(
    'face-canonical-no-mana rejects an unpaid spell half for $name',
    ({ name }) => {
      const input = pinned.cards.find((row) => row.card.name.startsWith(name))!.card;
      const state = setup(input);
      spawn(state.ctx, 'P1', bear());
      spawn(state.ctx, 'P2', bear());
      spawn(state.ctx, 'P2', oracle({ name: 'Unpaid artifact target', typeLine: 'Artifact' }));
      const before = cloneContractContext(state.ctx);
      expect(state.options()).toEqual([]);
      const alternativeCast = input.backFace!.typeLine.includes('Omen') ? 'omen' : 'adventure';
      expect(() =>
        pump(
          applyPriorityAction(
            state.ctx,
            state.player,
            { kind: 'castSpell', objectId: state.card.id, fromCommand: false, alternativeCast },
            { index: 0, targets: new Map() },
          ),
        ),
      ).toThrow();
      expect(state.ctx.state).toEqual(before.state);
      expect(state.ctx.debugLog).toEqual(before.debugLog);
      expect(state.ctx.rng.nextUint32()).toBe(before.rng.nextUint32());
    },
  );

  it.each(
    pinned.cards.filter(
      (row) => !faceCases.some((expected) => row.card.name.startsWith(expected.name)),
    ),
  )('face-unparsed-clause-contained rejects the normal path for $card.name', ({ card: input }) => {
    const definition = interpretCard(input);
    expect(definition.modeled).toBe(false);
    expect(definition.unmodeledReasons.join('; ')).toContain(input.backFace!.name);
    const state = setup(input);
    expect(() => state.options()).toThrow('Unmodeled card');
  });
});

it('face-commander-tax offers and casts Easy Pickings from the command zone with tax', () => {
  const input = pinned.cards.find(({ card }) => card.name.startsWith('Glóin the Mighty'))!.card;
  const state = setup(input);
  state.player.hand.splice(state.player.hand.indexOf(state.card), 1);
  state.card.zone = 'command';
  state.card.isCommander = true;
  state.player.commandZone.push(state.card);
  state.player.commanderCardIds.push(state.card.cardId);
  state.player.commanderCastCount[state.card.cardId] = 2;
  const own = spawn(state.ctx, 'P1', bear());
  const other = spawn(state.ctx, 'P2', bear());
  addMana(state.player, [
    ...Array.from({ length: 5 }, () => ({ symbol: 'C' as const })),
    { symbol: 'R' },
  ]);
  expect(state.options()).toEqual([]);
  addMana(state.player, [{ symbol: 'C' }]);
  const entry = state.cast();
  expect(entry.description).toBe('Easy Pickings');
  expect(entry.isCommanderCast).toBe(true);
  expect(entry.triggerScope?.manaSpent).toBe(7);
  expect(state.player.commanderCastCount[state.card.cardId]).toBe(3);
  pump(resolveTopOfStack(state.ctx));
  expect(other.damageMarked).toBe(1);
  expect(own.damageMarked).toBe(0);
});
