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
// The paired registration bundles the fixed-repository sender from ../git under dist/git.
await mkdir(join(output, "git"), { recursive: true });
for (const name of [
  "index",
  "control",
  "relay",
  "native",
  "protected",
  "../git/index",
  "../git/protocol",
]) {
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
  const target = name.startsWith("../git/") ? name.slice(3) : name;
  const local = (text: string) => text.replaceAll('from "../git/', 'from "./git/');
  await writeFile(join(output, `${target}.js`), local(js.outputText));
  await writeFile(join(output, `${target}.d.ts`), local(declarations.outputText));
}
