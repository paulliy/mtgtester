// Objects move between zones through the helpers in `state/objects.ts` (ADR 0034 decision 7): they
// apply entry replacements, queue zone-change triggers and make a new object (CR 400.7). This rule
// rejects, elsewhere in the engine, a push, unshift or splice on a zone a card enters
// (battlefield, exile, hand, graveyard, command zone) and any reassignment of a zone, unless the
// same line or the line before carries `// zone-mutation: <reason>`. One comment covers a run of
// such lines directly beneath it. Reordering a library in place is not a zone change and is not
// checked.

const ENTERED = new Set(['battlefield', 'exile', 'hand', 'graveyard', 'commandZone']);
const REASSIGNED = new Set([...ENTERED, 'library']);
const ADDING = new Set(['push', 'unshift', 'splice']);
const ALLOWED = /^\s*zone-mutation:(.*)$/s;

const propertyName = (node) =>
  node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier'
    ? node.property.name
    : undefined;

export const zoneMutationPlugin = {
  rules: {
    'outside-objects': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          mutation:
            'Move objects between zones with the helpers in state/objects.ts, which apply entry replacements and make a new object (CR 400.7); or put `// zone-mutation: <reason>` on this line or the line before.',
          noReason: '`// zone-mutation:` needs a concrete reason after the colon.',
        },
      },
      create(context) {
        const comments = context.sourceCode
          .getAllComments()
          .filter((comment) => comment.type === 'Line' && ALLOWED.test(comment.value));
        const flagged = [];
        const lines = new Set();
        const check = (node) => {
          flagged.push(node);
          lines.add(node.loc.start.line);
        };
        const excuseFor = (line) => {
          for (let at = line; ; at--) {
            const comment = comments.find(
              (candidate) => candidate.loc.start.line === at || candidate.loc.end.line === at - 1,
            );
            if (comment !== undefined) return comment;
            if (!lines.has(at - 1)) return undefined;
          }
        };
        return {
          CallExpression(node) {
            const method = propertyName(node.callee);
            if (method === undefined || !ADDING.has(method)) return;
            const zone = propertyName(node.callee.object);
            if (zone !== undefined && ENTERED.has(zone)) check(node);
          },
          AssignmentExpression(node) {
            const zone = propertyName(node.left);
            if (zone !== undefined && REASSIGNED.has(zone)) check(node);
          },
          'Program:exit'() {
            for (const node of flagged) {
              const excuse = excuseFor(node.loc.start.line);
              if (excuse === undefined) context.report({ node, messageId: 'mutation' });
              else if (ALLOWED.exec(excuse.value)[1].trim() === '')
                context.report({ node, messageId: 'noReason' });
            }
          },
        };
      },
    },
  },
};
