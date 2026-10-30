import js from '@eslint/js';
import { cardAuthoringPlugin } from './scripts/eslint/card-authoring.js';
import { castingBoundaryPlugin } from './scripts/eslint/casting-boundary.js';
import { testSkipsPlugin } from './scripts/eslint/test-skips.js';
import { zoneMutationPlugin } from './scripts/eslint/zone-mutation.js';
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
// The browser renders what the server writes (ADR 0032 decision 9). Two syntactic rules keep it
// from parsing engine text again: string or regex calls on a `typeLine` member, and the narrower
// set of calls on `description`, `prompt` and `text` members. The config is untyped, so these
// match names, not types; `LegalAction.data` is kept out by the browser's protocol type instead.
// A call on the member (`card.typeLine.includes(...)`) and a regex call that takes it
// (`/x/.test(card.typeLine)`) are both caught.
function textCallSelectors(fields, methods, regexMethods) {
  const member = `:matches(MemberExpression[property.name=/^(${fields})$/], Identifier[name=/^(${fields})$/])`;
  return [
    `CallExpression[callee.property.name=/^(${methods})$/] > MemberExpression.callee > ${member}.object`,
    `CallExpression[callee.property.name=/^(${regexMethods})$/] > ${member}.arguments`,
  ];
}
const TYPE_LINE_CALL_SELECTORS = textCallSelectors(
  'typeLine',
  'test|match|split|replace|includes|startsWith|endsWith',
  'test|exec',
);
const ENGINE_TEXT_CALL_SELECTORS = textCallSelectors(
  'description|prompt|text',
  'test|match|split|replace|includes',
  'test|exec',
);
const WEB_TEXT_RESTRICTIONS = [
  ...TYPE_LINE_CALL_SELECTORS.map((selector) => ({
    selector,
    message:
      "Do not classify a card by its printed type line in the browser. Render the projection's `types`, `supertypes`, `subtypes`, `isToken` and `boardGroup` (ADR 0032 decision 2), which the server computes.",
  })),
  ...ENGINE_TEXT_CALL_SELECTORS.map((selector) => ({
    selector,
    message:
      'Do not parse engine text in the browser. Render the typed field the server sends (`DecisionRequest.presentation`, ADR 0032), or ask for one; engine wording is not an interface.',
  })),
];

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
      '**/dist-table/**',
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
    files: ['packages/engine/src/**/*.ts'],
    plugins: { 'casting-boundary': castingBoundaryPlugin },
    rules: { 'casting-boundary/constructors': 'error' },
  },
  {
    // Zone changes go through state/objects.ts (ADR 0034 decision 7); test setup builds positions.
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['packages/engine/src/state/objects.ts', 'packages/engine/src/testing/**'],
    plugins: { 'zone-mutation': zoneMutationPlugin },
    rules: { 'zone-mutation/outside-objects': 'error' },
  },
  {
    // The inline-`TokenSpec` ban covers all of the engine, not only card data: Master of Ceremonies'
    // Treasure lost its sacrifice cost in `resolve.ts`, outside the old `overrides/**` scope. Only
    // the catalog itself (`cards/tokens.ts`) may build a token from a literal, and the one
    // phrase-parsing site in `interpret.ts` (`parseTokenFace`) carries its own inline disable.
    //
    // Flat-config rule arrays replace earlier ones per matching entry, so this entry must stay
    // ordered before every other `no-restricted-syntax` entry. The later entries that match these
    // files repeat the token selector (`OVERRIDE_RESTRICTIONS`) or, for test files, deliberately
    // drop it.
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['packages/engine/src/cards/tokens.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: TOKEN_SPEC_LITERAL_SELECTOR, message: TOKEN_SPEC_LITERAL_MESSAGE },
      ],
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
    plugins: { 'card-authoring': cardAuthoringPlugin },
    rules: {
      'no-restricted-syntax': ['error', ...OVERRIDE_RESTRICTIONS],
      'card-authoring/guard-legacy-builders': 'error',
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
  {
    // A skipped or focused test keeps the suite green while proving nothing (ADR 0034 decision 9).
    // Each use carries `// allowed-skip: <reason>` beside it.
    files: ['**/*.test.ts', '**/*.spec.ts'],
    plugins: { 'test-skips': testSkipsPlugin },
    rules: { 'test-skips/annotated-skips': 'error' },
  },
  {
    // The server writes every label, cost and note the player reads (ADR 0032), so the browser
    // may not import the code that builds them, or it would build its own.
    files: ['apps/web/src/**/*.{ts,vue}'],
    // `lib/protocol.ts` is where the wire types are retyped for the browser.
    ignores: ['apps/web/src/lib/protocol.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          // The wire types carry `LegalAction.data`; the browser's own do not (ADR 0032 decision 7).
          paths: [
            {
              name: '@mtg/shared',
              importNames: [
                'LegalAction',
                'DecisionRequest',
                'PlayerActionRequiredPayload',
                'DecisionPendingPayload',
                'ServerToClientMessage',
              ],
              message:
                "Import this type from 'lib/protocol': the browser is never sent `LegalAction.data`, and its types say so.",
            },
          ],
          patterns: [
            {
              group: ['@mtg/shared/presentation', '@mtg/shared/presentation/*'],
              message:
                'The server builds presentation (server/src/match/presentation.ts); render the fields of DecisionRequest.presentation instead of importing the label code.',
            },
          ],
        },
      ],
    },
  },
  {
    // Table code is reachable only from the table entry points (ADR 0031 decision 1), so tester
    // modules cannot grow a path into it. Only `table/**` itself, `cli/serve-table.ts` and the
    // scripted-run CLI may import it. `packages/bot` is skipped because its diplomacy module has
    // an unrelated `table` file, and `apps/web` because its own block above owns that rule.
    files: ['packages/**/*.ts', 'scripts/**/*.ts'],
    ignores: [
      'packages/server/src/table/**',
      'packages/server/src/cli/serve-table.ts',
      'packages/server/src/cli/table-scripted-run.ts',
      'packages/bot/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/table', '**/table/**'],
              message:
                'Code under server/src/table/ is for the table server only (ADR 0031 decision 1); import it only from cli/serve-table.ts or from table/ itself.',
            },
          ],
        },
      ],
    },
  },
  {
    // The test-only hooks (ADR 0034 decisions 5 and 8) are installed only by tests and tools:
    // product code may run them, never install them. `testing/` itself wires them together, and
    // the fuzz CLI is a tool. The table pattern is repeated because this block's rule replaces the
    // one above for these files.
    files: ['packages/engine/src/**/*.ts', 'packages/server/src/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      'packages/engine/src/testing/**',
      'packages/server/src/cli/fuzz-game.ts',
      'packages/server/src/table/**',
      'packages/server/src/cli/serve-table.ts',
      'packages/server/src/cli/table-scripted-run.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/table', '**/table/**'],
              message:
                'Code under server/src/table/ is for the table server only (ADR 0031 decision 1); import it only from cli/serve-table.ts or from table/ itself.',
            },
            {
              group: ['**/testing/invariants'],
              message:
                'The state-invariant checker is installed by tests and tools only (ADR 0034 decision 8).',
            },
            {
              group: ['**/testing/definition-transform', '**/testing/checkpoint-hook'],
              importNames: ['installDefinitionTransform', 'installCheckpointHook'],
              message:
                'Test-only hooks are installed by tests and tools only (ADR 0034 decisions 5 and 8).',
            },
          ],
        },
      ],
    },
  },
  {
    // Primitive contract evidence hashes each contract test's dependency closure, so contract
    // tests stay off the scenario runner (ADR 0034 decision 10). The table pattern is repeated
    // because this block's rule replaces the one above for these files.
    files: ['packages/**/*-contract.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/table', '**/table/**'],
              message:
                'Code under server/src/table/ is for the table server only (ADR 0031 decision 1); import it only from cli/serve-table.ts or from table/ itself.',
            },
            {
              group: ['**/scenario/*', '**/scenario'],
              message:
                'Contract tests do not use the scenario runner: their evidence hashes their test closure (ADR 0034 decision 10).',
            },
          ],
        },
      ],
    },
  },
  {
    // The table server reaches no batch runner, benchmark runtime or Card Test Lab scenario
    // (plan M3 task 12); `table/module-graph.test.ts` checks the bundled graph as well.
    files: ['packages/server/src/table/**/*.ts', 'packages/server/src/cli/serve-table.ts'],
    ignores: ['packages/server/src/table/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/batch', '**/batch/**', '**/benchmark', '**/benchmark/**'],
              message: 'The table server runs no batches or benchmarks (ADR 0031 decision 1).',
            },
            {
              group: ['**/card-test-scenarios*'],
              message:
                'Card Test Lab scenarios set up games outside the rules; the table server never loads them.',
            },
          ],
        },
      ],
    },
  },
  {
    // Test files keep the generator rule above (a later `no-restricted-syntax` entry would replace
    // it), and assert on text freely. `lib/tokenArt.ts` splits the type line only to build the
    // Scryfall search for a printed token's picture, a cosmetic lookup and not a rules
    // classification (ADR 0032 decision 9).
    files: ['apps/web/src/**/*.{ts,vue}'],
    ignores: ['apps/web/src/**/*.test.ts', 'apps/web/src/lib/tokenArt.ts'],
    rules: { 'no-restricted-syntax': ['error', ...WEB_TEXT_RESTRICTIONS] },
  },
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.vue'],
    // vue-tsc checks identifiers with the DOM and TypeScript namespaces.
    rules: { 'no-undef': 'off' },
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] } },
  },
);
