import process from 'node:process';
import { relative } from 'node:path';

const root = 'packages/engine/src/';
const internalModule = (source) =>
  typeof source === 'string' &&
  /\/(?:casting\/(?:cast|preview)|stack\/copy)(?:\.(?:js|ts))?$/.test(source);
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
        const internalBindings = new Map();
        const stackTypes = new Set(['EngineStackObject']);
        const isStackType = (type) =>
          type?.type === 'TSTypeReference' && stackTypes.has(type.typeName?.name);
        return {
          Program(node) {
            // Discover bindings before checking exports, including exports before imports.
            for (const statement of node.body) {
              if (statement.type !== 'ImportDeclaration') continue;
              for (const specifier of statement.specifiers) {
                if (internalModule(statement.source.value))
                  internalBindings.set(specifier.local.name, {
                    source: statement.source.value,
                    imported: specifier.imported?.name,
                  });
                if (specifier.imported?.name === 'EngineStackObject')
                  stackTypes.add(specifier.local.name);
              }
            }
            let changed;
            do {
              changed = false;
              for (const statement of node.body) {
                const alias =
                  statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement;
                if (
                  alias?.type === 'TSTypeAliasDeclaration' &&
                  isStackType(alias.typeAnnotation) &&
                  !stackTypes.has(alias.id.name)
                ) {
                  stackTypes.add(alias.id.name);
                  changed = true;
                }
              }
            } while (changed);
          },
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
              assertedStack ||= isStackType(parent.typeAnnotation);
              parent = parent.parent;
            }
            const typedStack =
              parent.type === 'VariableDeclarator' &&
              isStackType(parent.id.typeAnnotation?.typeAnnotation);
            if (
              (kind === 'spell' && stackShape) ||
              ((typedStack || assertedStack) &&
                !['activatedAbility', 'triggeredAbility'].includes(kind))
            )
              context.report({ node, messageId: 'spell' });
          },
          ImportDeclaration: checkModule,
          ExportNamedDeclaration(node) {
            checkModule(node);
            if (node.source) return;
            for (const specifier of node.specifiers) checkLocalExport(specifier.local);
          },
          ExportDefaultDeclaration(node) {
            checkLocalExport(node.declaration);
          },
          ImportExpression(node) {
            if (internalModule(node.source.value)) context.report({ node, messageId: 'import' });
          },
          ExportAllDeclaration: checkModule,
        };
        function checkLocalExport(node) {
          if (node.type !== 'Identifier') return;
          const binding = internalBindings.get(node.name);
          if (!binding) return;
          if (
            path === 'actions/apply.ts' &&
            binding.source.replace(/\.(?:js|ts)$/, '').endsWith('/casting/cast') &&
            ['queueWardTriggers', 'queueBecomesTargetedTriggers'].includes(binding.imported)
          )
            return;
          context.report({ node, messageId: 'import' });
        }
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
