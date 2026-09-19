# Testing and Typechecking

Production TypeScript compilation and test typechecking are intentionally separate.

`packages/engine/tsconfig.json` includes only `src`, so the root build stays smaller and does
not load every engine test into the same TypeScript project. Run the production typecheck with:

```bash
bun run typecheck
```

Run engine source and test typechecking separately with:

```bash
bun run typecheck:tests
```

Run the test suite with:

```bash
bun run test
```

This separation reduces peak compiler memory while preserving an explicit check for test-only
TypeScript errors. If the full production build still exceeds the local default heap, use
`NODE_OPTIONS=--max-old-space-size=8192` for that command.
