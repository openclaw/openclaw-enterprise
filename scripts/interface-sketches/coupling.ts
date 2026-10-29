import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export interface CouplingEdge {
  from: string;
  kind: "calls" | "constructs" | "binds" | "implements";
  to: string;
  site: { file: string; line: number };
}

type Unresolved = { from: string; site: CouplingEdge["site"]; kind: CouplingEdge["kind"] };

const sourceAliases: Record<string, string[]> = Object.fromEntries(
  ["contracts", "occ", "utils", "iam", "audit"].map((name) => [
    `@openclaw-enterprise/${name}`,
    [`packages/${name}/src/index.ts`],
  ]),
);

/** Static, lexical coupling only. Only selected files emit edges; imported source
 * may supply declarations. No inference of runtime dispatch or full reachability.
 * Module-level sites without a named owner are unresolved, with the file as from.
 * External packages are excluded even when installed in the caller's checkout.
 */
export function analyzeCoupling(
  root: string,
  files: readonly string[],
): { edges: CouplingEdge[]; unresolved: Unresolved[] } {
  const base = realpathSync(root);
  const relative = (file: string): string => path.relative(base, file).split(path.sep).join("/");
  const inside = (file: string): boolean => {
    const name = relative(file);
    return name !== ".." && !name.startsWith("../") && !path.isAbsolute(name);
  };
  const inputs = [...new Set(files.map((file) => realpathSync(path.resolve(base, file))))].sort();
  for (const file of inputs) {
    if (!inside(file) || !statSync(file).isFile() || !/\.[cm]?[jt]sx?$/.test(file)) {
      throw new Error("Coupling inputs must be source files inside the source root");
    }
  }
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    checkJs: true,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    baseUrl: base,
    paths: sourceAliases,
    types: [],
  };
  const host = ts.createCompilerHost(options);
  const cache = ts.createModuleResolutionCache(base, (name) => name, options);
  const externalModule = (name: string): boolean =>
    !name.startsWith(".") && !Object.hasOwn(sourceAliases, name);
  const excludedImports = new Set<string>();
  host.resolveModuleNames = (names, containingFile) =>
    names.map((name) => {
      if (externalModule(name)) {
        return undefined;
      }
      const alias = sourceAliases[name]?.[0];
      if (alias) {
        const source = path.resolve(base, alias);
        return ts.sys.fileExists(source) && inside(realpathSync(source))
          ? { resolvedFileName: source }
          : undefined;
      }
      const resolved = ts.resolveModuleName(
        name,
        containingFile,
        options,
        host,
        cache,
      ).resolvedModule;
      if (!resolved) {
        if (!inside(path.resolve(path.dirname(containingFile), name))) {
          excludedImports.add(`${containingFile}#${name}`);
        }
        return undefined;
      }
      if (!inside(realpathSync(resolved.resolvedFileName))) {
        excludedImports.add(`${containingFile}#${name}`);
        return undefined;
      }
      return resolved;
    });
  const program = ts.createProgram(inputs, options, host);
  const checker = program.getTypeChecker();
  const ownSource = (source: ts.SourceFile): boolean =>
    inside(source.fileName) &&
    !source.isDeclarationFile &&
    !relative(source.fileName).split("/").includes("node_modules");
  // Type errors (including unavailable external dependencies) do not establish
  // targets. Syntax errors cannot safely supply a graph and fail the analysis.
  for (const source of program.getSourceFiles().filter(ownSource)) {
    const errors = program.getSyntacticDiagnostics(source);
    if (errors.length) {
      const diagnostic = errors[0];
      const line = source.getLineAndCharacterOfPosition(diagnostic.start ?? 0).line + 1;
      throw new Error(
        `${relative(source.fileName)}:${line}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
      );
    }
  }

  function identity(node: ts.Node): string | undefined {
    const source = node.getSourceFile();
    if (!ownSource(source)) {
      return undefined;
    }
    let name: string | undefined;
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)) &&
      ts.isSourceFile(node.parent)
    ) {
      name = node.name?.text;
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isVariableDeclarationList(node.parent) &&
      ts.isVariableStatement(node.parent.parent) &&
      ts.isSourceFile(node.parent.parent.parent)
    ) {
      name = node.name.text;
    } else if (
      (ts.isMethodDeclaration(node) ||
        ts.isMethodSignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) ||
        ts.isConstructorDeclaration(node) ||
        ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node)) &&
      (ts.isClassDeclaration(node.parent) || ts.isInterfaceDeclaration(node.parent)) &&
      ts.isSourceFile(node.parent.parent) &&
      node.parent.name
    ) {
      let member: string | undefined;
      if (ts.isConstructorDeclaration(node)) {
        member = "constructor";
      } else if (
        node.name &&
        (ts.isIdentifier(node.name) ||
          ts.isStringLiteral(node.name) ||
          ts.isPrivateIdentifier(node.name))
      ) {
        member = node.name.text;
      }
      if (member) {
        name = `${node.parent.name.text}.${member}`;
      }
    }
    return name ? `${relative(source.fileName)}#${name}` : undefined;
  }

  function canonical(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    return symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  }
  function symbolAt(expression: ts.Node): ts.Symbol | undefined {
    if (ts.isParenthesizedExpression(expression)) {
      return symbolAt(expression.expression);
    }
    if (ts.isElementAccessExpression(expression)) {
      const key = expression.argumentExpression;
      // Only a literal key selects one property; dynamic indexing stays unresolved.
      return ts.isStringLiteral(key) || ts.isNumericLiteral(key)
        ? canonical(
            checker.getPropertyOfType(checker.getTypeAtLocation(expression.expression), key.text),
          )
        : undefined;
    }
    return canonical(checker.getSymbolAtLocation(expression));
  }
  function target(expression: ts.Expression, kind: CouplingEdge["kind"]): string | undefined {
    const type = checker.getTypeAtLocation(expression);
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
      return undefined;
    }
    const callable = checker.getNonNullableType(type);
    if ((kind === "calls" || kind === "binds") && !callable.getCallSignatures().length) {
      return undefined;
    }
    if (kind === "constructs" && !callable.getConstructSignatures().length) {
      return undefined;
    }
    const declarations = symbolAt(expression)?.getDeclarations();
    return declarations?.length === 1 ? identity(declarations[0]) : undefined;
  }
  function external(expression: ts.Expression): boolean {
    const symbol = checker.getSymbolAtLocation(expression);
    if (
      symbol?.declarations?.some((declaration) => {
        let node: ts.Node = declaration;
        while (!ts.isSourceFile(node)) {
          if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            return (
              externalModule(node.moduleSpecifier.text) ||
              excludedImports.has(`${node.getSourceFile().fileName}#${node.moduleSpecifier.text}`)
            );
          }
          node = node.parent;
        }
        return false;
      })
    ) {
      return true;
    }
    const declarations = canonical(symbol)?.declarations;
    if (
      declarations?.length &&
      declarations.every((declaration) => !ownSource(declaration.getSourceFile()))
    ) {
      return true;
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      return external(expression.expression);
    }
    if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
      return external(expression.expression);
    }
    return false;
  }
  const edges: CouplingEdge[] = [];
  const unresolved: Unresolved[] = [];
  function record(
    node: ts.Node,
    expression: ts.Expression,
    kind: CouplingEdge["kind"],
    owner: string | undefined,
    supported = true,
  ): void {
    if (external(expression)) {
      return;
    }
    const source = node.getSourceFile();
    const site = {
      file: relative(source.fileName),
      line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    };
    const to = supported ? target(expression, kind) : undefined;
    if (owner && to) {
      edges.push({ from: owner, kind, to, site });
    } else {
      unresolved.push({ from: owner ?? site.file, site, kind });
    }
  }
  function sameReceiver(left: ts.Expression, right: ts.Expression | undefined): boolean {
    if (!right) {
      return false;
    }
    if (left.kind === ts.SyntaxKind.ThisKeyword && right.kind === ts.SyntaxKind.ThisKeyword) {
      return true;
    }
    return (
      ts.isIdentifier(left) &&
      ts.isIdentifier(right) &&
      !!symbolAt(left) &&
      symbolAt(left) === symbolAt(right)
    );
  }
  function visit(node: ts.Node, inherited?: string): void {
    const owner = identity(node) ?? inherited;
    if (ts.isCallExpression(node)) {
      const expression = node.expression;
      if (
        ts.isPropertyAccessExpression(expression) &&
        expression.name.text === "bind" &&
        symbolAt(expression)?.declarations?.every((declaration) =>
          program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
        )
      ) {
        const method = expression.expression;
        const supported =
          (ts.isPropertyAccessExpression(method) || ts.isElementAccessExpression(method)) &&
          sameReceiver(method.expression, node.arguments[0]);
        record(node, method, "binds", owner, supported);
      } else {
        record(node, expression, "calls", owner);
      }
    } else if (ts.isNewExpression(node)) {
      record(node, node.expression, "constructs", owner);
    } else if (ts.isClassDeclaration(node)) {
      for (const clause of node.heritageClauses ?? []) {
        if (clause.token === ts.SyntaxKind.ImplementsKeyword) {
          for (const type of clause.types) {
            record(type, type.expression, "implements", owner);
          }
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  }
  for (const file of inputs) {
    const source = program.getSourceFile(file);
    if (!source) {
      throw new Error(`Unable to load coupling source: ${relative(file)}`);
    }
    visit(source);
  }
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  edges.sort(
    (a, b) =>
      compare(a.from, b.from) ||
      compare(a.kind, b.kind) ||
      compare(a.to, b.to) ||
      compare(a.site.file, b.site.file) ||
      a.site.line - b.site.line,
  );
  unresolved.sort(
    (a, b) =>
      compare(a.from, b.from) ||
      compare(a.site.file, b.site.file) ||
      a.site.line - b.site.line ||
      compare(a.kind, b.kind),
  );
  return { edges, unresolved };
}
