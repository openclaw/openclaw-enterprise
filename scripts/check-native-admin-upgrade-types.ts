import { resolve } from "node:path";

import ts from "typescript";

const caller = resolve("tests/conformance/native-admin-upgrade-reset.test.mjs");
const registrar = resolve("tests/conformance/native-admin-upgrade-audit-cases.ts");
const config = ts.getParsedCommandLineOfConfigFile(
  resolve("tests/tsconfig.json"),
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  },
);
if (!config || config.errors.length > 0) {
  throw new Error("Cannot load the test compiler configuration");
}
const options = {
  ...config.options,
  allowJs: true,
  checkJs: true,
  composite: false,
  incremental: false,
  noEmit: true,
};
const registrarSource = ts.sys.readFile(registrar);
if (registrarSource === undefined) {
  throw new Error("Cannot load the audit registrar");
}
const declaration = ts.transpileDeclaration(registrarSource, {
  fileName: registrar,
  compilerOptions: {
    ...config.options,
    allowJs: false,
    isolatedDeclarations: true,
    declaration: true,
    noEmit: false,
  },
  reportDiagnostics: true,
});
if (declaration.diagnostics?.length) {
  throw new Error("Cannot emit the audit registrar declaration");
}

for (const view of ["source", "declaration"] as const) {
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  host.readFile = (file) =>
    view === "declaration" && resolve(file) === registrar ? declaration.outputText : readFile(file);
  const program = ts.createProgram([caller, registrar], options, host);
  const source = program.getSourceFile(caller);
  if (!source) {
    throw new Error("Cannot load the native-admin upgrade caller");
  }
  const expected = new Set([
    "authorize",
    "registerUpgradeShutdownAuditCases",
    "registerRefusedUpgradeAuditCase",
  ]);
  const calls: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (expected.delete(node.expression.text)) {
        calls.push(node);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (expected.size > 0) {
    throw new Error(`Missing native-admin upgrade calls: ${[...expected].join(", ")}`);
  }
  // The legacy parent has unrelated unchecked fixtures; enforce the actual strict boundary calls.
  const diagnostics = program.getSemanticDiagnostics(source).filter((diagnostic) => {
    const start = diagnostic.start;
    return (
      start !== undefined && calls.some((call) => start >= call.getStart() && start < call.end)
    );
  });
  if (diagnostics.length > 0) {
    process.stderr.write(ts.formatDiagnostics(diagnostics, host));
    process.exitCode = 1;
  } else {
    console.log(`Native-admin upgrade ${view} contract: ${calls.length} calls checked`);
  }
}
