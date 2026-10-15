import ts from "typescript-compiler-api";
import { implicitWrapperSymbol, outerExpression, unwrap } from "./loader-provenance.mjs";

export function assignedSymbols(source, checker) {
  const symbols = new Set();
  const unbound = new Set();
  const writes = new Map();
  const objectWrites = new Set();
  const objectWriteNodes = new Set();
  let importMetaMutable = false;
  let globalURLMutable = false;
  function containsImportMeta(node) {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      return true;
    }
    return ts.forEachChild(node, containsImportMeta) ?? false;
  }
  function mark(node, symbol, write) {
    symbols.add(symbol);
    const key = symbol ?? node.text;
    writes.set(key, [...(writes.get(key) ?? []), write]);
    if (
      implicitWrapperSymbol(symbol) &&
      ["require", "module", "__dirname", "__filename", "URL", "process"].includes(node.text)
    ) {
      unbound.add(node.text);
    }
  }
  function assign(node, write) {
    node = unwrap(node);
    if (ts.isIdentifier(node)) {
      mark(node, checker.getSymbolAtLocation(node), write);
    } else if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const base = unwrap(node.expression);
      let root = base;
      while (root && (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root))) {
        root = unwrap(root.expression);
      }
      if (root) {
        objectWriteNodes.add(root);
        if (ts.isIdentifier(root)) {
          objectWrites.add(checker.getSymbolAtLocation(root) ?? root.text);
        }
      }
      if (
        root &&
        ts.isIdentifier(root) &&
        root.text === "process" &&
        implicitWrapperSymbol(checker.getSymbolAtLocation(root))
      ) {
        unbound.add("process");
      }
      const baseSymbol = base && checker.getSymbolAtLocation(base);
      const property = ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isStringLiteralLike(node.argumentExpression)
          ? node.argumentExpression.text
          : null;
      if (
        base &&
        ts.isIdentifier(base) &&
        base.text === "module" &&
        implicitWrapperSymbol(baseSymbol) &&
        (property === null || property === "require")
      ) {
        unbound.add("module.require");
        mark(base, baseSymbol, write);
      }
      if (
        base &&
        ts.isIdentifier(base) &&
        base.text === "require" &&
        implicitWrapperSymbol(baseSymbol) &&
        (property === null || property === "resolve")
      ) {
        unbound.add("require.resolve");
      }
    } else if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
      ts.forEachChild(node, (child) => assign(child, write));
    } else if (ts.isPropertyAssignment(node)) {
      assign(node.initializer, write);
    } else if (ts.isShorthandPropertyAssignment(node)) {
      mark(node.name, checker.getShorthandAssignmentValueSymbol(node), write);
    } else if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
      assign(node.expression, write);
    }
  }
  function processObject(input) {
    let value = unwrap(input);
    let depth = 0;
    while (value && (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value))) {
      depth++;
      value = unwrap(value.expression);
    }
    const symbol =
      value && ts.isShorthandPropertyAssignment(value.parent)
        ? checker.getShorthandAssignmentValueSymbol(value.parent)
        : value && checker.getSymbolAtLocation(value);
    return (
      value &&
      ts.isIdentifier(value) &&
      value.text === "process" &&
      depth <= 1 &&
      implicitWrapperSymbol(symbol)
    );
  }
  function directProcessRead(node) {
    const value = outerExpression(node);
    const parent = value.parent;
    if (
      !(ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) ||
      parent.expression !== value
    ) {
      return false;
    }
    if (ts.isIdentifier(node)) {
      return true;
    }
    const member = outerExpression(parent);
    if (ts.isCallExpression(member.parent) && member.parent.expression === member) {
      return false;
    }
    const property = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : null;
    const key = ts.isPropertyAccessExpression(parent)
      ? parent.name.text
      : ts.isStringLiteralLike(parent.argumentExpression)
        ? parent.argumentExpression.text
        : null;
    return property === "env" && key !== null && !["__proto__", "constructor"].includes(key);
  }
  function visit(node) {
    const propertyName =
      node.parent &&
      ((ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) ||
        (ts.isPropertyAssignment(node.parent) && node.parent.name === node) ||
        (ts.isBindingElement(node.parent) && node.parent.propertyName === node));
    const valueSymbol =
      node.parent && ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
    if (
      ts.isIdentifier(node) &&
      !propertyName &&
      ["globalThis", "global"].includes(node.text) &&
      implicitWrapperSymbol(valueSymbol)
    ) {
      // Either Node global object alias can expose or replace builtins and env.
      globalURLMutable = true;
      unbound.add("process");
    }
    if (
      ts.isIdentifier(node) &&
      !propertyName &&
      node.text === "URL" &&
      implicitWrapperSymbol(valueSymbol) &&
      !(
        ts.isNewExpression(outerExpression(node).parent) &&
        outerExpression(node).parent.expression === outerExpression(node)
      )
    ) {
      // Aliases and other uses can expose the mutable global constructor.
      globalURLMutable = true;
    }
    if (
      (ts.isIdentifier(node) ||
        ts.isPropertyAccessExpression(node) ||
        ts.isElementAccessExpression(node)) &&
      !propertyName &&
      processObject(node) &&
      !directProcessRead(node)
    ) {
      // An exposed process object can mutate env through an alias. Keep the
      // stable shortcut only for direct reads of individual env values.
      unbound.add("process");
    }
    if (
      ts.isMetaProperty(node) &&
      node.keywordToken === ts.SyntaxKind.ImportKeyword &&
      !(
        ts.isPropertyAccessExpression(node.parent) &&
        node.parent.expression === node &&
        node.parent.name.text === "url"
      )
    ) {
      // A bare or other property use can expose or change import.meta.
      importMetaMutable = true;
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
    ) {
      if (containsImportMeta(node.left)) {
        importMetaMutable = true;
      }
      assign(node.left, node);
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
    ) {
      if (containsImportMeta(node.operand)) {
        importMetaMutable = true;
      }
      assign(node.operand, node);
    }
    if (ts.isDeleteExpression(node)) {
      if (containsImportMeta(node.expression)) {
        importMetaMutable = true;
      }
      assign(node.expression, node);
    }
    if (
      (ts.isForOfStatement(node) || ts.isForInStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      if (containsImportMeta(node.initializer)) {
        importMetaMutable = true;
      }
      assign(node.initializer, node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return {
    symbols,
    unbound,
    writes,
    objectWrites,
    objectWriteNodes,
    importMetaMutable,
    globalURLMutable,
  };
}
