import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-compiler-api";

const output =
  process.argv[2] === undefined
    ? fileURLToPath(new URL("./dist/", import.meta.url))
    : resolve(process.argv[2]);
await mkdir(output, { recursive: true });
const compilerOptions: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  rewriteRelativeImportExtensions: true,
  verbatimModuleSyntax: true,
};
for (const name of ["index", "control", "relay", "native"]) {
  const fileName = fileURLToPath(new URL(`./${name}.ts`, import.meta.url));
  const source = await readFile(fileName, "utf8");
  const js = ts.transpileModule(source, { compilerOptions, fileName, reportDiagnostics: true });
  const declarations = ts.transpileDeclaration(source, {
    compilerOptions,
    fileName,
    reportDiagnostics: true,
  });
  const errors = [...(js.diagnostics ?? []), ...(declarations.diagnostics ?? [])];
  if (errors.length) {
    throw new Error(
      ts.formatDiagnosticsWithColorAndContext(errors, {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => "\n",
      }),
    );
  }
  await writeFile(join(output, `${name}.js`), js.outputText);
  await writeFile(join(output, `${name}.d.ts`), declarations.outputText);
}
