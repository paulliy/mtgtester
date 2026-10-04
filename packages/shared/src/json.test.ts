import { describe, expect, it } from 'vitest';
import { parseStrictJson, STRICT_JSON_MAX_DEPTH } from './json';

/** The parsed value, or a thrown assertion — keeps the success cases readable. */
function value(text: string): unknown {
  const result = parseStrictJson(text);
  if (!result.ok) throw new Error(`expected a parse, got ${result.reason}`);
  return result.value;
}

/** A valid frame must parse to exactly what the native parser produces. */
function expectNativeSemantics(text: string): void {
  expect(value(text)).toEqual(JSON.parse(text) as unknown);
}

describe('parseStrictJson duplicate keys', () => {
  it('rejects a repeated key whose values differ', () => {
    expect(parseStrictJson('{"actionId":0,"actionId":1}')).toEqual({
      ok: false,
      reason: 'duplicateKey',
    });
  });

  it('rejects a repeated key whose values are identical', () => {
    expect(parseStrictJson('{"actionId":1,"actionId":1}')).toEqual({
      ok: false,
      reason: 'duplicateKey',
    });
  });

  it('rejects an escaped alias of an earlier key', () => {
    // The second key decodes to "actionId"; last-wins would hand validation its value instead.
    expect(parseStrictJson(String.raw`{"actionId":0,"action\u0049d":1}`)).toEqual({
      ok: false,
      reason: 'duplicateKey',
    });
  });

  it('rejects an escaped alias appearing first', () => {
    expect(parseStrictJson(String.raw`{"action\u0049d":1,"actionId":0}`)).toEqual({
      ok: false,
      reason: 'duplicateKey',
    });
  });

  it('rejects a duplicate nested inside a payload object', () => {
    expect(
      parseStrictJson('{"type":"submitPlayerAction","payload":{"actionId":0,"actionId":9}}'),
    ).toEqual({ ok: false, reason: 'duplicateKey' });
  });

  it('rejects a duplicate inside an object nested in an array', () => {
    expect(
      parseStrictJson('{"targets":[{"slot":0,"choice":"a"},{"slot":1,"slot":2,"choice":"b"}]}'),
    ).toEqual({ ok: false, reason: 'duplicateKey' });
  });

  it('rejects a duplicate in an element of a top-level array', () => {
    expect(parseStrictJson('[{"a":1},{"b":1,"b":2}]')).toEqual({
      ok: false,
      reason: 'duplicateKey',
    });
  });

  it('allows separate objects in one array to reuse identical key names', () => {
    expectNativeSemantics('{"targets":[{"slot":0,"choice":"a"},{"slot":1,"choice":"b"}]}');
  });

  it('allows a nested object to reuse a key its parent already used', () => {
    expectNativeSemantics('{"payload":{"payload":{"payload":1}}}');
  });

  it('allows the same key in objects that are siblings rather than nested', () => {
    expectNativeSemantics('{"a":{"slot":0},"b":{"slot":0},"c":[{"slot":0}]}');
  });
});

describe('parseStrictJson string handling', () => {
  it('does not mistake key-like text inside a string value for a key', () => {
    expectNativeSemantics(String.raw`{"a":"\"a\": 1, \"a\": 2","b":2}`);
  });

  it('does not mistake braces, brackets or commas inside string values for structure', () => {
    expectNativeSemantics('{"a":"{[,:}]","b":"}"}');
  });

  it('still rejects a duplicate that follows a value containing escaped quotes', () => {
    expect(parseStrictJson(String.raw`{"a":"x\"y","a":2}`)).toEqual({
      ok: false,
      reason: 'duplicateKey',
    });
  });

  it('treats an escaped backslash as ending the string, so the next key is still scanned', () => {
    expect(parseStrictJson(String.raw`{"a":"back\\","a":2}`)).toEqual({
      ok: false,
      reason: 'duplicateKey',
    });
  });

  it('preserves the native value of an escaped backslash', () => {
    const parsed = value(String.raw`{"a":"back\\","b":2}`) as { a: string; b: number };
    expect(parsed.a).toHaveLength(5);
    expect(parsed.a.charCodeAt(4)).toBe(92);
    expect(parsed.b).toBe(2);
  });

  it('preserves native semantics for escapes, unicode, numbers, null and booleans', () => {
    expectNativeSemantics(
      String.raw`{"s":"tab\tnew\nquote\"","u":"\u00e9","n":-1.5e3,"z":null,"b":true}`,
    );
  });

  it('accepts insignificant whitespace between every token', () => {
    expectNativeSemantics(' {\n  "a" : [ 1 , { "b" : 2 } ] \t}\n');
  });

  it('parses non-object top-level values the way the native parser does', () => {
    expectNativeSemantics('42');
    expectNativeSemantics('"plain"');
    expectNativeSemantics('null');
    expectNativeSemantics('[]');
    expectNativeSemantics('{}');
  });
});

describe('parseStrictJson malformed input', () => {
  it.each([
    ['an unterminated object', '{'],
    ['an unterminated string', '{"a":"x}'],
    ['a string closed only by an escaped quote', String.raw`{"a":"x\"}`],
    ['trailing content after a complete value', '{"a":1} {"b":2}'],
    ['a trailing comma', '{"a":1,}'],
    ['an empty line', ''],
    ['bare whitespace', '   '],
    ['a single-quoted key', "{'a':1}"],
    ['an unbalanced close', '{"a":1}}'],
  ])('reports %s as malformed', (_case, raw) => {
    expect(parseStrictJson(raw)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('parseStrictJson bounded work', () => {
  it('rejects nesting deeper than the documented bound', () => {
    const depth = STRICT_JSON_MAX_DEPTH + 1;
    expect(parseStrictJson(`${'['.repeat(depth)}1${']'.repeat(depth)}`)).toEqual({
      ok: false,
      reason: 'tooDeep',
    });
  });

  it('accepts nesting at exactly the documented bound', () => {
    const depth = STRICT_JSON_MAX_DEPTH;
    expectNativeSemantics(`${'['.repeat(depth)}1${']'.repeat(depth)}`);
  });

  it('accepts a large flat payload, as plaintext deck setup requires', () => {
    const lines = Array.from({ length: 2000 }, (_unused, i) => `1 Card Number ${i}`).join('\n');
    const raw = JSON.stringify({ type: 'startGame', payload: { seats: [{ text: lines }] } });
    const parsed = value(raw) as { payload: { seats: Array<{ text: string }> } };
    expect(parsed.payload.seats[0]?.text).toBe(lines);
  });
});
