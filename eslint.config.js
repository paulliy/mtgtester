import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';

// A `TokenSpec` object literal, matched structurally rather than by import — the same shape a
// hand-typed token and a `creatureToken()`/`artifactToken()` call both produce, so only the
// literal's own properties can tell them apart. `typeLine`+`subtypes`+`colors` together are
// specific to `TokenSpec` among the shapes these files build (an `AlternativeCast`'s Omen face has
// `typeLine` alone; `CardDefinition` itself has all three but is excluded by its own `oracleId`).
const TOKEN_SPEC_LITERAL_SELECTOR =
  "ObjectExpression:has(Property[key.name='typeLine']):has(Property[key.name='subtypes']):has(Property[key.name='colors']):not(:has(Property[key.name='oracleId']))";
const TOKEN_SPEC_LITERAL_MESSAGE =
  'Build a token with creatureToken()/artifactToken() (cards/tokens.ts), or reference a named catalog export directly, rather than a raw TokenSpec object literal — this drift is exactly what produced three different Treasure tokens and a Soldier that disagreed on its own color.';

// Flat-config rule arrays replace earlier arrays; strict files must retain every base ban.
const OVERRIDE_RESTRICTIONS = [
  {
    selector: "CallExpression[callee.name='registerOverride']",
    message:
      'Use defineCard(oracleId, name, handledLines, def) — it registers both the real and the fixture oracle id, so the two cannot drift apart. Use unimplemented(...) for a card with no authored behavior yet.',
  },
  {
    selector: "CallExpression[callee.name='parseManaCost']",
    message:
      "Use mana('{2}{R}') for a cost component or manaCost('{2}{R}') for a ParsedManaCost. Both throw on an unparseable cost, where parseManaCost(s).cost! yields a null cost the payment solver treats as free.",
  },
  {
    selector: TOKEN_SPEC_LITERAL_SELECTOR,
    message: TOKEN_SPEC_LITERAL_MESSAGE,
  },
  {
    selector: "Property[key.name='op'][value.value='noOp']",
    message:
      'Executable noOp effects are prohibited in authored card data. Keep the card explicitly unsupported until its behavior is implemented.',
  },
];

export default tseslint.config(
  {
    // Not linted: build output, dependencies, and vendored data/docs.
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'coverage/**',
      'data/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Phase 0 scaffolding uses placeholder consts/exports; loosen where noise is expected.
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },
  {
    // Authored card overrides go through the shared builders (`cards/templates.ts`). The point of
    // that layer is that the same mechanic is written the same way everywhere, which only holds if
    // new cards cannot quietly go back to raw literals — the drift these rules block is exactly
    // what produced three different Treasure tokens and a Soldier that was the wrong color.
    files: ['packages/engine/src/cards/overrides/**/*.ts'],
    ignores: [
      // The registry module defines the helpers, so it necessarily calls the primitive itself.
      'packages/engine/src/cards/overrides/index.ts',
      'packages/engine/src/cards/overrides/snapshot.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...OVERRIDE_RESTRICTIONS],
    },
  },
  {
    files: ['packages/engine/src/cards/overrides/reviewed-*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...OVERRIDE_RESTRICTIONS,
        {
          selector:
            "ObjectExpression:has(Property[key.name='kind'][value.value=/^(spell|triggered|activated)$/])",
          message:
            'Use spell(), triggered(), or activated() from cards/templates.ts for reviewed card ability envelopes.',
        },
        {
          selector:
            "Property:matches([key.name='target'], [key.name='targetSlot'], [key.name='cardsSlot'], [key.name='playerSlot'])[value.type='Literal'][value.value>=0]",
          message:
            'Use targetSlots() named indexes in reviewed card definitions instead of bare numeric target references.',
        },
      ],
    },
  },
  {
    // The generic "create a token" grammar (`parseTokenFace` in interpret.ts) is the one place
    // outside `cards/tokens.ts` allowed to build a `TokenSpec` at all — it is reading a phrase off
    // the card, not choosing from the catalog, so there is nothing to reference by name. It
    // canonicalizes its result against the catalog immediately afterward (`canonicalizeToken`) and
    // the one construction site carries its own inline disable.
    files: ['packages/engine/src/cards/interpret.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: TOKEN_SPEC_LITERAL_SELECTOR,
          message: TOKEN_SPEC_LITERAL_MESSAGE,
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression:matches([callee.name='it'], [callee.name='test'], [callee.object.name='it'], [callee.object.name='test']) > FunctionExpression[generator=true]",
          message:
            'Vitest does not execute generator test bodies. Use a normal callback and drive the generator with pump().',
        },
      ],
    },
  },
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    // vue-tsc checks identifiers with the DOM and TypeScript namespaces.
    rules: { 'no-undef': 'off' },
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] } },
  },
);
