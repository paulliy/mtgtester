import process from 'node:process';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

const ignored = new Set(['parent', 'loc', 'range', 'start', 'end', 'raw', 'tokens', 'comments']);
export function canonicalAst(value) {
  if (Array.isArray(value)) return value.map(canonicalAst);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !ignored.has(key))
      .sort()
      .map((key) => [key, canonicalAst(value[key])]),
  );
}
export function fingerprint(node) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalAst(node)))
    .digest('hex');
}
export function children(node) {
  return Object.entries(node)
    .filter(([key]) => !ignored.has(key))
    .flatMap(([, value]) =>
      Array.isArray(value)
        ? value.filter((item) => item && typeof item.type === 'string')
        : value && typeof value.type === 'string'
          ? [value]
          : [],
    );
}
const propertyName = (node) => node.key?.name ?? node.key?.value;
function literal(node) {
  while (['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion'].includes(node?.type))
    node = node.expression;
  return node?.type === 'Literal' ? node.value : undefined;
}
export function forbidden(node) {
  if (
    node.type === 'ObjectExpression' &&
    node.properties.some(
      (property) =>
        property.type === 'Property' &&
        propertyName(property) === 'kind' &&
        ['spell', 'triggered', 'activated'].includes(literal(property.value)),
    )
  )
    return 'envelope';
  if (
    node.type === 'Property' &&
    [
      'target',
      'targetSlot',
      'cardsSlot',
      'playerSlot',
      'first',
      'second',
      'a',
      'ref',
      'bSlot',
      'checkTarget',
    ].includes(propertyName(node)) &&
    typeof literal(node.value) === 'number' &&
    literal(node.value) >= 0
  )
    return 'slot';
  return undefined;
}
export function authoringScope(node, parents) {
  return (
    [...parents]
      .reverse()
      .find((parent) => parent.type === 'CallExpression' && parent.callee.name === 'defineCard') ??
    [...parents]
      .reverse()
      .find((parent) => ['VariableDeclarator', 'FunctionDeclaration'].includes(parent.type)) ??
    node
  );
}
export function collectLegacyScopes(ast) {
  const scopes = new Map();
  const bindings = new Map();
  const declarations = new Map();
  const registrations = [];
  function visit(node, parents) {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier')
      declarations.set(node.id.name, node);
    if (node.type === 'FunctionDeclaration' && node.id) declarations.set(node.id.name, node);
    if (node.type === 'CallExpression' && node.callee.name === 'defineCard')
      registrations.push(node);
    if (forbidden(node)) {
      const scope = authoringScope(node, parents);
      scopes.set(fingerprint(scope), scope);
      if (scope.type === 'VariableDeclarator' && scope.id.type === 'Identifier')
        bindings.set(scope.id.name, scope);
      if (scope.type === 'FunctionDeclaration' && scope.id) bindings.set(scope.id.name, scope);
    }
    for (const child of children(node)) visit(child, [...parents, node]);
  }
  visit(ast, []);
  function usesLegacy(node) {
    return (
      (node.type === 'Identifier' && bindings.has(node.name)) || children(node).some(usesLegacy)
    );
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, node] of declarations) {
      if (!bindings.has(name) && usesLegacy(node)) {
        bindings.set(name, node);
        scopes.set(fingerprint(node), node);
        changed = true;
      }
    }
  }
  for (const registration of registrations)
    if (usesLegacy(registration)) scopes.set(fingerprint(registration), registration);
  return { scopes, bindings };
}

const manifest = JSON.parse(
  readFileSync(
    new URL(
      '../../packages/engine/tests/fixtures/legacy-authoring-exemptions.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const exemptions = new Set(manifest.scopes.map((scope) => `${scope.file}:${scope.sha256}`));
export const cardAuthoringPlugin = {
  rules: {
    'guard-legacy-builders': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          envelope:
            'Use spell(), triggered(), or activated(). Only exact unchanged legacy definitions are exempt.',
          slot: 'Use targetSlots() named indexes. Only exact unchanged legacy definitions are exempt.',
          helper:
            'A new or changed definition references a raw legacy ability helper. Migrate that helper to shared builders.',
        },
      },
      create(context) {
        const file = relative(process.cwd(), context.filename).replaceAll('\\', '/');
        const source = context.sourceCode;
        const { bindings } = collectLegacyScopes(source.ast);
        const allowed = (scope) => exemptions.has(`${file}:${fingerprint(scope)}`);
        function usesLegacy(node) {
          return (
            (node.type === 'Identifier' && bindings.has(node.name)) ||
            children(node).some(usesLegacy)
          );
        }
        return {
          ObjectExpression(node) {
            check(node);
          },
          Property(node) {
            check(node);
          },
          CallExpression(node) {
            if (node.callee.name === 'defineCard' && !allowed(node) && usesLegacy(node))
              context.report({ node, messageId: 'helper' });
          },
        };
        function check(node) {
          const messageId = forbidden(node);
          if (messageId && !allowed(authoringScope(node, source.getAncestors(node))))
            context.report({ node, messageId });
        }
      },
    },
  },
};
