/**
 * `interpretCard`'s generic "create a token" grammar (`parseTokenFace` in `interpret.ts`) builds a
 * `TokenSpec` from the printed phrase, with no way to know which named `tokens.ts` const it
 * matches. `canonicalizeToken` closes that gap: when the parsed shape is structurally identical to
 * a cataloged token, the parser's own output IS that catalog object, not a separately-built copy
 * that only happens to match today (the failure mode `tokens.ts`'s doc comment and ADR 0025
 * describe — a Soldier or a Treasure spelled two ways that drift apart under maintenance).
 */

import { describe, expect, it } from 'vitest';
import { interpretCard } from '../src/cards/interpret';
import { oracle } from './fixtures';
import { BEAST_3_3_GREEN, ELEPHANT_3_3_GREEN, HUMAN_1_1_WHITE, SOLDIER_1_1_LIFELINK } from '../src/cards/tokens';

function tokenSpecOf(text: string) {
  const def = interpretCard(
    oracle({
      name: 'Test Token Maker',
      typeLine: 'Creature — Human',
      manaCost: '{1}{W}',
      oracleText: text,
    }),
  );
  const effect = def.triggers[0]?.effects.find((e) => e.op === 'createToken');
  return effect !== undefined && effect.op === 'createToken' ? effect.spec : undefined;
}

describe('parseTokenFace canonicalizes against the shared token catalog', () => {
  it('a parsed token identical to a catalog entry IS that catalog object, not a copy', () => {
    const spec = tokenSpecOf('When this creature enters, create a 1/1 white Human creature token.');
    expect(spec).toBe(HUMAN_1_1_WHITE);
  });

  it('holds for a token with a color and a different subtype too', () => {
    const spec = tokenSpecOf('When this creature enters, create a 3/3 green Elephant creature token.');
    expect(spec).toBe(ELEPHANT_3_3_GREEN);
  });

  it('a token with no catalog match still parses correctly, just not canonicalized to anything', () => {
    // No cataloged token is a 2/2 red Goblin, so this proves a miss is harmless rather than
    // dropping the card or substituting the wrong token.
    const spec = tokenSpecOf('When this creature enters, create a 2/2 red Goblin creature token.');
    expect(spec).not.toBeUndefined();
    expect(spec).toMatchObject({ subtypes: ['Goblin'], colors: ['R'], power: 2, toughness: 2 });
    expect(spec).not.toBe(HUMAN_1_1_WHITE);
  });

  it('a keyword-bearing token is canonicalized only after the keyword is folded in', () => {
    // The base spec (before "with lifelink" is merged in) doesn't match SOLDIER_1_1_LIFELINK on
    // its own — only the full spec, keywords included, does. Proves canonicalization runs on the
    // assembled token, not just the bare parse.
    const spec = tokenSpecOf(
      'When this creature enters, create a 1/1 white Soldier creature token with lifelink.',
    );
    expect(spec).toBe(SOLDIER_1_1_LIFELINK);
  });

  it('naming a canonicalized token does not mutate the shared catalog object', () => {
    // `parseTokenFace` can return `HUMAN_1_1_WHITE` itself (the first test above). A card that
    // names its created token ("create Test Named, a 1/1 white Human creature token") used to set
    // `.name`/`.legendary` directly on whatever `parseTokenFace` returned — which, on a catalog
    // hit, IS the shared exported const. That silently corrupted `HUMAN_1_1_WHITE` for every other
    // card creating a plain 1/1 white Human token afterward in this process. Must clone instead.
    const spec = tokenSpecOf(
      'When this creature enters, create Test Named, a 1/1 white Human creature token.',
    );

    expect(spec).toMatchObject({ name: 'test named', legendary: true });
    expect(spec).not.toBe(HUMAN_1_1_WHITE);
    expect(HUMAN_1_1_WHITE.name).toBe('Human');
    expect(HUMAN_1_1_WHITE.legendary).toBeUndefined();
  });

  it('the destroy-and-create-token grammar canonicalizes too, not just plain "create a token"', () => {
    // Beast Within's override was removed (`draconic-destruction.ts`) once this held: it hardcoded
    // exactly this token to work around a typeLine mismatch that `parseTokenFace`'s canonicalization
    // now fixes on its own, from a DIFFERENT parser (`parseDestroyAndCreateTokenBlock`) than the one
    // the other tests in this file exercise. Removing that override depends on this staying true.
    const def = interpretCard(
      oracle({
        name: 'Test Destroy And Create',
        typeLine: 'Instant',
        manaCost: '{2}{G}',
        oracleText: "Destroy target permanent. Its controller creates a 3/3 green Beast creature token.",
      }),
    );
    expect(def.modeled).toBe(true);
    const effect = def.spellAbility?.effects.find((e) => e.op === 'destroyAndCreateTokenForController');
    expect(effect !== undefined && effect.op === 'destroyAndCreateTokenForController' ? effect.spec : undefined).toBe(
      BEAST_3_3_GREEN,
    );
  });

  it('the mojibake em-dash regression: a non-cataloged token still gets a correctly-encoded typeLine', () => {
    // interpret.ts's dynamically-built typeLine used to read "Token Creature â€” Goblin" (a UTF-8 em
    // dash re-encoded as Latin-1 in source). Fixed at the source; this token has no catalog match
    // (so canonicalization can't be masking the bug), which is what actually exercises the fix.
    const spec = tokenSpecOf('When this creature enters, create a 2/2 red Goblin creature token.');
    expect((spec as { typeLine: string }).typeLine).toBe('Token Creature — Goblin');
    expect((spec as { typeLine: string }).typeLine).not.toContain('â€”');
  });
});
