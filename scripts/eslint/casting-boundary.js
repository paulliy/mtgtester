import process from 'node:process';
import { relative } from 'node:path';

const root = 'packages/engine/src/';
const constructors = new Set(['casting/cast.ts', 'casting/preview.ts', 'stack/copy.ts']);
const property = (node, name) =>
  node.properties.find(
    (entry) => entry.type === 'Property' && (entry.key.name ?? entry.key.value) === name,
  );
const literal = (node) => {
  while (['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion'].includes(node?.type))
    node = node.expression;
  return node?.type === 'Literal' ? node.value : undefined;
};

export const castingBoundaryPlugin = {
  rules: {
    constructors: {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          spell:
            'Create cast spells inside casting/cast.ts or casting/preview.ts. Copies use stack/copy.ts; they are not casts.',
          import:
            'Casting and copy constructors are internal. Use the authorized action, preview, or effect route rather than exporting or importing a second cast path.',
        },
      },
      create(context) {
        const file = relative(process.cwd(), context.filename).replaceAll('\\', '/');
        const path = file.slice(root.length);
        return {
          ObjectExpression(node) {
            if (constructors.has(path)) return;
            const kind = literal(property(node, 'kind')?.value);
            const stackShape = ['card', 'sourceOracleId', 'sourceCardId'].some((name) =>
              property(node, name),
            );
            let parent = node.parent;
            let assertedStack = false;
            while (
              ['TSAsExpression', 'TSSatisfiesExpression', 'TSTypeAssertion'].includes(parent.type)
            ) {
              assertedStack ||= parent.typeAnnotation?.typeName?.name === 'EngineStackObject';
              parent = parent.parent;
            }
            const typedStack =
              parent.type === 'VariableDeclarator' &&
              parent.id.typeAnnotation?.typeAnnotation?.typeName?.name === 'EngineStackObject';
            if (
              (kind === 'spell' && stackShape) ||
              ((typedStack || assertedStack) &&
                !['activatedAbility', 'triggeredAbility'].includes(kind))
            )
              context.report({ node, messageId: 'spell' });
          },
          ImportDeclaration: checkModule,
          ExportNamedDeclaration: checkModule,
          ExportAllDeclaration: checkModule,
        };
        function checkModule(node) {
          const source = node.source?.value;
          if (typeof source !== 'string') return;
          const module = source.replace(/\.(?:js|ts)$/, '');
          const helpersOnly =
            node.specifiers?.length > 0 &&
            node.specifiers.every((specifier) =>
              ['queueWardTriggers', 'queueBecomesTargetedTriggers'].includes(specifier.local?.name),
            );
          if (
            module.endsWith('/casting/cast') &&
            path === 'actions/apply.ts' &&
            node.type === 'ExportNamedDeclaration' &&
            helpersOnly
          )
            return;
          const preparedOnly =
            path === 'testing/prepared-scenario.ts' &&
            node.type === 'ImportDeclaration' &&
            node.specifiers.length === 1 &&
            node.specifiers[0].imported?.name === 'preparedScenarioSpell';
          const allowed = module.endsWith('/casting/cast')
            ? path === 'actions/apply.ts' || path.startsWith('casting/')
            : module.endsWith('/casting/preview')
              ? path === 'actions/legal.ts' || path.startsWith('casting/') || preparedOnly
              : module.endsWith('/stack/copy')
                ? path === 'effects/resolve.ts'
                : undefined;
          if (allowed === false || (allowed !== undefined && node.type !== 'ImportDeclaration'))
            context.report({ node, messageId: 'import' });
        }
      },
    },
  },
};
