import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript-compiler-api";
import {
  createLoaderAnalysis,
  implicitWrapperSymbol,
  outerExpression,
  unwrap,
} from "./loader-provenance.mjs";
import { assignedSymbols } from "./source-mutations.mjs";
import { freezeRecord, slash, sourceExtension } from "./workspace.mjs";

function normalizedSpecifier(root, value) {
  try {
    if (value.startsWith("file:")) {
      return `file:${slash(relative(root, fileURLToPath(value)))}`;
    }
    if (isAbsolute(value)) {
      return `file:${slash(relative(root, value))}`;
    }
  } catch {
    /* Keep malformed URL text for its resolution diagnostic. */
  }
  return value;
}

/** Parse/bind the snapshot only. Emit import references; make no resolution or policy decisions. */
export function collectSourceImports(snapshot) {
  const texts = new Map(snapshot.files.map((file) => [file.absolutePath, file.text]));
  const options = {
    allowJs: true,
    noResolve: true,
    noLib: true,
    target: ts.ScriptTarget.Latest,
    // Both Node ESM and CommonJS isolate file-local bindings, including files
    // that contain only dynamic imports and no static import/export syntax.
    moduleDetection: ts.ModuleDetectionKind.Force,
  };
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path, languageVersionOrOptions) =>
    texts.has(path)
      ? ts.createSourceFile(path, texts.get(path), languageVersionOrOptions, true)
      : undefined;
  const program = ts.createProgram([...texts.keys()], options, host);
  const checker = program.getTypeChecker();
  const references = [];
  const diagnostics = [];
  for (const file of snapshot.files) {
    const source = program.getSourceFile(file.absolutePath);
    const commonjs = /\.[cm][jt]s$/.test(file.path)
      ? /\.[c][jt]s$/.test(file.path)
      : file.packageType !== "module";
    const assigned = assignedSymbols(source, checker);
    const analysis = createLoaderAnalysis({
      checker,
      path: file.absolutePath,
      commonjs,
      assigned,
      source,
    });
    const printer = ts.createPrinter({ removeComments: true });
    const print = (node) => printer.printNode(ts.EmitHint.Unspecified, node, source);
    const loaderOccurrences = new Map();
    // Include lexical declarations and writes, without exposing source text.
    // Changed loader or path provenance invalidates an old exception. Formatting and
    // line shifts do not. Distinct scopes are included for shadowed bindings.
    function loaderIdentity(call) {
      const pieces = [print(call.expression)];
      for (let parent = call.parent; parent && !ts.isSourceFile(parent); parent = parent.parent) {
        if (ts.isFunctionLike(parent)) {
          pieces.push(
            parent.name ? print(parent.name) : "<anonymous>",
            ...(parent.parameters ?? []).map(print),
          );
        }
      }
      const seen = new Set();
      let visited = 0;
      let wholeSource = false;
      let includeSource = false;
      function trace(node) {
        // Limit transitive traversal. If the limit is reached, bind the exception
        // to the entire normalized source rather than to incomplete provenance.
        if (wholeSource || ++visited > 4096 || seen.size >= 64) {
          wholeSource = true;
          return;
        }
        if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
          let root = unwrap(node.expression);
          while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
            root = unwrap(root.expression);
          }
          if (
            (ts.isIdentifier(root) &&
              (root.text !== "process" ||
                !implicitWrapperSymbol(checker.getSymbolAtLocation(root)) ||
                assigned.unbound.has("process"))) ||
            (!ts.isIdentifier(root) &&
              (!ts.isMetaProperty(root) ||
                root.keywordToken !== ts.SyntaxKind.ImportKeyword ||
                assigned.importMetaMutable ||
                !ts.isPropertyAccessExpression(node) ||
                node.expression !== root ||
                node.name.text !== "url"))
          ) {
            // Object mutation and aliases are not fully modeled, including
            // unbound globals. Bind property reads to the whole source file.
            includeSource = true;
          }
        }
        if (ts.isIdentifier(node)) {
          const symbol = ts.isShorthandPropertyAssignment(node.parent)
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : checker.getSymbolAtLocation(node);
          if (
            implicitWrapperSymbol(symbol) &&
            !(
              (ts.isPropertyAccessExpression(node.parent) ||
                ts.isElementAccessExpression(node.parent)) &&
              node.parent.expression === node
            ) &&
            !(
              (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
              (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
              (ts.isBindingElement(node.parent) && node.parent.propertyName === node) ||
              ts.isMetaProperty(node.parent)
            ) &&
            !(
              node.text === "URL" &&
              ts.isNewExpression(outerExpression(node).parent) &&
              outerExpression(node).parent.expression === outerExpression(node) &&
              !assigned.globalURLMutable &&
              !assigned.unbound.has("URL")
            )
          ) {
            // A bare unbound value may be supplied by source-local mutation.
            includeSource = true;
          }
          const key = symbol ?? node.text;
          if (!seen.has(key)) {
            seen.add(key);
            for (const declaration of symbol?.declarations ?? []) {
              if (declaration.getSourceFile() === source) {
                let importDeclaration = declaration;
                while (importDeclaration && !ts.isSourceFile(importDeclaration)) {
                  if (ts.isImportDeclaration(importDeclaration)) {
                    break;
                  }
                  importDeclaration = importDeclaration.parent;
                }
                let origin =
                  importDeclaration && ts.isImportDeclaration(importDeclaration)
                    ? importDeclaration
                    : declaration;
                if (ts.isParameter(origin)) {
                  // Call arguments are not part of a parameter declaration.
                  includeSource = true;
                }
                if (ts.isBindingElement(origin)) {
                  // A destructured value can also come from local mutation or a
                  // call site outside the declaration. Cover those source edits.
                  includeSource = true;
                  // The binding element alone omits the enclosing initializer.
                  // Walk through nested object/array patterns to its owner.
                  while (
                    ts.isBindingElement(origin) ||
                    ts.isObjectBindingPattern(origin) ||
                    ts.isArrayBindingPattern(origin)
                  ) {
                    origin = origin.parent;
                  }
                  if (!ts.isVariableDeclaration(origin) && !ts.isParameter(origin)) {
                    wholeSource = true;
                    return;
                  }
                  // Parameter arguments and catch values come from elsewhere in
                  // the source, not just the binding declaration.
                  if (ts.isParameter(origin) || ts.isCatchClause(origin.parent)) {
                    wholeSource = true;
                    return;
                  }
                }
                pieces.push(print(origin));
                ts.forEachChild(origin, trace);
                const loop = ts.isVariableDeclaration(origin) && origin.parent?.parent;
                if (loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop))) {
                  pieces.push(print(loop.expression));
                  trace(loop.expression);
                }
              }
            }
            for (const write of assigned.writes.get(key) ?? []) {
              pieces.push(print(write));
              ts.forEachChild(write, trace);
            }
          }
        }
        ts.forEachChild(node, trace);
      }
      trace(call.expression);
      for (const argument of call.arguments) {
        trace(argument);
      }
      if (wholeSource || includeSource) {
        pieces.push("<whole-source>", printer.printFile(source));
      }
      const basis = JSON.stringify([...pieces, print(call)]);
      const occurrence = loaderOccurrences.get(basis) ?? 0;
      loaderOccurrences.set(basis, occurrence + 1);
      return `loader:sha256:${createHash("sha256")
        .update(JSON.stringify([basis, occurrence]))
        .digest("hex")}`;
    }
    const line = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    for (const error of source.parseDiagnostics) {
      diagnostics.push(
        freezeRecord({
          category: "syntax",
          rule: "source-syntax",
          from: file.path,
          to: "",
          specifier: "",
          kind: "syntax",
          typeOnly: false,
          bindings: [],
          line: source.getLineAndCharacterOfPosition(error.start ?? 0).line + 1,
          message: ts.flattenDiagnosticMessageText(error.messageText, " "),
        }),
      );
    }
    function record(
      node,
      kind,
      typeOnly = false,
      bindings = ["*"],
      anchor = file.absolutePath,
      override,
      loaderId,
    ) {
      const argument = analysis.value(node);
      const value = override ?? argument;
      references.push(
        freezeRecord({
          from: file.path,
          specifier:
            argument.status === "known"
              ? normalizedSpecifier(snapshot.root, argument.value)
              : `unknown:sha256:${createHash("sha256").update(node.getText(source)).digest("hex")}`,
          kind,
          typeOnly: typeOnly || source.isDeclarationFile,
          bindings: [...bindings].sort(),
          line: line(node),
          mode: value.mode ?? (kind === "require" ? "require" : "import"),
          anchor: Object.hasOwn(value, "anchor") ? value.anchor : anchor,
          value,
          ...(loaderId ? { loaderIdentity: loaderId } : {}),
        }),
      );
    }
    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const named = clause?.namedBindings;
        const bindings = [
          ...(clause?.name ? [`${clause.isTypeOnly ? "type" : "value"}:default`] : []),
          ...(named && ts.isNamedImports(named)
            ? named.elements.map(
                (item) =>
                  `${clause.isTypeOnly || item.isTypeOnly ? "type" : "value"}:${(item.propertyName ?? item.name).text}`,
              )
            : named
              ? ["*"]
              : []),
        ];
        record(node.moduleSpecifier, "import", clause?.isTypeOnly ?? false, bindings);
        const inlineTypes = bindings.filter((binding) => binding.startsWith("type:"));
        if (!source.isDeclarationFile && !clause?.isTypeOnly && inlineTypes.length) {
          record(node.moduleSpecifier, "import", true, inlineTypes);
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const bindings =
          node.exportClause && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements.map(
                (item) =>
                  `${node.isTypeOnly || item.isTypeOnly ? "type" : "value"}:${(item.propertyName ?? item.name).text}`,
              )
            : ["*"];
        record(node.moduleSpecifier, "export", node.isTypeOnly, bindings);
        const inlineTypes = bindings.filter((binding) => binding.startsWith("type:"));
        if (!source.isDeclarationFile && !node.isTypeOnly && inlineTypes.length) {
          record(node.moduleSpecifier, "export", true, inlineTypes);
        }
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
        record(node.argument.literal, "import-type", true);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference)
      ) {
        record(node.moduleReference.expression, "require", node.isTypeOnly);
      } else if (ts.isCallExpression(node)) {
        const loader = analysis.reference(node.expression);
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0] ?? node;
          const value = analysis.value(argument);
          const uncertain = value.status !== "known" || value.anchor === null;
          record(
            argument,
            "dynamic-import",
            false,
            ["*"],
            file.absolutePath,
            undefined,
            uncertain ? loaderIdentity(node) : undefined,
          );
        } else if (loader?.kind === "require") {
          const argument = node.arguments[0] ?? node;
          const uncertain = loader.anchor === null || analysis.value(argument).status !== "known";
          record(
            argument,
            "require",
            false,
            ["*"],
            loader.anchor,
            undefined,
            uncertain ? loaderIdentity(node) : undefined,
          );
        } else if (loader?.kind === "unknown-loader") {
          record(
            node.arguments[0] ?? node,
            "require",
            false,
            ["*"],
            null,
            { status: "unknown", reason: loader.reason },
            loaderIdentity(node),
          );
        } else if (
          loader?.kind === "builtin" &&
          loader.module === "node:module" &&
          loader.name === "createRequire"
        ) {
          const target = analysis.value(node.arguments[0]);
          if (
            target.value &&
            (target.value.startsWith("file:") || isAbsolute(target.value)) &&
            target.value !== file.absolutePath &&
            target.value !== pathToFileURL(file.absolutePath).href
          ) {
            record(node.arguments[0], "dependency-anchor");
          }
        }
      } else if (ts.isNewExpression(node) && analysis.isURL(node.expression)) {
        const target = analysis.value(node);
        try {
          if (
            target.value?.startsWith("file:") &&
            sourceExtension.test(new URL(target.value).pathname)
          ) {
            record(node, "path");
          }
        } catch {
          /* The containing recognized load reports invalid arguments. */
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return freezeRecord({ references, diagnostics });
}
