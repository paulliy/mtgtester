import { describe, expect, it } from 'vitest';
import { parseManaCost, subtractColored, subtractGeneric } from '../src/mana/cost';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';

describe('Discrepancy Fixes & CR Compliance', () => {
  describe('Morophon, the Boundless — Colored Cost Reduction (CR 601.2f)', () => {
    it('subtracts colored mana symbols before generic mana', () => {
      const spellCost = parseManaCost('{2}{R}').cost!;
      const morophonReduction = parseManaCost('{W}{U}{B}{R}{G}').cost!;

      // Reduced by {R} colored symbol: {R} becomes 0, generic {2} remains 2.
      const coloredReduced = subtractColored(spellCost, morophonReduction);
      const finalCost = subtractGeneric(coloredReduced, 0);

      expect(finalCost.colored['R']).toBe(0);
      expect(finalCost.generic).toBe(2);
    });

    it('reduces WUBRG dragon spell to generic portion only', () => {
      const urDragonCost = parseManaCost('{4}{W}{U}{B}{R}{G}').cost!;
      const morophonReduction = parseManaCost('{W}{U}{B}{R}{G}').cost!;

      const coloredReduced = subtractColored(urDragonCost, morophonReduction);
      expect(coloredReduced.colored['W']).toBe(0);
      expect(coloredReduced.colored['U']).toBe(0);
      expect(coloredReduced.colored['B']).toBe(0);
      expect(coloredReduced.colored['R']).toBe(0);
      expect(coloredReduced.colored['G']).toBe(0);
      expect(coloredReduced.generic).toBe(4);
    });
  });

  describe("Lozhan, Dragons' Legacy — Non-Commander Target Filter", () => {
    it('attaches not(IS_COMMANDER) filter to target spec', () => {
      const raw = oracle({
        name: "Lozhan, Dragons' Legacy",
        manaCost: '{3}{U}{R}',
        typeLine: 'Legendary Creature — Dragon Shaman',
        types: ['Creature'],
        subtypes: ['Dragon', 'Shaman'],
        supertypes: ['Legendary'],
        oracleText:
          "Flying\nWhenever you cast an Adventure or Dragon spell, Lozhan, Dragons' Legacy deals damage equal to that spell's mana value to any target that isn't a commander.",
      });

      const def = interpretCard(raw);
      expect(def.triggers).toHaveLength(1);
      const target = def.triggers[0]?.targets[0];
      expect(target?.kind).toBe('anyTarget');
      expect(target?.filter).toEqual({ kind: 'not', of: { kind: 'isCommander' } });
    });
  });

  describe('Kairi, the Swirling Sky — Modal Death Trigger', () => {
    it('is catalog-contained because return-any-number is an untargeted bounce', () => {
      const raw = oracle({
        oracleId: '85aa53e8-f062-4d02-bc69-1413f7f0dcf1',
        name: 'Kairi, the Swirling Sky',
        manaCost: '{4}{U}{U}',
        typeLine: 'Legendary Creature — Dragon Spirit',
        types: ['Creature'],
        subtypes: ['Dragon', 'Spirit'],
        supertypes: ['Legendary'],
        oracleText:
          "Flying, ward {3}\nWhen Kairi, the Swirling Sky dies, choose one —\n• Return any number of target nonland permanents with total mana value 6 or less to their owners' hands.\n• Mill six cards, then return up to two instant and/or sorcery cards from your graveyard to your hand.",
      });

      const def = interpretCard(raw);
      expect(def.modeled).toBe(false);
      expect(def.unmodeledReasons.join('\n')).toContain(
        'Return-any-number targeting with total mana value 6 or less is an untargeted single bounce with no mana-value cap.',
      );
    });
  });

  describe('Firkraag, Cunning Instigator — Forced Combat Intervening-If', () => {
    it('is catalog-contained because the intervening-if checks Firkraag, not the damaging creature', () => {
      const raw = oracle({
        oracleId: '81dad7c5-5950-4c45-adb0-cf1a15a74250',
        name: 'Firkraag, Cunning Instigator',
        manaCost: '{1}{U}{R}',
        typeLine: 'Legendary Creature — Dragon Elemental',
        types: ['Creature'],
        subtypes: ['Dragon', 'Elemental'],
        supertypes: ['Legendary'],
        oracleText:
          'Flying, haste\nWhenever one or more Dragons you control attack an opponent, goad target creature that player controls.\nWhenever a creature deals combat damage to one of your opponents, if that creature had to attack this combat, you put a +1/+1 counter on Firkraag and you draw a card.',
      });

      const def = interpretCard(raw);
      expect(def.modeled).toBe(false);
      expect(def.unmodeledReasons.join('\n')).toContain(
        'The intervening-if checks whether Firkraag had to attack, not the creature that dealt damage.',
      );
    });
  });
});
