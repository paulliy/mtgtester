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
);
