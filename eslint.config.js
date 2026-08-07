import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Not linted: build output, deps, vendored data/docs, Vue SFCs (no vue plugin in Phase 0).
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'coverage/**',
      'data/**',
      'docs/**',
      '**/*.vue',
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
      'no-restricted-syntax': [
        'error',
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
      ],
    },
  },
);
