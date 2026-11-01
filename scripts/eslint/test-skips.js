// A skipped, todo or focused test stops proving anything while the suite stays green (ADR 0034
// decision 9). This rule rejects `it.skip`, `test.skip`, `describe.skip`, `*.todo`, `*.only`,
// `*.skipIf`, `*.runIf` and `*.fixme` in test files unless the same line, or the line before,
// carries `// allowed-skip: <reason>`. The reason sits beside the skip it excuses rather than in a
// central list, so deleting the skip deletes the excuse.

const TEST_FUNCTIONS = new Set(['it', 'test', 'describe', 'suite', 'bench']);
const SKIPPING_MEMBERS = new Set(['skip', 'todo', 'only', 'skipIf', 'runIf', 'fixme']);
const ALLOWED = /^\s*allowed-skip:(.*)$/s;

/** The identifier a member chain such as `test.describe.skip` or `it.each([...]).skip` starts at. */
function rootIdentifier(node) {
  let current = node;
  for (;;) {
    if (current.type === 'MemberExpression') current = current.object;
    else if (current.type === 'CallExpression') current = current.callee;
    else break;
  }
  return current.type === 'Identifier' ? current.name : undefined;
}

export const testSkipsPlugin = {
  rules: {
    'annotated-skips': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          unannotated:
            '`{{ name }}` disables or focuses tests. Remove it, or put `// allowed-skip: <reason>` on this line or the line before.',
          noReason:
            '`// allowed-skip:` needs a concrete reason after the colon (for example "needs the Scryfall bulk file").',
        },
      },
      create(context) {
        const sourceCode = context.sourceCode;
        const comments = sourceCode
          .getAllComments()
          .filter((comment) => comment.type === 'Line' && ALLOWED.test(comment.value));
        return {
          MemberExpression(node) {
            const member = node.computed ? undefined : node.property.name;
            if (member === undefined || !SKIPPING_MEMBERS.has(member)) return;
            const root = rootIdentifier(node.object);
            if (root === undefined || !TEST_FUNCTIONS.has(root)) return;
            const lines = new Set([node.loc.start.line, node.property.loc.start.line]);
            const annotation = comments.find((comment) =>
              [...lines].some(
                (line) => comment.loc.end.line === line || comment.loc.end.line === line - 1,
              ),
            );
            const name = `${sourceCode.getText(node)}`.replace(/\s+/g, ' ');
            if (annotation === undefined)
              context.report({ node, messageId: 'unannotated', data: { name } });
            else if (ALLOWED.exec(annotation.value)[1].trim() === '')
              context.report({ node, messageId: 'noReason' });
          },
        };
      },
    },
  },
};
