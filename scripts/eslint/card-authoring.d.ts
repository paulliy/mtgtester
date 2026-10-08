export function canonicalAst(value: unknown): unknown;
export function fingerprint(node: unknown): string;
export function collectLegacyScopes(ast: unknown): {
  scopes: Map<string, unknown>;
  bindings: Map<string, unknown>;
};
