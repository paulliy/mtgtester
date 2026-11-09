/**
 * The IR schema the compiler shows a model: every type declaration reachable from
 * `CardDefinition`, pulled from the engine's own source with the TypeScript compiler API, so the
 * prompt can never drift from the types the validator checks. JSDoc is kept but shortened.
 */
import ts from 'typescript';

const ROOT_FILE = 'packages/engine/src/cards/definition.ts';
/** Fields a compiled patch may never set: identity and printed characteristics come from Oracle data. */
const MAX_COMMENT = 240;

function shortenComment(text: string): string {
  const body = text
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trim())
    .filter((line) => line.length > 0)
    .join(' ');
  const cut = body.length > MAX_COMMENT ? `${body.slice(0, MAX_COMMENT).trimEnd()}…` : body;
  return cut.length === 0 ? '' : `/** ${cut} */`;
}

/** Declaration text with every comment shortened and blank lines dropped. */
function printDeclaration(node: ts.Node, source: ts.SourceFile): string {
  const full = source.text.slice(node.getFullStart(), node.getEnd());
  const out: string[] = [];
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    full,
  );
  let token = scanner.scan();
  let buffer = '';
  while (token !== ts.SyntaxKind.EndOfFileToken) {
    const text = scanner.getTokenText();
    if (token === ts.SyntaxKind.MultiLineCommentTrivia) buffer += shortenComment(text);
    else if (token === ts.SyntaxKind.SingleLineCommentTrivia) buffer += '';
    else buffer += text;
    token = scanner.scan();
  }
  for (const line of buffer.split('\n'))
    if (line.trim().length > 0) out.push(line.replace(/\s+$/, ''));
  return out.join('\n');
}

export function buildSchema(): { text: string; names: string[] } {
  const program = ts.createProgram([ROOT_FILE], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    resolveJsonModule: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  });
  const checker = program.getTypeChecker();
  const seen = new Set<ts.Node>();
  const ordered: { name: string; text: string }[] = [];

  const visitTypeNode = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) || ts.isExpressionWithTypeArguments(node)) {
      const nameNode = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
      let symbol = checker.getSymbolAtLocation(nameNode);
      if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      for (const decl of symbol?.declarations ?? []) addDeclaration(decl);
    }
    if (ts.isTypeQueryNode(node)) {
      let symbol = checker.getSymbolAtLocation(node.exprName);
      if (symbol !== undefined && symbol.flags & ts.SymbolFlags.Alias)
        symbol = checker.getAliasedSymbol(symbol);
      for (const decl of symbol?.declarations ?? []) {
        // `(typeof IMPLEMENTED_KEYWORDS)[number]`: print the constant's initializer.
        if (ts.isVariableDeclaration(decl)) addDeclaration(decl.parent.parent);
      }
    }
    if (ts.isImportTypeNode(node)) {
      const type = checker.getTypeFromTypeNode(node);
      const symbol = type.aliasSymbol ?? type.getSymbol();
      for (const decl of symbol?.declarations ?? []) addDeclaration(decl);
    }
    ts.forEachChild(node, visitTypeNode);
  };

  function addDeclaration(decl: ts.Node): void {
    if (seen.has(decl)) return;
    const source = decl.getSourceFile();
    if (source.isDeclarationFile) return;
    if (
      !ts.isTypeAliasDeclaration(decl) &&
      !ts.isInterfaceDeclaration(decl) &&
      !ts.isVariableStatement(decl) &&
      !ts.isEnumDeclaration(decl)
    )
      return;
    seen.add(decl);
    const name = ts.isVariableStatement(decl)
      ? decl.declarationList.declarations.map((d) => d.name.getText(source)).join(',')
      : decl.name.getText(source);
    ordered.push({ name, text: printDeclaration(decl, source) });
    if (ts.isVariableStatement(decl)) return;
    ts.forEachChild(decl, visitTypeNode);
  }

  const root = program.getSourceFile(ROOT_FILE);
  if (root === undefined) throw new Error(`cannot load ${ROOT_FILE}`);
  ts.forEachChild(root, (node) => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === 'CardDefinition')
      addDeclaration(node);
  });
  return {
    names: ordered.map((entry) => entry.name),
    text: ordered.map((entry) => entry.text).join('\n\n'),
  };
}

if (import.meta.main) {
  const { text, names } = buildSchema();
  console.log(`${names.length} declarations, ${text.length} chars`);
  if (process.argv.includes('--print')) console.log(text);
}
