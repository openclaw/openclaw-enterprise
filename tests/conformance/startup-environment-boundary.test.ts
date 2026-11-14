import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parsers } from "prettier/plugins/typescript";

// API startup and the initialization Job's settings take their environment as a
// parameter: server.mjs and scripts/bootstrap-installation.mjs pass process.env,
// and the sign-in parity tests run the same code in process with their own
// environment. A process.env read in these files would make those tests check
// the test runner's environment instead of the one they pass, so an edit ported
// from server.mjs or scripts/bootstrap-installation.mjs must read `env`.
const parameterizedSources = [
  "apps/controller/src/api-startup.mjs",
  "scripts/lib/bootstrap-configuration.ts",
];

type AstNode = Record<string, unknown> & { type: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAstNode(value: unknown): value is AstNode {
  return isRecord(value) && typeof value.type === "string";
}

async function parseSource(source: string): Promise<unknown> {
  const parser = parsers.typescript;
  // Supply the parser contract directly so dependency changes remain type-checked.
  return await parser.parse(source, {
    parser: "typescript",
    filepath: "startup.ts",
    originalText: source,
    locStart: parser.locStart,
    locEnd: parser.locEnd,
    printWidth: 80,
    tabWidth: 2,
    semi: true,
    singleQuote: false,
    jsxSingleQuote: false,
    trailingComma: "all",
    bracketSpacing: true,
    objectWrap: "preserve",
    bracketSameLine: false,
    rangeStart: 0,
    rangeEnd: Number.POSITIVE_INFINITY,
    requirePragma: false,
    insertPragma: false,
    checkIgnorePragma: false,
    proseWrap: "preserve",
    arrowParens: "always",
    plugins: [],
    htmlWhitespaceSensitivity: "css",
    endOfLine: "lf",
    quoteProps: "as-needed",
    vueIndentScriptAndStyle: false,
    embeddedLanguageFormatting: "auto",
    singleAttributePerLine: false,
    experimentalOperatorPosition: "start",
    experimentalTernaries: false,
  });
}

function propertyName(node: AstNode): string | undefined {
  const property = node.property;
  if (!isAstNode(property)) {
    return undefined;
  }
  if (!node.computed) {
    return typeof property.name === "string" ? property.name : undefined;
  }
  return property.type === "Literal" ? String(property.value) : undefined;
}

// An identifier in a property-name position is not a reference to a binding.
function isReference(parent: AstNode | undefined, key: string | undefined): boolean {
  if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) {
    return false;
  }
  if (parent && ["Property", "MethodDefinition", "PropertyDefinition"].includes(parent.type)) {
    return key !== "key" || Boolean(parent.computed);
  }
  return key !== "id" && key !== "label";
}

const processModule = /^(node:)?process$/;
const globalObjects = new Set(["globalThis", "global"]);

// Returns "line:column what" for each way the source reaches process.env: a
// process.env member read, process used as a value (destructuring, aliasing or a
// computed member that cannot be named), process reached through globalThis, or
// an import of the process module. process.exitCode, process.once and the like
// stay allowed.
async function environmentReads(source: string): Promise<string[]> {
  const reads: string[] = [];
  const deny = (node: AstNode, what: string): void => {
    const loc = node.loc;
    assert.ok(isRecord(loc) && isRecord(loc.start));
    const { line, column } = loc.start;
    assert.ok(typeof line === "number");
    assert.ok(typeof column === "number");
    reads.push(`${line}:${column + 1} ${what}`);
  };
  function visit(node: unknown, parent?: AstNode, key?: string): void {
    if (!isAstNode(node)) {
      return;
    }
    if (
      [
        "ImportDeclaration",
        "ImportExpression",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
      ].includes(node.type) &&
      isRecord(node.source) &&
      typeof node.source.value === "string" &&
      processModule.test(node.source.value)
    ) {
      deny(node, `import from ${node.source.value}`);
    }
    if (node.type === "Identifier" && isReference(parent, key)) {
      const property =
        parent?.type === "MemberExpression" && key === "object" ? propertyName(parent) : undefined;
      if (node.name === "process" && (property === undefined || property === "env")) {
        deny(node, property === "env" ? "process.env" : "process used as a value");
      }
      if (
        typeof node.name === "string" &&
        globalObjects.has(node.name) &&
        (property === undefined || property === "process")
      ) {
        deny(node, `${node.name} used for process`);
      }
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (["comments", "tokens", "loc", "range"].includes(childKey)) {
        continue;
      }
      const children: readonly unknown[] = Array.isArray(child) ? child : [child];
      for (const item of children) {
        visit(item, node, childKey);
      }
    }
  }
  visit(await parseSource(source));
  return reads;
}

