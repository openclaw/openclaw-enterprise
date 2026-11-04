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
  "scripts/lib/bootstrap-configuration.mjs",
];

function propertyName(node) {
  if (!node.computed) {
    return node.property.name;
  }
  return node.property.type === "Literal" ? String(node.property.value) : undefined;
}

// An identifier in a property-name position is not a reference to a binding.
function isReference(parent, key) {
  if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) {
    return false;
  }
  if (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent?.type)) {
    return key !== "key" || parent.computed;
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
function environmentReads(source) {
  const reads = [];
  const deny = (node, what) =>
    reads.push(`${node.loc.start.line}:${node.loc.start.column + 1} ${what}`);
  function visit(node, parent, key) {
    if (!node || typeof node.type !== "string") {
      return;
    }
    if (
      [
        "ImportDeclaration",
        "ImportExpression",
        "ExportNamedDeclaration",
        "ExportAllDeclaration",
      ].includes(node.type) &&
      processModule.test(node.source?.value)
    ) {
      deny(node, `import from ${node.source.value}`);
    }
    if (node.type === "Identifier" && isReference(parent, key)) {
      const property =
        parent?.type === "MemberExpression" && key === "object" ? propertyName(parent) : undefined;
      if (node.name === "process" && (property === undefined || property === "env")) {
        deny(node, property === "env" ? "process.env" : "process used as a value");
      }
      if (globalObjects.has(node.name) && (property === undefined || property === "process")) {
        deny(node, `${node.name} used for process`);
      }
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (["comments", "tokens", "loc", "range"].includes(childKey)) {
        continue;
      }
      for (const item of Array.isArray(child) ? child : [child]) {
        visit(item, node, childKey);
      }
    }
  }
  visit(parsers.typescript.parse(source), undefined, undefined);
  return reads;
}

test("API startup and bootstrap configuration read settings only from their env parameter", async () => {
  for (const path of parameterizedSources) {
    const source = await readFile(new URL(`../../${path}`, import.meta.url), "utf8");
    assert.deepEqual(environmentReads(source), [], `${path} must read settings from env`);

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
      const reads = environmentReads(`${source}\n${read}\n`);
      assert.equal(reads.length, 1, `${path} + ${read}: ${reads.join("; ")}`);
      assert.ok(reads[0].endsWith(` ${expected}`), `${path} + ${read}: ${reads[0]}`);
    }
    // A property that is merely named process, and other process members, stay allowed.
    const allowed = "const options = { process: 1 }; options.process; process.exitCode = 1;";
    assert.deepEqual(environmentReads(`${source}\n${allowed}\n`), []);
  }
});

// The compositions take a password hasher only from a code-only dependencies argument after
// their configuration (composeProduction's 2nd, composePostgresDevelopment's 4th). API startup
// must never pass one, so no setting can replace scrypt (postgres-password-default proves the
// compositions ignore a hasher in their configuration).
const compositionArity = { composeProduction: 1, composePostgresDevelopment: 3 };

function compositionCalls(source) {
  const calls = [];
  function visit(node) {
    if (!node || typeof node.type !== "string") {
      return;
    }
    if (node.type === "CallExpression" && Object.hasOwn(compositionArity, node.callee?.name)) {
      calls.push({ name: node.callee.name, arguments: node.arguments.length });
    }
    for (const [key, child] of Object.entries(node)) {
      if (["comments", "tokens", "loc", "range"].includes(key)) {
        continue;
      }
      for (const item of Array.isArray(child) ? child : [child]) {
        visit(item);
      }
    }
  }
  visit(parsers.typescript.parse(source));
  return calls;
}

test("API startup composes without code-only dependencies such as a password hasher", async () => {
  const source = await readFile(
    new URL("../../apps/controller/src/api-startup.mjs", import.meta.url),
    "utf8",
  );
  const calls = compositionCalls(source);
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
    const appended = compositionCalls(`${source}\n${extra}\n`).at(-1);
    assert.ok(appended.arguments > compositionArity[appended.name], extra);
  }
});