test("API startup and bootstrap configuration read settings only from their env parameter", async () => {
  for (const path of parameterizedSources) {
    const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
    assert.deepEqual(await environmentReads(source), [], `${path} must read settings from env`);

    // Each way back to the process environment is caught when appended to the
    // real file; the comments that mention process.env are not.
    for (const [read, expected] of [
      ["process.env.OCC_CONSOLE_THEME_DIR;", "process.env"],
      ['process["env"].OCC_HOST;', "process.env"],
      ["const { env: ambient } = process;", "process used as a value"],
      ["const key = 'env'; process[key];", "process used as a value"],
      ["globalThis.process.env.OCC_HOST;", "globalThis used for process"],
      ["const { process: ambient } = globalThis;", "globalThis used for process"],
      ['import { env as ambient } from "node:process";', "import from node:process"],
      ['await import("node:process");', "import from node:process"],
    ]) {
      const reads = await environmentReads(`${source}\n${read}\n`);
      assert.equal(reads.length, 1, `${path} + ${read}: ${reads.join("; ")}`);
      assert.ok(reads[0]?.endsWith(` ${expected}`), `${path} + ${read}: ${reads[0]}`);
    }
    // A property that is merely named process, and other process members, stay allowed.
    const allowed = "const options = { process: 1 }; options.process; process.exitCode = 1;";
    assert.deepEqual(await environmentReads(`${source}\n${allowed}\n`), []);
  }
});

// The compositions take a password hasher only from a code-only dependencies argument after
// their configuration (composeProduction's 2nd, composePostgresDevelopment's 4th). API startup
// must never pass one, so no setting can replace scrypt (postgres-password-default proves the
// compositions ignore a hasher in their configuration).
const compositionArity = { composeProduction: 1, composePostgresDevelopment: 3 };

type CompositionName = keyof typeof compositionArity;

function isCompositionName(name: unknown): name is CompositionName {
  return typeof name === "string" && Object.hasOwn(compositionArity, name);
}

async function compositionCalls(
  source: string,
): Promise<{ name: CompositionName; arguments: number }[]> {
  const calls: { name: CompositionName; arguments: number }[] = [];
  function visit(node: unknown): void {
    if (!isAstNode(node)) {
      return;
    }
    if (
      node.type === "CallExpression" &&
      isRecord(node.callee) &&
      isCompositionName(node.callee.name)
    ) {
      assert.ok(Array.isArray(node.arguments));
      calls.push({ name: node.callee.name, arguments: node.arguments.length });
    }
    for (const [key, child] of Object.entries(node)) {
      if (["comments", "tokens", "loc", "range"].includes(key)) {
        continue;
      }
      const children: readonly unknown[] = Array.isArray(child) ? child : [child];
      for (const item of children) {
        visit(item);
      }
    }
  }
  visit(await parseSource(source));
  return calls;
}

test("API startup composes without code-only dependencies such as a password hasher", async () => {
  const source = await readFile(
    new URL("../../apps/controller/src/api-startup.mjs", import.meta.url),
    "utf8",
  );
  const calls = await compositionCalls(source);
  assert.deepEqual([...new Set(calls.map(({ name }) => name))].sort(), [
    "composePostgresDevelopment",
    "composeProduction",
  ]);
  for (const call of calls) {
    assert.ok(call.arguments <= compositionArity[call.name], `${call.name}: ${call.arguments}`);
  }
  // Passing the dependencies argument is caught when appended to the real file.
  for (const extra of [
    "composeProduction(config, { passwordHasher });",
    "composePostgresDevelopment(settings, drivers, factory, { passwordHasher });",
  ]) {
    const appended = (await compositionCalls(`${source}\n${extra}\n`)).at(-1);
    assert.ok(appended && appended.arguments > compositionArity[appended.name], extra);
  }
});
