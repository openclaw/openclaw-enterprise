import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { availableParallelism } from "node:os";
import { dirname, join, relative, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, test } from "node:test";
import ts from "typescript-compiler-api";
import {
  runModuleBoundaryCli,
  verifyModuleBoundaries,
} from "../../scripts/verify-module-boundaries.mjs";
import { settled as settle } from "../helpers/child-processes.mjs";
import { temporaryDirectory } from "../helpers/temporary-directory.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const fixture = new URL("../fixtures/module-boundaries/", import.meta.url);
const execute = promisify(execFile);
const cli = join(repository, "scripts/verify-module-boundaries.mjs");
const policy = JSON.parse(await readFile(new URL("policy.json", fixture), "utf8"));

// Child processes (CLI runs and native Node oracles) are most of this file's
// cost. Tests run concurrently and share one cap of a child per CPU.
const slots = availableParallelism();
const waiting = [];
let active = 0;
async function node(args, options) {
  while (active >= slots) {
    await new Promise((resolve) => waiting.push(resolve));
  }
  active += 1;
  try {
    return await execute(process.execPath, args, options);
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

// Runs the CLI in this process. Like a child run, it resolves to { stdout, stderr } on exit
// 0 and otherwise rejects with an error carrying the exit `code`, `stdout` and `stderr`.
// Real child runs stay where the process matters: exit statuses and stream output in
// "requires explicit valid policy...", an unreadable policy file, an unknown option,
// NODE_PATH, and tests that resolve with Node in this process before running the CLI (its
// resolution caches).
async function cliInProcess(args) {
  let stdout = "";
  let stderr = "";
  const code = await runModuleBoundaryCli(args, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  if (code !== 0) {
    throw Object.assign(new Error(`module boundary CLI exited with ${code}`), {
      code,
      stdout,
      stderr,
    });
  }
  return { stdout, stderr };
}

// Awaits a rejected child run, requires exit `code`, and returns the error.
async function failure(promise, code) {
  let caught;
  await assert.rejects(promise, (error) => {
    caught = error;
    return true;
  });
  assert.equal(caught.code, code, caught.stderr);
  return caught;
}

const dynamic = "unresolved-dynamic-import";
const rules = (report) => report.violations.map((item) => item.rule).sort();
const from = (report, path) => report.edges.filter((edge) => edge.from === path);
// The report's violation of `rule` from `path`, if any.
const violation = (report, path, rule = dynamic) =>
  report.violations.find((item) => item.from === path && item.rule === rule);
const violates = (report, path, rule = dynamic) => Boolean(violation(report, path, rule));
const reaches = (report, path, to) => from(report, path).some((edge) => edge.to === to);
// A reviewed exception document accepting exactly `items`.
const exceptionsFor = (...items) => ({
  version: 1,
  exceptions: items.map((item) => ({
    ...item,
    owner: "fixture",
    reason: "reviewed",
    removeWhen: "fixed",
  })),
});
// A caller boundary that forbids `sources` from loading apps/app/src/private.
const noPrivate = (sources, extra = {}) => ({
  rule: "no-private",
  from: [sources].flat(),
  to: ["apps/app/src/private/**"],
  message: "No private imports.",
  ...extra,
});

async function workspace(t, overrides = {}) {
  const root = await realpath(await temporaryDirectory(t, "module-boundaries-"));
  await cp(fixture, root, { recursive: true });
  const config = { ...policy, ...overrides };
  const write = async (path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write("policy.json", JSON.stringify(config));
  const args = ["--root", root, "--policy", join(root, "policy.json")];
  const check = (extra = {}) => verifyModuleBoundaries({ root, policy: config, ...extra });
  // Node's own output for running a workspace source: the independent oracle.
  const native = async (path, options) => (await node([join(root, path)], options)).stdout.trim();
  // Writes `code`, requires Node to print `output`, and returns the analyzer report.
  const observe = async (path, code, output, options) => {
    await write(path, code);
    assert.equal(await native(path, options), output, code);
    return check();
  };
  return {
    root,
    write,
    args,
    check,
    native,
    observe,
    // Reviews the source's unknown loader and keeps its exception valid across a line shift.
    reviewLoader: async (path, report) => {
      const item = violation(report ?? (await check()), path);
      assert.ok(item);
      const exceptions = exceptionsFor(item);
      assert.equal((await check({ exceptions })).ok, true);
      await write(path, "\n\n" + (await readFile(join(root, path), "utf8")));
      assert.equal((await check({ exceptions })).ok, true, "line shifts retain the identity");
      return { item, exceptions };
    },
    cli: (extra = []) => cliInProcess([...args, ...extra]),
    // A real child, for exit statuses, streams, env and Node's per-process caches.
    cliProcess: (extra = [], options) => node([cli, ...args, ...extra], options),
    // Installs a workspace package directory at `at`, as a package manager would.
    link: async (path = "packages/library", at = "node_modules/@fixture/library") => {
      await mkdir(dirname(join(root, at)), { recursive: true });
      await symlink(join(root, path), join(root, at), "dir");
    },
    // Adds or replaces entries in the library manifest's exports.
    exports: async (entries) => {
      const path = join(root, "packages/library/package.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      await writeFile(
        path,
        JSON.stringify({ ...manifest, exports: { ...manifest.exports, ...entries } }),
      );
    },
    // Writes a PUBLIC and a PRIVATE module of each name under public/ and private/.
    decoys: (...names) =>
      Promise.all(
        names.flatMap((name) =>
          ["public", "private"].map((side) => {
            const value = JSON.stringify(side.toUpperCase());
            const body = name.endsWith(".cjs")
              ? `module.exports = ${value};`
              : `export default ${value};`;
            return write(`apps/app/src/${side}/${name}`, body);
          }),
        ),
      ),
    // Empty createRequire anchors under each of `sides` (public, private).
    anchors: (...sides) =>
      Promise.all(sides.map((side) => write(`apps/app/src/${side}/anchor.cjs`, ""))),
    // Node loads the private module; the analyzer must report an unknown load
    // and, when `avoid` is given, must not claim the public edge.
    closed: async (path, code, { output = "PRIVATE", avoid, options } = {}) => {
      const report = await observe(path, code, output, options);
      assert.ok(violates(report, path), code);
      if (avoid) {
        assert.equal(reaches(report, path, avoid), false, code);
      }
      return report;
    },
    // Node loads the public module, and the analyzer keeps that known edge.
    open: async (path, code, { to, output = "PUBLIC" }) => {
      const report = await observe(path, code, output);
      assert.ok(reaches(report, path, to), code);
      return report;
    },
  };
}

describe("module boundaries", { concurrency: true }, () => {
  test("keeps native package error diagnostics independent of the workspace path", async (t) => {
    const { root, write, cli: verify, link } = await workspace(t);
    await link();
    await write("apps/app/src/blocked.cjs", 'require("@fixture/library/blocked");');
    const [json, text, missing] = await settle([
      failure(verify(["--json"]), 1),
      failure(verify(), 1),
      failure(node([cli, "--root", root, "--policy", "missing.json"]), 2),
    ]);
    const item = JSON.parse(json.stdout).violations.find(
      (entry) => entry.from === "apps/app/src/blocked.cjs",
    );
    assert.equal(item.rule, "unsupported-package-export");
    assert.equal(json.stdout.includes(root), false);
    assert.match(item.message, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
    assert.match(text.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
    assert.equal((text.stdout + text.stderr).includes(root), false);
    assert.match(missing.stderr, /ENOENT/);
    assert.equal(missing.stderr.includes(root), false);
  });

  test("keeps malformed JSON content and paths out of text and JSON CLI diagnostics", async (t) => {
    const marker = "/x_path/5";
    // One workspace per malformed file, each checked through text and JSON output.
    const cases = [
      [
        "bad-policy.json",
        ({ root }) => ["--root", root, "--policy", join(root, "bad-policy.json")],
      ],
      [
        "bad-exceptions.json",
        ({ root, args }) => [...args, "--exceptions", join(root, "bad-exceptions.json")],
      ],
      ["packages/library/package.json", ({ args }) => args],
      ["apps/app/src/package.json", ({ args }) => args],
    ];
    await settle(
      cases.map(async ([path, options]) => {
        const space = await workspace(t);
        await space.write(path, marker);
        for (const error of await settle(
          [[], ["--json"]].map((json) => failure(cliInProcess([...options(space), ...json]), 2)),
        )) {
          const output = error.stdout + error.stderr;
          assert.match(output, /Invalid JSON/);
          assert.equal(output.includes(marker), false);
          assert.equal(output.includes(space.root), false);
        }
      }),
    );
  });

  test("uses Node ESM lookup without CommonJS global search paths", async (t) => {
    const { root, write, cliProcess: verify } = await workspace(t);
    const global = join(root, "global-modules");
    await write(
      "global-modules/@fixture/library/package.json",
      JSON.stringify({ name: "@fixture/library", exports: { "./leaf": "./leaf.cjs" } }),
    );
    await write("global-modules/@fixture/library/leaf.cjs", "module.exports = 1;");
    await write("apps/app/src/global-esm.mjs", 'import "@fixture/library/leaf";');
    await write("apps/app/src/global-require.cjs", 'require("@fixture/library/leaf");');
    const env = { ...process.env, NODE_PATH: global };
    const script = `
      import { createRequire } from "node:module";
      let esm; try { esm = import.meta.resolve("@fixture/library/leaf"); } catch (error) { esm = error.code; }
      console.log(JSON.stringify({ esm, cjs: createRequire(import.meta.url).resolve("@fixture/library/leaf") }));
    `;
    const [oracle, normal, error] = await settle([
      node(["--input-type=module", "-e", script], { cwd: join(root, "apps/app/src"), env }),
      verify(["--json"], { env: { ...process.env, NODE_PATH: "" } }),
      failure(verify(["--json"], { env }), 1),
    ]);
    const native = JSON.parse(oracle.stdout);
    assert.equal(native.esm, "ERR_MODULE_NOT_FOUND");
    assert.ok(native.cjs.startsWith(global));
    assert.equal(JSON.parse(normal.stdout).ok, true);
    const report = JSON.parse(error.stdout);
    assert.equal(
      report.violations.some((item) => item.from === "apps/app/src/global-esm.mjs"),
      false,
    );
    assert.ok(violates(report, "apps/app/src/global-require.cjs", "workspace-package-mismatch"));
  });

  test("fails closed when the selected declaration is outside the source graph", async (t) => {
    const source = "apps/app/src/private-type.ts";
    const boundary = {
      rule: "forbid-hidden-type",
      from: [source],
      to: ["packages/library/types/**"],
      message: "Use the public type.",
    };
    const { root, write, check, link, exports } = await workspace(t, { boundaries: [boundary] });
    await write("packages/library/types/hidden.d.ts", "export interface Private { value: string }");
    await write("packages/library/src/safe.mjs", "export const safe = true;");
    await exports({ "./private-type": { types: "./types/hidden.d.ts", import: "./src/safe.mjs" } });
    await link();
    await write(
      source,
      'import type { Private } from "@fixture/library/private-type"; export type Result = Private;',
    );
    const native = ts.resolveModuleName(
      "@fixture/library/private-type",
      join(root, source),
      { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext },
      ts.sys,
      undefined,
      undefined,
      ts.ModuleKind.ESNext,
    ).resolvedModule?.resolvedFileName;
    assert.equal(relative(root, native), "packages/library/types/hidden.d.ts");
    const excluded = await check();
    assert.equal(excluded.ok, false);
    assert.ok(violates(excluded, source, "unresolved-local-import"));
    assert.equal(
      excluded.resolutions.find((item) => item.reference.from === source).to,
      "packages/library/types/hidden.d.ts",
    );
    assert.equal(reaches(excluded, source, "packages/library/src/safe.mjs"), false);
    const included = await check({
      policy: {
        ...policy,
        sourceRoots: [...policy.sourceRoots, "packages/library/types"],
        boundaries: [boundary],
      },
    });
    assert.ok(
      included.violations.some(
        (item) =>
          item.from === source &&
          item.to === "packages/library/types/hidden.d.ts" &&
          item.rule === "forbid-hidden-type",
      ),
    );
  });

  test("checks declaration edges in mixed imports and exports without losing runtime edges", async (t) => {
    const sources = ["apps/app/src/mixed-import.ts", "apps/app/src/mixed-export.ts"];
    const boundary = {
      rule: "forbid-hidden-type",
      from: sources,
      to: ["packages/library/types/**"],
      message: "Use the public type.",
    };
    const { write, check, link, exports } = await workspace(t, { boundaries: [boundary] });
    await write(
      "packages/library/types/hidden.d.ts",
      'export declare const safe: boolean; export interface Private {} import type { Marker } from "../../../apps/app/src/mixed-import.ts";',
    );
    await write("packages/library/src/safe.mjs", "export const safe = true;");
    await exports({ "./mixed": { types: "./types/hidden.d.ts", import: "./src/safe.mjs" } });
    await link();
    await write(
      sources[0],
      'import { safe, type Private } from "@fixture/library/mixed"; export interface Marker { value: Private }; export { safe };',
    );
    await write(sources[1], 'export { safe, type Private } from "@fixture/library/mixed";');
    const runtime = (report, source) =>
      from(report, source).some(
        (item) => !item.typeOnly && item.to === "packages/library/src/safe.mjs",
      );
    const typeViolation = (report, source, rule) =>
      report.violations.some((item) => item.from === source && item.typeOnly && item.rule === rule);
    const excluded = await check();
    for (const source of sources) {
      assert.ok(typeViolation(excluded, source, "unresolved-local-import"));
      assert.ok(runtime(excluded, source));
    }
    const included = await check({
      policy: {
        ...policy,
        sourceRoots: [...policy.sourceRoots, "packages/library/types"],
        boundaries: [boundary],
        cycles: { runtime: "report", typeOnly: "error" },
      },
    });
    for (const source of sources) {
      assert.ok(typeViolation(included, source, "forbid-hidden-type"));
      assert.ok(runtime(included, source));
      assert.ok(
        from(included, source).some(
          (item) =>
            item.typeOnly &&
            item.to === "packages/library/types/hidden.d.ts" &&
            item.bindings.includes("type:Private"),
        ),
      );
    }
    assert.ok(
      included.typeOnlyCycles.some(
        (group) =>
          group.includes(sources[0]) && group.includes("packages/library/types/hidden.d.ts"),
      ),
    );
    assert.ok(included.violations.some((item) => item.rule === "type-only-cycle"));
    assert.match(
      stripTypeScriptTypes('import { type Private } from "./x.ts";'),
      /import\s*\{\s*\}\s*from/,
    );
    assert.match(
      stripTypeScriptTypes('export { type Private } from "./x.ts";'),
      /export\s*\{\s*\}\s*from/,
    );
  });

  test("gives Node builtins precedence over registered package names and still checks specifier rules", async (t) => {
    const boundary = {
      rule: "block-specific-builtins",
      from: ["apps/app/src/**"],
      specifiers: ["path", "node:path/posix"],
      message: "Blocked by caller policy.",
    };
    const { root, write, check } = await workspace(t, {
      packages: [...policy.packages, "packages/builtin-path", "packages/builtin-fs"],
      boundaries: [boundary],
    });
    await write(
      "packages/builtin-path/package.json",
      JSON.stringify({
        name: "path",
        type: "module",
        exports: { ".": "./src/index.mjs", "./posix": "./src/index.mjs" },
      }),
    );
    await write("packages/builtin-path/src/index.mjs", "export default 1;");
    await write(
      "packages/builtin-fs/package.json",
      JSON.stringify({ name: "fs", type: "module", exports: { "./promises": "./src/index.mjs" } }),
    );
    await write("packages/builtin-fs/src/index.mjs", "export default 1;");
    const names = [
      "path",
      "path/posix",
      "node:path",
      "node:path/posix",
      "fs/promises",
      "node:fs/promises",
    ];
    await write("apps/app/src/builtins.mjs", names.map((name) => `import "${name}";`).join("\n"));
    await write("apps/app/src/builtins.cjs", names.map((name) => `require("${name}");`).join("\n"));
    const oracle = await node(
      [
        "--input-type=module",
        "-e",
        `
      import { createRequire } from "node:module";
      const require = createRequire(import.meta.url);
      const names = ${JSON.stringify(names)};
      console.log(JSON.stringify(names.map((name) => [import.meta.resolve(name), require.resolve(name)])));
    `,
      ],
      { cwd: join(root, "apps/app/src") },
    );
    const native = JSON.parse(oracle.stdout);
    for (const [index, name] of names.entries()) {
      assert.equal(native[index][0], name.startsWith("node:") ? name : `node:${name}`);
      assert.equal(native[index][1], name);
    }
    const report = await check();
    for (const source of ["apps/app/src/builtins.mjs", "apps/app/src/builtins.cjs"]) {
      const resolutions = report.resolutions.filter((item) => item.reference.from === source);
      assert.equal(resolutions.length, names.length);
      assert.ok(resolutions.every((item) => item.status === "external"));
      assert.equal(from(report, source).length, 0);
      assert.deepEqual(
        report.violations
          .filter((item) => item.from === source)
          .map((item) => item.specifier)
          .sort(),
        ["node:path/posix", "path"],
      );
    }
  });

  test("fails closed when modeled Node helpers are changed or exposed", async (t) => {
    const source = "apps/app/src/public/mutable-helper.cjs";
    const esm = "apps/app/src/public/mutable-url.mjs";
    const publicCjs = "apps/app/src/public/chosen.cjs";
    const publicEsm = "apps/app/src/public/chosen.mjs";
    // The CommonJS and ESM halves use separate workspaces (one source each) and run concurrently.
    const space = () => workspace(t, { boundaries: [noPrivate("apps/app/src/public/**")] });
    const commonjs = async () => {
      const { decoys, closed, open } = await space();
      await decoys("chosen.cjs", "chosen.mjs");
      const viaJoin = 'console.log(require(path.join(__dirname, "chosen.cjs")));';
      for (const setup of [
        'path.join = () => __dirname + "/../private/chosen.cjs";',
        'path["join"] = () => __dirname + "/../private/chosen.cjs";',
        'const alias = path; alias.join = () => __dirname + "/../private/chosen.cjs";',
        'const alias = path.posix; alias.join = () => __dirname + "/../private/chosen.cjs";',
        'const {posix: alias} = path; alias["join"] = () => __dirname + "/../private/chosen.cjs";',
        'Object.assign(path.posix, {join: () => __dirname + "/../private/chosen.cjs"});',
        'Object.assign(path, {join: () => __dirname + "/../private/chosen.cjs"});',
        '({ join: path.join } = {join: () => __dirname + "/../private/chosen.cjs"});',
        'Object.defineProperty(path, "join", {value: () => __dirname + "/../private/chosen.cjs"});',
      ]) {
        await closed(source, `const path = require("node:path"); ${setup}\n${viaJoin}`, {
          avoid: publicCjs,
        });
      }
      const viaResolve = 'console.log(require(require.resolve("./chosen.cjs")));';
      const viaFactory =
        'const load = mod.createRequire(__filename); console.log(load("./chosen.cjs"));';
      for (const code of [
        `require.resolve = () => __dirname + "/../private/chosen.cjs"; ${viaResolve}`,
        `require["resolve"] = () => __dirname + "/../private/chosen.cjs"; ${viaResolve}`,
        `const alias = require; alias.resolve = () => __dirname + "/../private/chosen.cjs"; ${viaResolve}`,
        `Object.assign(require, {resolve: () => __dirname + "/../private/chosen.cjs"}); ${viaResolve}`,
        `const mod = require("node:module");
       const factory = mod.createRequire;
       mod.createRequire = () => factory(__dirname + "/../private/anchor.cjs");
       ${viaFactory}`,
        `const mod = require("node:module");
       const alias = mod.Module;
       alias.createRequire = () => (name) => process.mainModule.require(name.replace("chosen.cjs", "../private/chosen.cjs"));
       ${viaFactory}`,
      ]) {
        await closed(source, code);
      }
      await open(
        source,
        'const path = require("node:path"); const alias = path.posix; console.log(require(alias.join(__dirname, "chosen.cjs")));',
        { to: publicCjs },
      );
      for (const [setup, callee] of [
        ['const path = require("node:path"); const load = (path.join);', "load"],
        ['const {join} = require("node:path"); const load = (join);', "load"],
        ['const path = require("node:path");', "(path.join)"],
        ['const {join} = require("node:path");', "(join)"],
      ]) {
        await open(source, `${setup} console.log(require(${callee}(__dirname, "chosen.cjs")));`, {
          to: publicCjs,
        });
      }
      await closed(
        source,
        `const path = require("node:path");
       path.join = () => __dirname + "/../private/chosen.cjs";
       console.log(require((path.join)(__dirname, "chosen.cjs")));`,
      );
    };
    const modules = async () => {
      const { decoys, closed, open } = await space();
      await decoys("chosen.cjs", "chosen.mjs");
      const load = (constructor = "URL") =>
        `console.log((await import(new ${constructor}("./chosen.mjs", import.meta.url).href)).default);`;
      const redirect =
        'Object.defineProperty(U.prototype, "href", {get() { return import.meta.url.replace("public/mutable-url.mjs", "private/chosen.mjs"); }});';
      for (const assignment of [
        'URL = class { constructor(x, y) { return {href: new NativeURL("../private/chosen.mjs", y).href}; } };',
        'globalThis.URL = class { constructor(x, y) { return {href: new NativeURL("../private/chosen.mjs", y).href}; } };',
        'global.URL = class { constructor(x, y) { return {href: new NativeURL("../private/chosen.mjs", y).href}; } };',
        'global["URL"] = class { constructor(x, y) { return {href: new NativeURL("../private/chosen.mjs", y).href}; } };',
        'Object.assign(globalThis, {URL: class { constructor(x, y) { return {href: new NativeURL("../private/chosen.mjs", y).href}; } }});',
      ]) {
        await closed(esm, `const NativeURL = URL; ${assignment}\n${load()}`);
      }
      for (const declaration of [
        'import url from "node:url"; const U = url["URL"];',
        'import url from "node:url"; url.fileURLToPath = () => ""; const U = url["URL"];',
        'import url from "node:url"; const { URL: U } = url;',
        'import { URL as U } from "node:url";',
      ]) {
        await closed(esm, `${declaration}\n${redirect}\n${load()}`);
      }
      await open(esm, load(), { to: publicEsm });
      for (const [declaration, constructor] of [
        ['import {URL as U} from "node:url";', "U"],
        ['import url from "node:url"; const {URL: U} = url;', "U"],
        ['import url from "node:url"; const U = url["URL"];', "U"],
        ['import {URL as U} from "node:url";', "(U)"],
        ['import * as url from "node:url";', "(url.URL)"],
        ["", "(URL)"],
      ]) {
        await open(esm, `${declaration} ${load(constructor)}`, { to: publicEsm });
      }
      await closed(
        esm,
        `import {URL as U} from "node:url";
       ${redirect.replace("U.prototype", "(U).prototype")}
       ${load("(U)")}`,
      );
      await open(esm, `const global = {}; global.URL = class {}; ${load()}`, { to: publicEsm });
      for (const property of ["global", "globalThis", "URL"]) {
        await open(
          esm,
          `const settings = JSON.parse('{"${property}":false}'); void settings.${property};\n${load()}`,
          { to: publicEsm },
        );
      }
    };
    await settle([commonjs(), modules()]);
  });

  test("fails closed for a non-native Node path flavor", async (t) => {
    const source = "apps/app/src/public/path-flavor.cjs";
    const { root, decoys, closed } = await workspace(t, {
      boundaries: [noPrivate("apps/app/src/public/**")],
    });
    await decoys("chosen.cjs");
    const directory = dirname(join(root, source));
    const foreign = process.platform === "win32" ? "posix" : "win32";
    if (process.platform !== "win32") {
      // POSIX permits backslashes in a module name; Node can load this link.
      await mkdir(join(directory, "node_modules"), { recursive: true });
      await symlink(
        join(root, "apps/app/src/private/chosen.cjs"),
        join(directory, "node_modules", win32.join(directory, "chosen.cjs")),
      );
    }
    for (const setup of [`const alias = path.${foreign};`, `const {${foreign}: alias} = path;`]) {
      await closed(
        source,
        `const path = require("node:path"); ${setup}
       console.log(require(alias.join(__dirname, "chosen.cjs")));`,
        {
          output: process.platform === "win32" ? "PUBLIC" : "PRIVATE",
          avoid: "apps/app/src/public/chosen.cjs",
        },
      );
    }
  });

  test("fails closed when CommonJS wrapper paths are reassigned", async (t) => {
    const source = "apps/app/src/public/wrapper.cjs";
    const avoid = "apps/app/src/public/chosen.cjs";
    const { write, check, decoys, closed, open } = await workspace(t, {
      boundaries: [noPrivate("apps/app/src/public/**", { kinds: ["require"] })],
    });
    await decoys("chosen.cjs");
    const setup = 'const path = require("node:path");';
    const byDirectory = '__dirname + "/chosen.cjs"';
    const byFile = 'path.join(path.dirname(__filename), "chosen.cjs")';
    for (const [assignment, target] of [
      ['__dirname = path.join(__dirname, "../private");', byDirectory],
      ['__dirname += "/../private";', byDirectory],
      ['[__dirname] = [path.join(__dirname, "../private")];', byDirectory],
      ['({ dir: __dirname } = { dir: path.join(__dirname, "../private") });', byDirectory],
      ['({ __dirname } = { __dirname: path.join(__dirname, "../private") });', byDirectory],
      [
        '({ nested: { dir: __dirname = "" } } = { nested: { dir: path.join(__dirname, "../private") } });',
        byDirectory,
      ],
      ['for (__dirname of [path.join(__dirname, "../private")]) {}', byDirectory],
      ['__filename = path.join(__dirname, "../private/anchor.cjs");', byFile],
      ['[__filename] = [path.join(__dirname, "../private/anchor.cjs")];', byFile],
    ]) {
      await closed(source, `${setup} ${assignment} console.log(require(${target}));`, { avoid });
    }
    await closed(
      source,
      `${setup}
     const { createRequire } = require("node:module");
     __filename = path.join(__dirname, "../private/anchor.cjs");
     console.log(createRequire(__filename)("./chosen.cjs"));`,
      { avoid },
    );
    for (const assignment of [
      "__dirname++;",
      "++__filename;",
      "for (__dirname in {}) {}",
      "for (__filename of []) {}",
    ]) {
      await write(source, `${setup} ${assignment} require(__dirname + __filename);`);
      assert.ok(violates(await check(), source), assignment);
    }
    for (const target of [byFile, byDirectory]) {
      const report = await open(
        source,
        `${setup}
       function local(__dirname, __filename) { __dirname = "x"; __filename = "y"; }
       console.log(require(${target}));`,
        { to: avoid },
      );
      assert.equal(report.violations.filter((item) => item.from === source).length, 0);
    }
  });

  test("fails closed when implicit CommonJS require is reassigned", async (t) => {
    const source = "apps/app/src/public/main.cjs";
    const avoid = "apps/app/src/public/secret.cjs";
    const { write, check, decoys, anchors, closed, open } = await workspace(t, {
      boundaries: [noPrivate("apps/app/src/public/**", { kinds: ["require"] })],
    });
    await decoys("secret.cjs");
    await anchors("private");
    const setup =
      'const {createRequire} = require("node:module"); const path = require("node:path"); function anchor() { return path.join(__dirname, "../private/anchor.cjs"); }';
    for (const assignment of [
      "require = createRequire(anchor());",
      'require = createRequire(path.join(__dirname, "../private/anchor.cjs"));',
      "[require] = [createRequire(anchor())];",
      "({ require } = { require: createRequire(anchor()) });",
      "for (require of [createRequire(anchor())]) {}",
    ]) {
      await closed(source, `${setup} ${assignment} console.log(require("./secret.cjs"));`, {
        avoid,
      });
    }
    for (const assignment of ["require++;", "++require;", "for (require in {}) {}"]) {
      await write(source, `${assignment} require("./secret.cjs");`);
      assert.ok(violates(await check(), source), assignment);
    }
    await open(
      source,
      'function local(require) { require = () => 1; } console.log(require("./secret.cjs"));',
      { to: avoid },
    );
  });

  test("fails closed when the implicit CommonJS module loader is reassigned", async (t) => {
    const source = "apps/app/src/public/module.cjs";
    const avoid = "apps/app/src/public/secret.cjs";
    const { decoys, anchors, closed, open } = await workspace(t, {
      boundaries: [noPrivate("apps/app/src/public/**", { kinds: ["require"] })],
    });
    await decoys("secret.cjs");
    await anchors("private");
    const setup =
      'const {createRequire} = require("node:module"); const path = require("node:path");';
    const loader = 'createRequire(path.join(__dirname, "../private/anchor.cjs"))';
    for (const assignment of [
      `module = { require: ${loader} };`,
      `module.require = ${loader};`,
      `module["require"] = ${loader};`,
      `const key = "require"; module[key] = ${loader};`,
      `const alias = module; alias.require = ${loader};`,
      `const first = module; const alias = first; alias["require"] = ${loader};`,
      `function change(alias) { alias.require = ${loader}; } change(module);`,
      `const box = {module}; box.module.require = ${loader};`,
      `const original = module.require.bind(module); const proto = module.__proto__; proto.require = () => original("../private/secret.cjs");`,
      `const alias = module; Object.assign(alias, {require: ${loader}});`,
    ]) {
      await closed(source, `${setup} ${assignment} console.log(module.require("./secret.cjs"));`, {
        avoid,
      });
    }
    for (const code of [
      'function local(module) { module = {}; } module.exports = 1; console.log(module.require("./secret.cjs"));',
      'const alias = module; console.log(alias.require("./secret.cjs"));',
    ]) {
      await open(source, code, { to: avoid });
    }
  });

  test("hides unknown expression contents while keeping exception identities distinct", async (t) => {
    const { write, check, cli: verify } = await workspace(t);
    const esm = "apps/app/src/unknown-private.mjs";
    const cjs = "apps/app/src/unknown-private.cjs";
    await write(esm, 'export const load = (name) => import("PRIVATE_ALPHA" + name);');
    await write(cjs, 'module.exports = (name) => require("PRIVATE_BETA" + name);');
    const report = await check();
    const violations = report.violations.filter((item) => [esm, cjs].includes(item.from));
    assert.equal(violations.length, 2);
    assert.notEqual(violations[0].specifier, violations[1].specifier);
    assert.ok(violations.every((item) => item.specifier.startsWith("unknown:sha256:")));
    assert.equal(JSON.stringify(report).includes("PRIVATE_"), false);
    for (const error of await settle([[], ["--json"]].map((json) => failure(verify(json), 1)))) {
      assert.equal((error.stdout + error.stderr).includes("PRIVATE_"), false);
    }
    const exceptions = exceptionsFor(violations.find((item) => item.from === esm));
    assert.equal((await check({ exceptions })).baseline.length, 1);
    await write(esm, 'export const load = (name) => import("PRIVATE_CHANGED" + name);');
    const changed = await check({ exceptions });
    assert.ok(changed.violations.some((item) => item.rule === "stale-exception"));
    assert.ok(violates(changed, esm));
  });

  test("rejects symbolic links in configured source roots and their ancestors", async (t) => {
    const { root, write, check } = await workspace(t);
    const outside = await temporaryDirectory(t, "module-outside-");
    await writeFile(join(outside, "outside.mjs"), "export const outside = true;");
    await mkdir(join(outside, "nested"));
    await writeFile(join(outside, "nested", "outside.mjs"), "export const outside = true;");
    await symlink(outside, join(root, "linked"), "dir");
    await symlink(root, join(root, "self"), "dir");
    await mkdir(join(root, "outer"));
    await symlink(outside, join(root, "outer", "linked"), "dir");
    // Each invalid policy gets its own file so the CLI runs concurrently.
    await settle(
      ["linked", "self/apps/app/src", "outer/linked/nested"].map(async (sourceRoot, index) => {
        const invalid = { ...policy, sourceRoots: [sourceRoot], packages: [] };
        await assert.rejects(
          check({ policy: invalid }),
          /Source roots cannot traverse symbolic links/,
        );
        await write(`policy-${index}.json`, JSON.stringify(invalid));
        const error = await failure(
          cliInProcess(["--root", root, "--policy", join(root, `policy-${index}.json`), "--json"]),
          2,
        );
        assert.match(error.stderr, /Source roots cannot traverse symbolic links/);
      }),
    );
    assert.equal((await check()).ok, true);
  });

  // These fixtures express caller-selected rules, without adopting architecture
  // policy for the repository running this reusable analyzer.
  test("discovers new sources and resolves public leaves and source extension mapping deterministically", async (t) => {
    const { root, write, check } = await workspace(t);
    let report = await check();
    assert.equal(report.ok, true, JSON.stringify(report.violations));
    for (const specifier of ["./leaf.js", "@fixture/library/leaf"]) {
      assert.ok(
        report.edges.some(
          (edge) => edge.specifier === specifier && edge.to === "packages/library/src/leaf.ts",
        ),
      );
    }
    await write("apps/app/src/new/nested.mjs", 'import "../index.ts";');
    report = await check();
    assert.ok(report.files.includes("apps/app/src/new/nested.mjs"));
    assert.equal(from(report, "apps/app/src/new/nested.mjs")[0].to, "apps/app/src/index.ts");
    assert.deepEqual(await check(), report);
    assert.equal(JSON.stringify(report).includes(root), false);
  });

  test("matches path and specifier boundaries, exclusions, and dependency kinds", async (t) => {
    const boundary = {
      rule: "consumer-to-private",
      from: ["apps/app/src/consumers/**"],
      to: ["apps/app/src/private/**"],
      specifiers: ["external-driver", "external-driver/**"],
      exceptFrom: ["apps/app/src/consumers/adapter.ts"],
      exceptTo: ["apps/app/src/private/public.ts"],
      kinds: ["import", "export"],
      message: "Use the public leaf.",
    };
    const { write, check } = await workspace(t, { boundaries: [boundary] });
    await write(
      "apps/app/src/private/store.ts",
      "export const store = 1; export interface Store {}",
    );
    await write("apps/app/src/private/public.ts", "export const safe = 1;");
    await write(
      "apps/app/src/consumers/invalid.ts",
      `
      import type { Store } from "../private/store.ts";
      export { store } from "../private/store.ts";
      import "external-driver/subpath";
      import "external-driver-other";
      import "../private/public.ts";
      await import("../private/store.ts");
    `,
    );
    await write("apps/app/src/consumers/adapter.ts", 'import "../private/store.ts";');
    await write("apps/app/src/consumers-other.ts", 'import "./private/store.ts";');
    const report = await check();
    assert.deepEqual(rules(report), Array(3).fill("consumer-to-private"));
    assert.equal(report.violations.filter((item) => item.typeOnly).length, 1);
    assert.ok(report.violations.every((item) => item.from.endsWith("/invalid.ts")));
  });

  test("enforces blocked package exports, cross-package sources and internal root barrels", async (t) => {
    const { write, check } = await workspace(t);
    await write(
      "packages/library/src/private.ts",
      `
      import type { Value } from "./index.ts";
      export type { Value } from "@fixture/library";
    `,
    );
    await write(
      "apps/app/src/private.ts",
      `
      import type { Value } from "../../../packages/library/src/leaf.ts";
      import "@fixture/library/src/leaf.ts";
      import "@fixture/library/blocked";
    `,
    );
    assert.deepEqual(rules(await check()), [
      "cross-package-source",
      "internal-root-barrel",
      "internal-root-barrel",
      "unsupported-package-export",
      "unsupported-package-export",
    ]);
    const allowed = await check({
      policy: { ...policy, packageImports: { sourcePaths: "allow", internalRoot: "allow" } },
    });
    assert.deepEqual(rules(allowed), ["unsupported-package-export", "unsupported-package-export"]);
  });

  test("distinguishes runtime conditional exports from declarations using native resolution", async (t) => {
    const { root, write, check, link } = await workspace(t);
    // A real package link makes Node an independent resolution oracle. Targets
    // throw if executed: both the oracle and analyzer must only resolve paths.
    await link();
    const path = "apps/app/src/conditional.mjs";
    await write(
      path,
      `
      import "@fixture/library/conditional";
      import { createRequire } from "node:module";
      const load = createRequire(import.meta.url);
      load("@fixture/library/conditional");
      await import(load.resolve("@fixture/library/conditional"));
    `,
    );
    await write(
      "apps/app/src/types.ts",
      'import type { Selected } from "@fixture/library/conditional";',
    );
    const loader = createRequire(join(root, path));
    const requireTarget = relative(root, loader.resolve("@fixture/library/conditional"));
    const { stdout } = await node(
      [
        "--input-type=module",
        "-e",
        'console.log(import.meta.resolve("@fixture/library/conditional"))',
      ],
      { cwd: root },
    );
    const importTarget = relative(root, fileURLToPath(stdout.trim()));
    assert.notEqual(requireTarget, importTarget);
    assert.throws(() => loader.resolve("@fixture/library/blocked"), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
    const report = await check();
    assert.equal(report.ok, true, JSON.stringify(report.violations));
    const edges = from(report, path);
    assert.equal(
      edges.find(
        (edge) => edge.kind === "import" && edge.specifier === "@fixture/library/conditional",
      ).to,
      importTarget,
    );
    assert.equal(edges.find((edge) => edge.kind === "require").to, requireTarget);
    assert.equal(edges.find((edge) => edge.kind === "dynamic-import").to, requireTarget);
    assert.equal(
      from(report, "apps/app/src/types.ts")[0].to,
      "packages/library/src/conditional.d.ts",
    );
    for (const resolution of [
      report.resolutions.find(
        (item) =>
          item.reference.from === path &&
          item.reference.kind === "import" &&
          item.reference.specifier === "@fixture/library/conditional",
      ),
      report.resolutions.find((item) => item.reference.from === "apps/app/src/types.ts"),
    ]) {
      assert.equal(resolution.runtimeTarget, importTarget);
      assert.equal(resolution.typeTarget, "packages/library/src/conditional.d.ts");
    }
  });

  test("honors Node's default node-addons export condition for import and require", async (t) => {
    const consumer = "apps/app/src/addons.mjs";
    const secret = "packages/library/src/secret.mjs";
    const { root, write, check, link, exports } = await workspace(t, {
      boundaries: [
        {
          rule: "forbidden-native-leaf",
          from: [consumer],
          to: [secret],
          message: "Use the public leaf.",
        },
      ],
    });
    await exports({ ".": { "node-addons": "./src/secret.mjs", default: "./src/safe.mjs" } });
    for (const name of ["secret", "safe"]) {
      await write(
        `packages/library/src/${name}.mjs`,
        'throw new Error("Analyzer must not execute targets.");',
      );
    }
    await link();
    await write(
      consumer,
      `
      import "@fixture/library";
      import { createRequire } from "node:module";
      const load = createRequire(import.meta.url);
      load("@fixture/library");
    `,
    );
    // node-addons is a default Node condition. Both native resolvers select its
    // target before default; neither the oracle nor analyzer executes that target.
    const { stdout } = await node(
      ["--input-type=module", "-e", 'console.log(import.meta.resolve("@fixture/library"))'],
      { cwd: root },
    );
    const importTarget = relative(root, fileURLToPath(stdout.trim()));
    const requireTarget = relative(
      root,
      createRequire(join(root, consumer)).resolve("@fixture/library"),
    );
    assert.equal(importTarget, secret);
    assert.equal(requireTarget, secret);
    const report = await check();
    assert.deepEqual(
      { targets: from(report, consumer).map((edge) => edge.to), violations: rules(report) },
      {
        targets: [importTarget, requireTarget],
        violations: ["forbidden-native-leaf", "forbidden-native-leaf"],
      },
    );
  });

  test("matches native export-array fallback and keeps valid types separate from invalid runtime exports", async (t) => {
    const { root, write, check, link, exports } = await workspace(t);
    await exports({
      "./array-null": [null, "./src/conditional.mjs"],
      "./array-invalid": ["../invalid.mjs", "./src/conditional.mjs"],
      "./invalid-runtime": { types: "./src/conditional.d.ts", default: "../invalid.mjs" },
    });
    await link();
    await write(
      "apps/app/src/arrays.mjs",
      `
      import "@fixture/library/array-null";
      import "@fixture/library/array-invalid";
      import "@fixture/library/invalid-runtime";
    `,
    );
    await write(
      "apps/app/src/valid-types.ts",
      'import type { Selected } from "@fixture/library/invalid-runtime";',
    );
    const loader = createRequire(join(root, "apps/app/src/arrays.mjs"));
    const targets = ["@fixture/library/array-null", "@fixture/library/array-invalid"].map(
      (specifier) => relative(root, loader.resolve(specifier)),
    );
    assert.throws(() => loader.resolve("@fixture/library/invalid-runtime"), {
      code: "ERR_INVALID_PACKAGE_TARGET",
    });
    const report = await check();
    assert.deepEqual(rules(report), ["unsupported-package-export"]);
    assert.deepEqual(
      from(report, "apps/app/src/arrays.mjs").map((edge) => edge.to),
      targets,
    );
    const types = report.resolutions.find(
      (item) => item.reference.from === "apps/app/src/valid-types.ts",
    );
    assert.equal(types.status, "local");
    assert.equal(types.typeTarget, "packages/library/src/conditional.d.ts");
    assert.equal(types.runtimeTarget, null);
  });

  test("refuses case-insensitive reserved export segments like native Node", async (t) => {
    const { root, write, cli, link, exports } = await workspace(t);
    await exports({
      "./mixed": "./src/NoDe_MoDuLeS/entry.mjs",
      "./encoded": "./src/%4eODE_MODULES/entry.mjs",
      "./fallback": ["./src/NoDe_MoDuLeS/entry.mjs", "./src/conditional.mjs"],
      "./valid": "./src/node_modules-backup/entry.mjs",
    });
    await link();
    for (const directory of ["NoDe_MoDuLeS", "NODE_MODULES", "node_modules-backup"]) {
      await write(`packages/library/src/${directory}/entry.mjs`, "export const value = 1;\n");
    }
    await write("apps/app/src/mixed.mjs", 'import "@fixture/library/mixed";');
    await write("apps/app/src/encoded.mjs", 'import "@fixture/library/encoded";');
    await write("apps/app/src/mixed.cjs", 'require("@fixture/library/mixed");');
    await write("apps/app/src/valid.mjs", 'import "@fixture/library/valid";');
    await write("apps/app/src/fallback.mjs", 'import "@fixture/library/fallback";');

    // Real Node selects the fallback without executing a rejected target. ESM and
    // CommonJS both refuse the same reserved directory, regardless of its case.
    for (const file of ["mixed.mjs", "encoded.mjs", "mixed.cjs"]) {
      const error = await failure(node([join(root, "apps/app/src", file)]), 1);
      assert.match(error.stderr, /ERR_INVALID_PACKAGE_TARGET/);
    }
    await node([join(root, "apps/app/src/valid.mjs")]);
    const fallback = await node(
      [
        "--input-type=module",
        "-e",
        'console.log(import.meta.resolve("@fixture/library/fallback"))',
      ],
      { cwd: root },
    );
    assert.equal(
      fileURLToPath(fallback.stdout.trim()),
      join(root, "packages/library/src/conditional.mjs"),
    );

    const result = await failure(cli(["--json"]), 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.deepEqual(rules(report), Array(3).fill("unsupported-package-export"));
    for (const file of ["mixed.mjs", "encoded.mjs", "mixed.cjs"]) {
      assert.equal(from(report, `apps/app/src/${file}`).length, 0);
    }
    assert.equal(
      from(report, "apps/app/src/valid.mjs")[0].to,
      "packages/library/src/node_modules-backup/entry.mjs",
    );
    assert.equal(
      from(report, "apps/app/src/fallback.mjs")[0].to,
      "packages/library/src/conditional.mjs",
    );
  });

  test("preserves valid export query and fragment names while checking slash segments", async (t) => {
    const { root, write, cli, link, exports } = await workspace(t);
    await exports({
      "./query": "./src/entry.mjs?NoDe_MoDuLeS",
      "./fragment": "./src/entry.mjs#NoDe_MoDuLeS",
      "./query-slash": "./src/entry.mjs?q=/NoDe_MoDuLeS/end",
    });
    await link();
    await write("packages/library/src/entry.mjs", "export const value = 1;\n");
    for (const name of ["query", "fragment", "query-slash"]) {
      await write(
        `apps/app/src/${name}.mjs`,
        `import { value } from "@fixture/library/${name}"; console.log(value);`,
      );
    }
    for (const name of ["query", "fragment"]) {
      assert.equal((await node([join(root, `apps/app/src/${name}.mjs`)])).stdout.trim(), "1");
    }
    const rejected = await failure(node([join(root, "apps/app/src/query-slash.mjs")]), 1);
    assert.match(rejected.stderr, /ERR_INVALID_PACKAGE_TARGET/);

    const result = await failure(cli(["--json"]), 1);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(rules(report), ["unsupported-package-export"]);
    for (const name of ["query", "fragment"]) {
      assert.equal(
        from(report, `apps/app/src/${name}.mjs`)[0].to,
        "packages/library/src/entry.mjs",
      );
    }
    assert.equal(from(report, "apps/app/src/query-slash.mjs").length, 0);
  });

  test("does not treat a declaration-only target as runtime code", async (t) => {
    const { write, check } = await workspace(t);
    await write("apps/app/src/declaration.d.ts", "export interface Value {};");
    await write(
      "apps/app/src/declaration-consumer.ts",
      `
      import "./declaration.d.ts";
      import type { Value } from "./declaration.d.ts";
    `,
    );
    const report = await check();
    assert.deepEqual(rules(report), ["unresolved-local-import"]);
    const references = report.resolutions.filter(
      (item) => item.reference.from === "apps/app/src/declaration-consumer.ts",
    );
    const runtime = references.find((item) => !item.reference.typeOnly);
    assert.equal(runtime.status, "unresolved");
    assert.equal(runtime.runtimeTarget, null);
    assert.equal(runtime.typeTarget, "apps/app/src/declaration.d.ts");
    assert.equal(references.find((item) => item.reference.typeOnly).status, "local");
  });

  test("accepts a type-only CommonJS import when no runtime export exists", async (t) => {
    const { root, write, check, link, exports } = await workspace(t);
    await exports({ "./types-only": { types: "./src/conditional.d.ts" } });
    await link();
    const source = "apps/app/src/type-only.cts";
    await write(source, 'import type Library = require("@fixture/library/types-only");');
    assert.throws(() => createRequire(join(root, source)).resolve("@fixture/library/types-only"), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
    const report = await check();
    const item = report.resolutions.find((resolution) => resolution.reference.from === source);
    assert.equal(item.status, "local");
    assert.equal(item.typeTarget, "packages/library/src/conditional.d.ts");
    assert.equal(item.runtimeTarget, null);
    assert.equal(
      report.violations.some((entry) => entry.from === source),
      false,
    );
  });

  test("uses native CommonJS file and directory resolution from file and trailing-slash anchors", async (t) => {
    const { root, write, check } = await workspace(t);
    const base = "apps/app/src/native";
    await write(`${base}/helper.js`, 'throw new Error("must not execute");');
    await write(`${base}/indexed/index.js`, 'throw new Error("must not execute");');
    await write(`${base}/selected/package.json`, JSON.stringify({ main: "entry.cjs" }));
    await write(`${base}/selected/entry.cjs`, 'throw new Error("must not execute");');
    await write(
      `${base}/load.mjs`,
      `
      import { createRequire } from "node:module";
      const load = createRequire(import.meta.url);
      load("./helper"); load("./indexed");
      await import(load.resolve("./selected"));
    `,
    );
    await write(
      `${base}/directory.mjs`,
      `
      import { createRequire } from "node:module";
      import { fileURLToPath } from "node:url";
      const urlLoader = createRequire(new URL("./", import.meta.url));
      const pathLoader = createRequire(fileURLToPath(new URL("./", import.meta.url)));
      urlLoader("./helper"); pathLoader("./indexed");
    `,
    );
    const report = await check();
    const targets = (path, kinds) =>
      from(report, `${base}/${path}`)
        .filter((edge) => kinds.includes(edge.kind))
        .map((edge) => edge.to)
        .sort();
    const native = (loader, specifiers) =>
      specifiers.map((specifier) => relative(root, loader.resolve(specifier))).sort();
    assert.equal(report.ok, true, JSON.stringify(report.violations));
    assert.deepEqual(
      targets("load.mjs", ["require", "dynamic-import"]),
      native(createRequire(join(root, base, "load.mjs")), ["./helper", "./indexed", "./selected"]),
    );
    assert.deepEqual(
      targets("directory.mjs", ["require"]),
      native(createRequire(join(root, base) + "/"), ["./helper", "./indexed"]),
    );
    assert.ok(
      from(report, `${base}/directory.mjs`).some(
        (edge) => edge.kind === "dependency-anchor" && edge.to === base,
      ),
    );
  });

  test("resolves registered CommonJS package main entries through the CLI without exports", async (t) => {
    const consumer = "apps/app/src/legacy.cjs";
    const target = "packages/legacy/src/entry.cjs";
    const {
      root,
      write,
      link,
      cliProcess: verify,
    } = await workspace(t, {
      packages: ["apps/app", "packages/legacy", "packages/outside"],
      sourceRoots: ["apps/app/src", "packages/legacy/src"],
      boundaries: [
        { rule: "forbidden-main", from: [consumer], to: [target], message: "Use the adapter." },
      ],
    });
    await write("apps/app/src/index.ts", "export {};");
    await write(
      "packages/legacy/package.json",
      JSON.stringify({ name: "@fixture/legacy", main: "src/entry.cjs", types: "src/entry.d.cts" }),
    );
    await write("packages/legacy/src/entry.d.cts", "export declare const value: number;");
    await write(target, 'throw new Error("Analyzer must not execute targets.");');
    await write(
      "packages/outside/package.json",
      JSON.stringify({ name: "@fixture/outside", main: "entry.cjs" }),
    );
    await write(
      "packages/outside/entry.cjs",
      'throw new Error("Analyzer must not execute targets.");',
    );
    await write(consumer, 'require("@fixture/legacy"); require("@fixture/outside");');
    // Resolve the installed package with Node, then remove the link: the analyzer
    // must use the explicitly registered package, without an installation prerequisite.
    await link("packages/legacy", "node_modules/@fixture/legacy");
    const nativeTarget = relative(
      root,
      createRequire(join(root, consumer)).resolve("@fixture/legacy"),
    );
    assert.equal(nativeTarget, target);
    await rm(join(root, "node_modules/@fixture/legacy"));
    const report = JSON.parse((await failure(verify(["--json"]), 1)).stdout);
    assert.deepEqual(rules(report), ["forbidden-main", "unresolved-local-import"]);
    const resolved = report.resolutions.find(
      (item) => item.reference.specifier === "@fixture/legacy",
    );
    assert.equal(resolved.status, "local");
    assert.equal(resolved.named, true);
    assert.equal(resolved.runtimeTarget, nativeTarget);
    assert.equal(resolved.typeTarget, "packages/legacy/src/entry.d.cts");
    assert.equal(violation(report, consumer, "forbidden-main").to, target);
    assert.equal(
      report.resolutions.find((item) => item.reference.specifier === "@fixture/outside").status,
      "unresolved",
    );
  });

  test("keeps canonical CLI graph identities through a symlink root without admitting skipped sources", async (t) => {
    const consumer = "apps/app/src/canonical.cjs";
    const target = "apps/app/src/private.cjs";
    const { root, write } = await workspace(t, {
      packages: ["apps/app"],
      sourceRoots: ["apps/app/src"],
      boundaries: [
        {
          rule: "forbidden-canonical",
          from: [consumer],
          to: [target],
          message: "Use the safe leaf.",
        },
      ],
    });
    const alias = `${root}-alias`;
    await symlink(root, alias, "dir");
    t.after(() => rm(alias));
    await write("apps/app/src/index.ts", "export {};");
    await write(target, 'throw new Error("Analyzer must not execute targets.");');
    await write("outside/hidden.cjs", 'throw new Error("Analyzer must not execute targets.");');
    await symlink(join(root, "outside"), join(root, "apps/app/src/skipped"), "dir");
    // An absolute alias target also exercises canonical lookup when the accepted
    // root is already real. The skipped directory must not expand the graph.
    await write(
      consumer,
      `require(${JSON.stringify(join(alias, target))}); import(${JSON.stringify(join(alias, target))}); require("./skipped/hidden.cjs");`,
    );
    const nativeTarget = relative(
      root,
      createRequire(join(alias, consumer)).resolve(join(alias, target)),
    );
    assert.equal(nativeTarget, target);
    const reports = await settle(
      [root, alias].map(async (selectedRoot) => {
        const error = await failure(
          node([cli, "--root", selectedRoot, "--policy", "policy.json", "--json"]),
          1,
        );
        return JSON.parse(error.stdout);
      }),
    );
    for (const report of reports) {
      assert.deepEqual(rules(report), [
        "forbidden-canonical",
        "forbidden-canonical",
        "unresolved-local-import",
      ]);
      assert.equal(violation(report, consumer, "forbidden-canonical").to, target);
      assert.deepEqual(
        from(report, consumer).map((edge) => edge.to),
        [nativeTarget, nativeTarget],
      );
      assert.equal(
        report.resolutions.find((item) => item.reference.specifier === "./skipped/hidden.cjs")
          .status,
        "unresolved",
      );
      assert.equal(
        report.files.some((path) => /(?:skipped|outside)/.test(path)),
        false,
      );
    }
    assert.deepEqual(reports[0], reports[1]);
  });

  test("resolves anchored loads against their actual provider and checks foreign package anchors", async (t) => {
    const boundary = {
      rule: "consumer-to-private",
      from: ["apps/app/src/consumer/**"],
      to: ["apps/app/src/private/**"],
      message: "Use the public leaf.",
    };
    const { root, write, check } = await workspace(t, { boundaries: [boundary] });
    await write("apps/app/src/private/target.cjs", "exports.value = 1;");
    // The importer-relative decoy must not conceal the forbidden actual target.
    await write("apps/app/src/consumer/src/private/target.cjs", "exports.value = 2;");
    await write(
      "apps/app/src/consumer/load.mjs",
      `
      import { createRequire } from "node:module";
      const load = createRequire(new URL("../../package.json", import.meta.url));
      load("./src/private/target.cjs");
      await import(load.resolve("./src/private/target.cjs"));
    `,
    );
    await write(
      "apps/app/src/foreign.mjs",
      `
      import { createRequire } from "node:module";
      const load = createRequire(new URL("../../../packages/library/", import.meta.url));
    `,
    );
    const loader = createRequire(join(root, "apps/app/package.json"));
    const target = relative(root, loader.resolve("./src/private/target.cjs"));
    const report = await check();
    assert.deepEqual(rules(report), [
      "consumer-to-private",
      "consumer-to-private",
      "cross-package-source",
    ]);
    assert.ok(
      report.violations
        .filter((edge) => edge.rule === "consumer-to-private")
        .every((edge) => edge.to === target),
    );
    assert.equal(
      report.violations.find((edge) => edge.rule === "cross-package-source").kind,
      "dependency-anchor",
    );
  });

  test("rejects an unknown require anchor for a bare package while allowing builtins", async (t) => {
    const { write, check } = await workspace(t);
    const source = "apps/app/src/unknown-package-anchor.mjs";
    await write(
      source,
      `import { createRequire } from "node:module";
       const load = createRequire(process.env.LOADER_ANCHOR);
       load("@fixture/library"); load.resolve("@fixture/library"); load("node:fs");`,
    );
    const report = await check();
    const items = report.resolutions.filter((item) => item.reference.from === source);
    assert.equal(
      items.find((item) => item.reference.specifier === "@fixture/library").status,
      "unresolved",
    );
    assert.equal(items.find((item) => item.reference.specifier === "node:fs").status, "external");
    assert.ok(violates(report, source));
  });

  test("rejects a registered package shadowed at the actual import and require anchors", async (t) => {
    const { write, check, link, native, cli: verify } = await workspace(t);
    const shadow = "apps/app/src/shadow";
    await write(
      `${shadow}/package.json`,
      JSON.stringify({
        name: "@fixture/library",
        type: "module",
        exports: { import: "./index.mjs", require: "./index.cjs" },
      }),
    );
    await write(`${shadow}/index.mjs`, 'export const marker = "shadow";');
    await write(`${shadow}/index.cjs`, 'module.exports = "shadow";');
    await link(shadow, "apps/app/src/node_modules/@fixture/library");
    const sources = {
      "apps/app/src/shadow-import.mjs":
        'import { marker } from "@fixture/library"; console.log(marker);',
      "apps/app/src/shadow-require.cjs": 'console.log(require("@fixture/library"));',
      "apps/app/src/shadow-loader.mjs":
        'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); console.log(load("@fixture/library"));',
      [`${shadow}/self.mjs`]: 'import { marker } from "@fixture/library"; console.log(marker);',
    };
    for (const [source, code] of Object.entries(sources)) {
      await write(source, code);
    }
    // Native Node must choose the nearer installed package, not the registered decoy.
    const outputs = await settle(Object.keys(sources).map((source) => native(source)));
    assert.deepEqual(outputs, Array(outputs.length).fill("shadow"));
    const report = await check();
    for (const source of Object.keys(sources)) {
      assert.ok(violates(report, source, "workspace-package-mismatch"));
    }
    const error = await failure(verify(["--json"]), 1);
    assert.ok(
      JSON.parse(error.stdout).violations.some(
        (item) => item.rule === "workspace-package-mismatch",
      ),
    );
  });

  test("tracks loader aliases, module objects and wrappers while respecting lexical shadows", async (t) => {
    const { write, check } = await workspace(t, {
      boundaries: [
        {
          rule: "forbidden-driver",
          from: ["apps/app/src/**"],
          specifiers: ["external-driver"],
          message: "Use the adapter.",
        },
      ],
    });
    const known = [
      [
        "ts",
        'import { createRequire } from "node:module"; const factory = (createRequire); const load = (factory(import.meta.url) satisfies ReturnType<typeof createRequire>); const alias = load; (alias!)("external-driver");',
      ],
      [
        "mjs",
        'import module from "node:module"; const m = module; const { createRequire: factory } = m; let load = factory(import.meta.url); load("external-driver");',
      ],
      [
        "mjs",
        'import * as module from "module"; const load = module["createRequire"](import.meta.url); const { resolve } = load; await import(resolve("external-driver"));',
      ],
      [
        "cjs",
        'const { createRequire } = require("node:module"); var load = createRequire(__filename); const alias = load; alias("external-driver");',
      ],
      [
        "cts",
        'import module = require("node:module"); const load = module.createRequire(__filename); load("external-driver");',
      ],
      ["cjs", 'const mod = module; mod["require"]("external-driver");'],
    ];
    for (const [index, [extension, source]] of known.entries()) {
      await write(`apps/app/src/known-${index}.${extension}`, source);
    }
    await write(
      "apps/app/src/shadows.mjs",
      `
      import { createRequire } from "node:module";
      const factory = createRequire;
      function shadow(factory) { const load = factory(import.meta.url); load("external-driver"); }
      function shadowModule(module) { module.require("external-driver"); }
      function shadowRequire(require) { require("external-driver"); }
    `,
    );
    // Arbitrary function bodies are outside the evaluator's bounded propagation.
    await write(
      "apps/app/src/wrapper.mjs",
      `
      import { createRequire } from "node:module";
      const wrap = (value) => value;
      const load = wrap(createRequire(import.meta.url));
      load("external-driver");
    `,
    );
    const report = await check();
    assert.equal(
      report.violations.filter((edge) => edge.rule === "forbidden-driver").length,
      known.length,
    );
    for (const [index, [extension]] of known.entries()) {
      assert.ok(
        report.violations.some((edge) => edge.from === `apps/app/src/known-${index}.${extension}`),
      );
    }
  });

  test("keeps Node file bindings local across JavaScript and TypeScript module formats", async (t) => {
    const variants = [
      ["ts", "module"],
      ["js", "module"],
      ["mjs", "module"],
      ["mts", "module"],
      ["ts", "commonjs"],
      ["js", "commonjs"],
      ["cjs", "commonjs"],
      ["cts", "commonjs"],
    ];
    const base = "apps/app/src/scoped";
    const observed = await settle(
      variants.map(async ([extension, type]) => {
        const consumer = `${base}/b.${extension}`;
        const secret = `${base}/secret.${extension}`;
        const { write, check } = await workspace(t, {
          packages: ["apps/app"],
          sourceRoots: [base],
          boundaries: [
            {
              rule: "forbidden-secret",
              from: [consumer],
              to: [secret],
              message: "Use the safe leaf.",
            },
          ],
        });
        await write("apps/app/package.json", JSON.stringify({ name: "@fixture/app", type }));
        // Node gives each file its own bindings, even when import() is its only
        // module syntax. The earlier file's same-named const must not hide this edge.
        await write(`${base}/a.${extension}`, `const target = "./safe.${extension}";`);
        await write(consumer, `const target = "./secret.${extension}"; import(target);`);
        for (const name of ["safe", "secret"]) {
          await write(
            `${base}/${name}.${extension}`,
            'throw new Error("Analyzer must not execute targets.");',
          );
        }
        const report = await check();
        return {
          extension,
          type,
          targets: from(report, consumer).map((edge) => edge.to),
          violations: rules(report),
          ok: report.ok,
        };
      }),
    );
    assert.deepEqual(
      observed,
      variants.map(([extension, type]) => ({
        extension,
        type,
        targets: [`${base}/secret.${extension}`],
        violations: ["forbidden-secret"],
        ok: false,
      })),
    );
  });

  test("uses the nearest unnamed package scope for CLI CommonJS loaders and extension overrides", async (t) => {
    const base = "apps/app/src/nested";
    const target = `${base}/secret.cjs`;
    await settle(
      [
        ["js", "module", "commonjs", true],
        ["js", "commonjs", "module", false],
        ["js", "module", undefined, true],
        ["cjs", "module", "module", true],
        ["cts", "module", "module", true],
        ["mjs", "commonjs", "commonjs", false],
        ["mts", "commonjs", "commonjs", false],
      ].map(async ([extension, parentType, nestedType, commonjs]) => {
        const consumer = `${base}/load.${extension}`;
        const {
          root,
          write,
          native,
          cli: verify,
        } = await workspace(t, {
          packages: ["apps/app"],
          sourceRoots: [base],
          boundaries: [
            {
              rule: "forbidden-scope",
              from: [consumer],
              to: [target],
              message: "Use the safe leaf.",
            },
          ],
        });
        await write(
          "apps/app/package.json",
          JSON.stringify({ name: "@fixture/app", type: parentType }),
        );
        await write(`${base}/package.json`, JSON.stringify({ type: nestedType }));
        await write(target, 'throw new Error("Analyzer must not execute targets.");');
        await write(consumer, 'module.require("./secret.cjs");');
        // Execute only a native loader probe in the same scope; resolve the throwing
        // target without loading it. Node is independent of the analyzer's parser.
        const probe = `${base}/probe.${extension}`;
        await write(
          probe,
          'console.log(JSON.stringify({ loader: typeof module !== "undefined" && typeof module.require === "function", target: typeof require === "function" ? require.resolve("./secret.cjs") : null }));',
        );
        const [output, result] = await settle([
          native(probe),
          verify(["--json"]).catch((error) => {
            assert.equal(error.code, 1);
            return error;
          }),
        ]);
        const probed = JSON.parse(output);
        assert.equal(probed.loader, commonjs);
        assert.equal(probed.target && relative(root, probed.target), commonjs ? target : null);
        const report = JSON.parse(result.stdout);
        assert.equal(result.code ?? 0, commonjs ? 1 : 0);
        assert.deepEqual(
          from(report, consumer).map((edge) => edge.to),
          commonjs ? [target] : [],
        );
        assert.deepEqual(rules(report), commonjs ? ["forbidden-scope"] : []);
        if (commonjs) {
          assert.equal(report.violations[0].to, target);
        }
      }),
    );
  });

  test("does not preserve falsely known targets through reassigned paths or loaders", async (t) => {
    const { write, check } = await workspace(t);
    const source = "apps/app/src/reassigned.mjs";
    await write(
      source,
      `
      import { createRequire } from "node:module";
      import { dirname } from "node:path";
      let target = "./index.ts";
      target = process.env.TARGET;
      await import(target);
      let load = createRequire(import.meta.url);
      load = (name) => name;
      load("./index.ts");
      await import(load.resolve("./index.ts"));
      await import(dirname(createRequire(import.meta.url).resolve("./index.ts")));
    `,
    );
    const report = await check();
    assert.equal(reaches(report, source, "apps/app/src/index.ts"), false);
    assert.ok(violates(report, source));
    // Each dynamic import reports why its target stays unknown.
    assert.deepEqual(
      report.violations
        .filter((edge) => edge.from === source && edge.kind === "dynamic-import")
        .map((edge) => edge.message)
        .sort(),
      [
        "A recognized loader binding is assigned elsewhere in this source.",
        "Module paths require a local const initializer with no assignment.",
        "Path manipulation around require.resolve is outside bounded analysis.",
      ],
    );
  });

  test("bounds cyclic loader provenance and reports an unresolved dependency without aborting", async (t) => {
    const { write, check } = await workspace(t);
    // This invalid self-reference must remain an unknown dependency. Traversing
    // between loader provenance and path evaluation must not exhaust the stack.
    await write(
      "apps/app/src/cyclic-loader.mjs",
      `
      import { createRequire } from "node:module";
      const load = createRequire(load.resolve("x"));
      load("./x.mjs");
    `,
    );
    // A self-referencing path constant must stay unknown as well.
    await write(
      "apps/app/src/cyclic-path.mjs",
      'const target = target + ".mjs"; await import(target);',
    );
    const report = await check();
    assert.equal(report.ok, false);
    for (const source of ["apps/app/src/cyclic-loader.mjs", "apps/app/src/cyclic-path.mjs"]) {
      assert.ok(violates(report, source));
      assert.equal(from(report, source).length, 0);
    }
  });

  test("bounds cyclic computed factory provenance inside dynamic imports", async (t) => {
    const { write, check } = await workspace(t);
    // Computed module members cross the same provenance/evaluation boundary as
    // loader anchors; the cycle must stay unknown when consumed by import().
    await write(
      "apps/app/src/cyclic-factory.mjs",
      `
      import * as module from "node:module";
      const factory = module[factory()];
      await import(factory("./x.mjs"));
    `,
    );
    const report = await check();
    assert.equal(report.ok, false);
    assert.ok(violates(report, "apps/app/src/cyclic-factory.mjs"));
    assert.equal(from(report, "apps/app/src/cyclic-factory.mjs").length, 0);
  });

  test("resolves URL and path helper aliases, encoded file URLs and lexical path constants", async (t) => {
    const { write, check } = await workspace(t);
    await write("apps/app/src/target.mjs", 'throw new Error("must not execute");');
    await write(
      "apps/app/src/urls.mjs",
      `
      import * as url from "node:url";
      import path from "node:path";
      const urls = url;
      const { fileURLToPath: toPath, pathToFileURL: toURL } = urls;
      const { dirname: parent, join: combine } = path;
      const directory = parent(toPath(import.meta.url));
      await import(toURL(combine(directory, "target.mjs")).href);
    `,
    );
    await write(
      "apps/app/src/encoded.mjs",
      'await import(new URL("./%74arget.mjs?probe=1#fragment", import.meta.url).href);',
    );
    await write(
      "apps/app/src/scoped.mjs",
      'const target = "./missing.mjs"; function scoped() { const target = "./" + "target.mjs"; return import(target); }',
    );
    const report = await check();
    assert.equal(report.ok, true, JSON.stringify(report.violations));
    const imports = report.edges.filter(
      (edge) => /\/(urls|encoded|scoped)\.mjs$/.test(edge.from) && edge.kind === "dynamic-import",
    );
    assert.equal(imports.length, 3);
    assert.ok(imports.every((edge) => edge.to === "apps/app/src/target.mjs"));
  });

  test("keeps case-insensitive file URL loads local with normalized diagnostics", async (t) => {
    const target = "apps/app/src/private/target.mjs";
    const { root, write, check, cli, native } = await workspace(t, {
      boundaries: [noPrivate("apps/app/src/**")],
    });
    await write(target, 'export default "LOCAL";');
    await write("apps/app/src/private/target.cjs", 'module.exports = "LOCAL";');
    const url = pathToFileURL(join(root, target)).href;
    for (const [index, scheme] of ["file:", "FILE:", "fIlE:"].entries()) {
      const prefix = `scheme-${index}`;
      const selected = url.replace(/^file:/, scheme) + "?view=1#probe";
      const imports = `apps/app/src/${prefix}-imports.mjs`;
      await write(imports, `import value from ${JSON.stringify(selected)}; console.log(value);`);
      assert.equal(await native(imports), "LOCAL");
      const helpers = `apps/app/src/${prefix}-helpers.mjs`;
      await write(
        helpers,
        `import { createRequire } from "node:module";
         import { fileURLToPath, pathToFileURL } from "node:url";
         const load = createRequire(${JSON.stringify(url.replace(/^file:/, scheme))});
         const value = await import(pathToFileURL(fileURLToPath(${JSON.stringify(selected)})).href);
         console.log(value.default + load("./target.cjs"));`,
      );
      assert.equal(await native(helpers), "LOCALLOCAL");
    }
    const report = await check();
    for (const index of [0, 1, 2]) {
      const source = `apps/app/src/scheme-${index}-imports.mjs`;
      assert.ok(reaches(report, source, target), source);
      assert.equal(violation(report, source, "no-private").specifier, `file:${target}`);
      assert.ok(reaches(report, `apps/app/src/scheme-${index}-helpers.mjs`, target));
      assert.ok(
        reaches(
          report,
          `apps/app/src/scheme-${index}-helpers.mjs`,
          "apps/app/src/private/target.cjs",
        ),
      );
    }
    const rejected = await failure(cli(["--json"]), 1);
    assert.equal(JSON.parse(rejected.stdout).ok, false);
  });

  test("resolves ESM literal paths with URL semantics and preserves literal CommonJS filenames", async (t) => {
    const base = "apps/app/src/literals";
    const consumer = `${base}/imports.mjs`;
    const secret = `${base}/secret.mjs`;
    const { root, write, check } = await workspace(t, {
      boundaries: [
        { rule: "forbidden-secret", from: [consumer], to: [secret], message: "Use the safe leaf." },
      ],
    });
    const esmSpecifiers = ["./%73ecret.mjs", "./secret.mjs?view=1#probe"];
    const cjsSpecifiers = ["./literal?name.cjs", "./%73ecret.cjs"];
    for (const name of ["secret.mjs", "literal?name.cjs", "%73ecret.cjs"]) {
      await write(`${base}/${name}`, 'throw new Error("Analyzer must not execute targets.");');
    }
    await write(
      consumer,
      esmSpecifiers.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n"),
    );
    await write(
      `${base}/loads.cjs`,
      cjsSpecifiers.map((specifier) => `require(${JSON.stringify(specifier)});`).join("\n"),
    );
    // Native resolution, without importing targets, independently distinguishes
    // ESM URL decoding/query semantics from CommonJS literal filesystem lookup.
    const { stdout } = await node(
      [
        "--input-type=module",
        "-e",
        `console.log(JSON.stringify(${JSON.stringify(esmSpecifiers)}.map((specifier) => import.meta.resolve(specifier))))`,
      ],
      { cwd: join(root, base) },
    );
    const esmTargets = JSON.parse(stdout).map((url) => relative(root, fileURLToPath(url)));
    assert.deepEqual(esmTargets, [secret, secret]);
    const loader = createRequire(join(root, base, "loads.cjs"));
    const cjsTargets = cjsSpecifiers.map((specifier) => relative(root, loader.resolve(specifier)));
    assert.deepEqual(cjsTargets, [`${base}/literal?name.cjs`, `${base}/%73ecret.cjs`]);
    const report = await check();
    assert.deepEqual(
      {
        esm: from(report, consumer).map((edge) => edge.to),
        cjs: from(report, `${base}/loads.cjs`).map((edge) => edge.to),
        violations: rules(report),
      },
      { esm: esmTargets, cjs: cjsTargets, violations: ["forbidden-secret", "forbidden-secret"] },
    );
  });

  test("reports unknown dynamic paths and anchors without interpreting comments or embedded scripts", async (t) => {
    const { write, check } = await workspace(t);
    await write(
      "apps/app/src/unknown.mjs",
      `
      import { createRequire } from "node:module";
      // import "./comment-missing.mjs";
      const script = 'require("./embedded-missing.mjs")';
      import "./missing.mjs";
      import "#unregistered";
      export const dynamic = (name) => import(name);
      export function anchored(anchor) {
        const load = createRequire(anchor);
        load("./index.ts");
        return import(load.resolve("./index.ts"));
      }
    `,
    );
    const report = await check();
    assert.equal(report.violations.length, 5);
    assert.equal(report.violations.filter((edge) => edge.rule === dynamic).length, 3);
    assert.equal(reaches(report, "apps/app/src/unknown.mjs", "apps/app/src/index.ts"), false);
    assert.equal(JSON.stringify(report).includes("comment-missing"), false);
    assert.equal(JSON.stringify(report).includes("embedded-missing"), false);
  });

  test("checks registered workspace namespaces and reports source syntax failures", async (t) => {
    const { write, check } = await workspace(t);
    await write("apps/app/src/unregistered.ts", 'import "@fixture/missing";');
    assert.equal((await check()).ok, true);
    assert.deepEqual(
      rules(await check({ policy: { ...policy, workspaceNamespaces: ["@fixture/"] } })),
      ["unknown-workspace-package"],
    );
    await write("apps/app/src/broken.ts", "export const broken = ;");
    assert.ok(violates(await check(), "apps/app/src/broken.ts", "source-syntax"));
  });

  test("classifies runtime, erased type-only and mixed cycles using Node type-stripping semantics", async (t) => {
    const { write, check } = await workspace(t);
    await write(
      "apps/app/src/cycles/type-a.ts",
      'import type { B } from "./type-b.ts"; export interface A { b: B }',
    );
    await write("apps/app/src/cycles/type-b.ts", 'export type { A as B } from "./type-a.ts";');
    await write(
      "apps/app/src/cycles/runtime-a.ts",
      'import { type B } from "./runtime-b.ts"; export interface A {}',
    );
    await write(
      "apps/app/src/cycles/runtime-b.ts",
      'export { type A as B } from "./runtime-a.ts";',
    );
    await write(
      "apps/app/src/cycles/mixed-a.ts",
      'import type { B } from "./mixed-b.ts"; export const a = 1;',
    );
    await write("apps/app/src/cycles/mixed-b.ts", 'import "./mixed-a.ts"; export interface B {}');
    await write("apps/app/src/query.ts", 'export type Query = import("./cycles/type-a.ts").A;');
    // Node keeps empty inline-type import/export declarations, evaluating targets.
    assert.match(
      stripTypeScriptTypes('import { type A } from "./a.ts";'),
      /import\s*\{\s*\}\s*from/,
    );
    assert.match(
      stripTypeScriptTypes('export { type A } from "./a.ts";'),
      /export\s*\{\s*\}\s*from/,
    );
    const report = await check();
    assert.equal(report.runtimeCycles.length, 1);
    // Both all-type and mixed cycles need an erased edge to close the loop.
    assert.equal(report.typeOnlyCycles.length, 2);
    assert.equal(report.typeInvolvingCycles.length, 3);
    assert.ok(
      report.typeInvolvingCycles.some((group) => group.every((path) => path.includes("runtime-"))),
    );
    assert.ok(report.runtimeCycles[0].every((path) => path.includes("runtime-")));
    assert.deepEqual(rules(report), ["runtime-cycle"]);
    assert.equal(from(report, "apps/app/src/query.ts")[0].typeOnly, true);
    assert.equal(
      (await check({ policy: { ...policy, cycles: { runtime: "report", typeOnly: "report" } } }))
        .ok,
      true,
    );
  });

  test("matches exact reviewed exceptions and reports binding changes and stale entries", async (t) => {
    const { root, write, check, cli: verify } = await workspace(t);
    const path = "packages/library/src/pending.ts";
    await write(path, 'import type { Value } from "./index.ts";');
    const exception = {
      rule: "internal-root-barrel",
      from: path,
      to: "packages/library/src/index.ts",
      specifier: "./index.ts",
      kind: "import",
      typeOnly: true,
      bindings: ["type:Value"],
      owner: "Fixture maintainers",
      reason: "Awaiting leaf extraction.",
      removeWhen: "Import the leaf directly.",
    };
    const exceptions = { version: 1, exceptions: [exception] };
    assert.equal((await check({ exceptions })).ok, true);
    await write("exceptions.json", JSON.stringify(exceptions));
    const { stdout } = await verify(["--exceptions", join(root, "exceptions.json"), "--json"]);
    assert.equal(JSON.parse(stdout).baseline.length, 1);
    for (const [code, expected] of [
      [
        'import type { Value, value } from "./index.ts";',
        ["internal-root-barrel", "stale-exception"],
      ],
      ['import { Value } from "./index.ts";', ["internal-root-barrel", "stale-exception"]],
      ['import type { Value } from "./leaf.ts";', ["stale-exception"]],
    ]) {
      await write(path, code);
      assert.deepEqual(rules(await check({ exceptions })), expected, code);
    }
    for (const [invalid, message] of [
      [{ version: 2, exceptions: [] }, "Unsupported module-boundary exceptions version."],
      [{ version: 1, exceptions: {} }, "Invalid module-boundary exceptions."],
      [
        { version: 1, exceptions: [{ ...exception, owner: "" }] },
        "Exceptions require an exact edge, reason, removal condition and capability owner.",
      ],
      [{ version: 1, exceptions: [exception, exception] }, "Duplicate module-boundary exception."],
    ]) {
      await assert.rejects(check({ exceptions: invalid }), { message });
    }
  });

  test("binds cycle exceptions to the complete cycle edge set", async (t) => {
    const { write, check } = await workspace(t);
    await write("apps/app/src/cycle-a.mjs", 'import "./cycle-b.mjs"; export const a = 1;');
    await write("apps/app/src/cycle-b.mjs", 'import "./cycle-a.mjs"; export const b = 2;');
    const cycle = (await check()).violations.find((item) => item.rule === "runtime-cycle");
    assert.ok(cycle);
    const exceptions = exceptionsFor(cycle);
    assert.equal((await check({ exceptions })).ok, true);
    await write(
      "apps/app/src/cycle-a.mjs",
      'import "./cycle-b.mjs"; export { b } from "./cycle-b.mjs"; export const a = 1;',
    );
    assert.deepEqual(rules(await check({ exceptions })), ["runtime-cycle", "stale-exception"]);
  });

  test("rejects empty source selections instead of reporting a passing boundary check", async (t) => {
    // An empty policy or directory must not make CI report a successful scan.
    await settle(
      [[], ["empty"]].map(async (sourceRoots) => {
        const { root, check, cli: verify } = await workspace(t, { sourceRoots, packages: [] });
        await mkdir(join(root, "empty"));
        await assert.rejects(check(), /No source files selected/);
        const error = await failure(verify(["--json"]), 2);
        assert.match(error.stderr, /No source files selected/);
        assert.equal(error.stdout, "");
      }),
    );
  });

  test("rejects unknown policy and boundary fields instead of silently ignoring typos", async (t) => {
    const { write, check, cli: verify } = await workspace(t);
    await write("apps/app/src/policy-a.mjs", 'import "./policy-b.mjs";');
    await write("apps/app/src/policy-b.mjs", 'import "./policy-a.mjs";');
    const correct = { ...policy, cycles: { runtime: "error" } };
    assert.ok(
      (await check({ policy: correct })).violations.some((item) => item.rule === "runtime-cycle"),
    );
    const typo = { ...policy, cycle: { runtime: "error" } };
    delete typo.cycles;
    await assert.rejects(check({ policy: typo }), /Unknown policy field/);
    await write("policy.json", JSON.stringify(typo));
    for (const error of await settle([[], ["--json"]].map((json) => failure(verify(json), 2)))) {
      assert.match(error.stderr, /Unknown policy field/);
    }
    await assert.rejects(
      check({
        policy: {
          ...policy,
          boundaries: [
            {
              rule: "bad",
              message: "bad",
              from: ["apps/app/src/**"],
              to: ["packages/library/src/**"],
              exceptto: ["packages/library/src/**"],
            },
          ],
        },
      }),
      /Unknown boundary field/,
    );
  });

  test("requires explicit valid policy and reports CLI success, violations and configuration failures", async (t) => {
    const {
      root,
      write,
      check,
      args,
      cli: verify,
      cliProcess,
    } = await workspace(t, {
      diagnosticLimit: 1,
    });
    // Success and violations through a real child: its exit status and output streams.
    const passed = await cliProcess(["--json"]);
    assert.equal(passed.stderr, "");
    assert.deepEqual(JSON.parse(passed.stdout), await check());
    await write("apps/app/src/invalid.mjs", 'import "./missing-a.mjs"; import "./missing-b.mjs";');
    await write("malformed.json", "{");
    await write("invalid.json", JSON.stringify({ ...policy, diagnosticLimit: 0 }));
    const [text, json, ...configuration] = await settle([
      failure(cliProcess(), 1),
      failure(verify(["--json"]), 1),
      ...[
        ["--root", root],
        ["--root", root, "--policy", join(root, "malformed.json")],
        ["--root", root, "--policy", join(root, "invalid.json")],
      ].map((options) => failure(cliInProcess(options), 2)),
      // A configuration failure without an error code, through a real child.
      failure(node([cli, ...args, "--unknown"]), 2),
    ]);
    assert.match(text.stderr, /1 additional violations/);
    assert.equal(
      text.stderr.split("\n").filter((line) => line.includes("[unresolved-local-import]")).length,
      1,
    );
    assert.equal(JSON.parse(json.stdout).violations.length, 2);
    for (const error of configuration) {
      assert.notEqual(error.stderr.trim(), "");
    }
    await assert.rejects(verifyModuleBoundaries({ root }), {
      message: "An explicit module-boundary policy is required.",
    });
    // Each policy has one mistake, refused by its own validation check.
    const boundary = { rule: "invalid", message: "bad", from: ["apps/**"], to: ["packages/**"] };
    for (const [change, message] of [
      [{ version: 2 }, "Unsupported module-boundary policy version."],
      [{ sourceRoots: ["../outside"] }, "Invalid policy field: sourceRoots"],
      [{ rootBarrels: ["packages/library/src/*.ts"] }, "Invalid policy field: rootBarrels"],
      [{ workspaceNamespaces: ["@fixture"] }, "Invalid policy field: workspaceNamespaces"],
      [{ boundaries: {} }, "Invalid policy field: boundaries"],
      [{ boundaries: [{ ...boundary, message: " " }] }, "Boundaries require a rule and message."],
      [{ boundaries: [{ ...boundary, from: ["../apps/**"] }] }, "Invalid boundary field: from"],
      [
        { boundaries: [{ ...boundary, specifiers: ["@fixture/*-internal"] }] },
        "Invalid boundary field: specifiers",
      ],
      [
        { boundaries: [{ rule: "invalid", message: "bad", from: ["apps/**"] }] },
        "Boundaries require source patterns and target paths or specifiers.",
      ],
      [{ boundaries: [{ ...boundary, kinds: ["eval"] }] }, "Invalid boundary field: kinds"],
      [{ packageImports: [] }, "Invalid policy field: packageImports"],
      [{ cycles: { runtime: "allow" } }, "Invalid policy field: cycles.runtime"],
    ]) {
      await assert.rejects(check({ policy: { ...policy, ...change } }), { message });
    }
  });

  test("keeps known specifier policy when the loader has been reassigned", async (t) => {
    const source = "apps/app/src/specifier-loader.mjs";
    const {
      write,
      check,
      observe,
      cli: verify,
    } = await workspace(t, {
      boundaries: [
        {
          rule: "no-fs",
          from: [source],
          specifiers: ["fs"],
          kinds: ["require"],
          message: "Do not load fs.",
        },
      ],
    });
    const loader = `import { createRequire } from "node:module";
       let load = createRequire(import.meta.url);
       load = createRequire(import.meta.url);`;
    const report = await observe(
      source,
      `${loader}\nconst name = "fs";\nconsole.log(typeof load(name).readFile);`,
      "function",
    );
    const unresolved = violation(report, source);
    assert.equal(unresolved.specifier, "fs");
    assert.ok(violates(report, source, "no-fs"));
    const accepted = await check({ exceptions: exceptionsFor(unresolved) });
    assert.equal(accepted.ok, false);
    assert.equal(accepted.baseline.length, 1);
    assert.ok(accepted.violations.some((item) => item.rule === "no-fs"));
    const boundaryOnly = await check({
      exceptions: exceptionsFor(violation(report, source, "no-fs")),
    });
    assert.equal(boundaryOnly.ok, false);
    assert.ok(boundaryOnly.violations.some((item) => item.rule === dynamic));
    await write(source, `${loader}\nload(process.env.PRIVATE_EXPRESSION_MARKER ?? "fs");`);
    const unknown = await check();
    assert.match(violation(unknown, source).specifier, /^unknown:sha256:/);
    assert.equal(JSON.stringify(unknown).includes("PRIVATE_EXPRESSION_MARKER"), false);
    for (const error of await settle([[], ["--json"]].map((json) => failure(verify(json), 1)))) {
      assert.equal((error.stdout + error.stderr).includes("PRIVATE_EXPRESSION_MARKER"), false);
    }
  });

  test("does not reuse one unknown-loader exception for a distinct loader", async (t) => {
    const source = "apps/app/src/public/load.mjs";
    const { write, check, native, decoys, anchors, reviewLoader } = await workspace(t, {
      boundaries: [noPrivate(source, { kinds: ["require"] })],
    });
    await decoys("secret.cjs");
    await anchors("public", "private");
    const first = `import { createRequire } from "node:module";
let a = createRequire(import.meta.url);
a = createRequire(new URL("./anchor.cjs", import.meta.url));
console.log(a("./secret.cjs"));
`;
    const second = `let b = createRequire(import.meta.url);
b = createRequire(new URL("../private/anchor.cjs", import.meta.url));
console.log(b("./secret.cjs"));
`;
    await write(source, first);
    const { item: unresolved, exceptions } = await reviewLoader(source);
    const count = (report) =>
      report.violations.filter((item) => item.from === source && item.rule === dynamic).length;
    await write(source, first + 'console.log(a("./secret.cjs"));');
    assert.equal(await native(source), "PUBLIC\nPUBLIC");
    const repeated = await check({ exceptions });
    assert.equal(repeated.baseline.length, 1);
    assert.equal(count(repeated), 1);
    await write(source, first + second);
    assert.equal(await native(source), "PUBLIC\nPRIVATE");
    const changed = await check({ exceptions });
    assert.equal(changed.baseline.length, 1);
    assert.equal(changed.ok, false);
    assert.equal(count(changed), 1);
    assert.notEqual(changed.violations[0].loaderIdentity, unresolved.loaderIdentity);
    await write(source, first.replace("./anchor.cjs", "../private/anchor.cjs"));
    assert.equal(await native(source), "PRIVATE");
    const stale = (report) =>
      ["stale-exception", dynamic].every((rule) =>
        report.violations.some((item) => item.rule === rule),
      );
    assert.ok(stale(await check({ exceptions })));
    await write(source, first);
    const oldStyle = exceptionsFor({ ...unresolved, loaderIdentity: undefined });
    assert.ok(stale(await check({ exceptions: oldStyle })));
  });

  test("does not reuse unknown-anchor exceptions across distinct loaders", async (t) => {
    const source = "apps/app/src/public/unknown-loads.mjs";
    const { root, write, check, native, decoys, anchors, reviewLoader } = await workspace(t, {
      boundaries: [],
    });
    await decoys("secret.cjs");
    await anchors("public", "private");
    const env = {
      ...process.env,
      PUBLIC_ANCHOR: join(root, "apps/app/src/public/anchor.cjs"),
      PRIVATE_ANCHOR: join(root, "apps/app/src/private/anchor.cjs"),
    };
    const requireFirst = `import { createRequire } from "node:module";
const a = createRequire(process.env.PUBLIC_ANCHOR);
console.log(a("./secret.cjs"));
`;
    const requireSecond = `const b = createRequire(process.env.PRIVATE_ANCHOR);
console.log(b("./secret.cjs"));
`;
    await write(source, requireFirst);
    const { exceptions } = await reviewLoader(source);
    await write(source, requireFirst + requireSecond);
    assert.equal(await native(source, { env }), "PUBLIC\nPRIVATE");
    const distinct = await check({ exceptions });
    assert.equal(distinct.baseline.length, 1);
    assert.ok(violates(distinct, source));
  });

  test("does not reuse an unknown-path exception for a different lexical binding", async (t) => {
    const source = "apps/app/src/public/dynamic-loads.mjs";
    const { write, check, native, decoys, reviewLoader } = await workspace(t, {
      boundaries: [],
    });
    await decoys("secret.mjs");
    const env = {
      ...process.env,
      PUBLIC_PATH: "./secret.mjs",
      PRIVATE_PATH: "../private/secret.mjs",
    };
    const loader = (name, variable) => `async function ${name}() {
  const target = process.env.${variable};
  console.log((await import(target)).default);
}
await ${name}();
`;
    const first = loader("publicLoad", "PUBLIC_PATH");
    await write(source, first);
    const { exceptions } = await reviewLoader(source);
    await write(source, first.replace("PUBLIC_PATH", "PRIVATE_PATH"));
    assert.equal(await native(source, { env }), "PRIVATE");
    const changedBinding = await check({ exceptions });
    assert.ok(changedBinding.violations.some((value) => value.rule === "stale-exception"));
    assert.ok(changedBinding.violations.some((value) => value.rule === dynamic));
    await write(source, first + loader("privateLoad", "PRIVATE_PATH"));
    assert.equal(await native(source, { env }), "PUBLIC\nPRIVATE");
    const changed = await check({ exceptions });
    assert.equal(changed.baseline.length, 1);
    assert.ok(violates(changed, source));
  });

  test("binds an unknown-load exception to the whole source once its provenance trace hits the limit", async (t) => {
    const source = "apps/app/src/public/long-chain.mjs";
    const { write, check } = await workspace(t, { boundaries: [] });
    // An unknown import whose target flows through `links` local constants.
    const chain = (links) =>
      [
        'const s0 = "./secret.mjs";',
        ...Array.from({ length: links - 1 }, (_, index) => `const s${index + 1} = s${index};`),
        `function pick() { return s${links - 1}; }`,
        "await import(pick());",
      ].join("\n");
    // Below the 64-symbol limit the identity covers only the chain, so an unrelated
    // statement keeps the exception; past it, any source change invalidates it.
    for (const [links, kept] of [
      [8, true],
      [80, false],
    ]) {
      await write(source, chain(links));
      const exceptions = exceptionsFor(violation(await check(), source));
      assert.equal((await check({ exceptions })).ok, true, `${links} links`);
      await write(source, `${chain(links)}\nconsole.log("unrelated");`);
      const edited = await check({ exceptions });
      assert.equal(edited.ok, kept, `${links} links`);
      assert.equal(violates(edited, source, "stale-exception"), !kept, `${links} links`);
    }
  });

  test("invalidates an unknown-path exception when its imported provider changes", async (t) => {
    const source = "apps/app/src/public/provider-load.mjs";
    const { write, check, native, observe, decoys } = await workspace(t, { boundaries: [] });
    await decoys("secret.mjs");
    await write("apps/app/src/public/provider.mjs", 'export const select = () => "./secret.mjs";');
    await write(
      "apps/app/src/public/other.mjs",
      'export const select = () => "../private/secret.mjs";',
    );
    const first = `import { select } from "./provider.mjs";
console.log((await import(select())).default);
`;
    const exceptions = exceptionsFor(violation(await observe(source, first, "PUBLIC"), source));
    assert.equal((await check({ exceptions })).ok, true);
    await write(source, first.replace("./provider.mjs", "./other.mjs"));
    assert.equal(await native(source), "PRIVATE");
    const changed = await check({ exceptions });
    assert.ok(changed.violations.some((value) => value.rule === "stale-exception"));
    assert.ok(changed.violations.some((value) => value.rule === dynamic));
  });

  test("invalidates unknown-load exceptions when destructured sources change", async (t) => {
    const source = "apps/app/src/public/destructured.mjs";
    const load = (target) => `console.log((await import(${target})).default);`;
    // After `setup`, writes MODULE_TARGET through `receiver` and imports process.env.MODULE_TARGET.
    const viaEnv = (setup, receiver) => (path) =>
      `${setup}${receiver}.MODULE_TARGET = "${path}"; ${load("process.env.MODULE_TARGET")}`;
    const forms = {
      object: (path) => `const { target } = { target: "${path}" };\n${load("target")}`,
      array: (path) => `const [target] = ["${path}"];\n${load("target")}`,
      nestedDefault: (path) =>
        `const { outer: { target = "${path}" } = {} } = { outer: {} };\n${load("target")}`,
      transitive: (path) =>
        `const origin = "${path}";\nconst provider = { target: origin };\nconst { target } = provider;\n${load("target")}`,
      iteration: (path) => `for (const { target } of [{target: "${path}"}]) ${load("target")}`,
      parameter: (path) =>
        `async function load({target} = {target: "${path}"}) { ${load("target")} }\nawait load();`,
      parameterCaller: (path) =>
        `async function load({target}) { ${load("target")} }\nawait load({target: "${path}"});`,
      catchValue: (path) =>
        `try { throw {target: "${path}"}; } catch ({target}) { ${load("target")} }`,
      propertyWrite: (path) =>
        `const provider = { target: "./secret.mjs" };\nprovider.target = "${path}";\nconst {target} = provider;\n${load("target")}`,
      plainParameter: (path) =>
        `async function load(target) { ${load("target")} }\nawait load("${path}");`,
      plainProperty: (path) =>
        `const config = {target: "./secret.mjs"};\nconfig.target = "${path}";\n${load("config.target")}`,
      computedProperty: (path) =>
        `const config = {target: "./secret.mjs"};\nconfig["target"] = "${path}";\nconst chosen = config["target"];\n${load("chosen")}`,
      classField: (path) =>
        `class Loader { target = "./secret.mjs"; async load() { ${load("this.target")} } }\nconst loader = new Loader(); loader.target = "${path}"; await loader.load();`,
      inheritedGetter: (path) =>
        `class Base { get target() { return this.path; } }\nclass Loader extends Base { async load() { ${load("super.target")} } }\nconst loader = new Loader(); loader.path = "${path}"; await loader.load();`,
      callReceiver: (path) =>
        `const config = {target: "./secret.mjs"}; const get = () => config;\nconfig.target = "${path}"; ${load("get().target")}`,
      parenthesizedReceiver: (path) =>
        `const config = {target: "./secret.mjs"}; const get = () => config;\nconfig.target = "${path}"; ${load("(get()).target")}`,
      conditionalReceiver: (path) =>
        `const config = {target: "./secret.mjs"}; const other = {target: "./secret.mjs"};\nconfig.target = "${path}"; ${load("(true ? config : other).target")}`,
      importMetaProperty: (path) => `import.meta.target = "${path}"; ${load("import.meta.target")}`,
      importMetaNested: (path) =>
        `import.meta.config = {target: "${path}"}; ${load("import.meta.config.target")}`,
      globalAssign: (path) =>
        `Object.assign(globalThis, {target: "${path}"}); ${load("globalThis.target")}`,
      globalBare: (path) => `Object.assign(globalThis, {target: "${path}"}); ${load("target")}`,
      shadowedGlobal: (path) =>
        `const globalThis = {target: "${path}"}; ${load("globalThis.target")}`,
      globalObject: (path) => `globalThis.config = {target: "${path}"}; ${load("config.target")}`,
      environmentWrite: viaEnv("", "process.env"),
      environmentObjectAlias: viaEnv("const box = { env: process.env }; ", "box.env"),
      environmentArrayAlias: viaEnv("const box = [(process.env)]; ", "box[0]"),
      environmentNestedAlias: viaEnv(
        'const box = { nested: [{env: process["env"]}] }; ',
        "box.nested[0].env",
      ),
      environmentSpreadAlias: viaEnv("const box = {...{env: process.env}}; ", "box.env"),
      environmentComputedAlias: viaEnv(
        'const key = "env"; const box = { env: process[key] }; ',
        "box.env",
      ),
      environmentMethodAlias: viaEnv("const box = process.env.valueOf(); ", "box"),
      environmentWrappedMethodAlias: viaEnv('const box = (process.env["valueOf"])(); ', "box"),
      processShorthandAlias: viaEnv("const box = { process }; ", "box.process.env"),
      environmentReturnAlias: viaEnv("const get = () => process.env; const box = get(); ", "box"),
      environmentConditionalAlias: viaEnv("const box = true ? process.env : {}; ", "box"),
      globalShorthandAlias: viaEnv("const box = {global}; ", "box.global.process.env"),
      globalThisShorthandAlias: viaEnv("const box = {globalThis}; ", "box.globalThis.process.env"),
      globalEnvironmentWrite: viaEnv("", "global.process.env"),
      globalThisEnvironmentWrite: viaEnv("", "globalThis.process.env"),
      boundedChain: (path) =>
        `const origin = "${path}";\n` +
        Array.from(
          { length: 80 },
          (_, index) => `const value${index} = ${index ? `value${index - 1}` : "origin"};`,
        ).join("\n") +
        `\nconst { target } = { target: value79 };\n${load("target")}`,
    };
    // Each form gets its own workspace, so the forms run concurrently.
    await settle(
      Object.entries(forms).map(([name, makeSource]) =>
        t.test(name, async (st) => {
          const { write, check, native, observe, decoys, reviewLoader } = await workspace(st, {
            boundaries: [noPrivate(source)],
          });
          await decoys("secret.mjs");
          const publicSource = makeSource("./secret.mjs");
          const observed = await observe(source, publicSource, "PUBLIC");
          const { item, exceptions } = await reviewLoader(source, observed);
          await write(source, makeSource("../private/secret.mjs"));
          assert.equal(await native(source), "PRIVATE");
          const changed = await check({ exceptions });
          assert.ok(changed.violations.some((value) => value.rule === "stale-exception"));
          const unresolved = violation(changed, source);
          assert.ok(unresolved);
          assert.notEqual(unresolved.loaderIdentity, item.loaderIdentity);
          assert.equal(JSON.stringify(changed).includes("../private/secret.mjs"), false);
        }),
      ),
    );
  });

  test("keeps direct environment reads and lexical shadows independent of unrelated source", async (t) => {
    const source = "apps/app/src/public/env-read.mjs";
    const { write, check, observe } = await workspace(t);
    await write("apps/app/src/public/secret.mjs", 'export default "PUBLIC";');
    const env = { ...process.env, MODULE_TARGET: "./secret.mjs" };
    const makeSource = (value) =>
      `function example(process) { return { env: process.env, value: "${value}" }; }
       const holder = { process: "${value}" }; holder.process;
       const {process: ignored} = JSON.parse('{"process":0}'); void ignored;
       console.log((await import(process.env.MODULE_TARGET)).default);`;
    const item = violation(await observe(source, makeSource("one"), "PUBLIC", { env }), source);
    assert.ok(item);
    await write(source, makeSource("two"));
    assert.equal((await check({ exceptions: exceptionsFor(item) })).ok, true);
  });

  test("invalidates unknown-load exceptions after deleting an environment property", async (t) => {
    const source = "apps/app/src/public/delete-env.mjs";
    const env = { ...process.env, BOUNDARY_SELECTED: "./secret.mjs" };
    // Dot and computed deletes use separate workspaces and run concurrently.
    await settle(
      [false, true].map(async (computed) => {
        const { write, check, native, observe, decoys, reviewLoader } = await workspace(t);
        await decoys("secret.mjs");
        const makeSource = (property) =>
          `delete process.env${computed ? `["${property}"]` : `.${property}`};
         console.log((await import(process.env.BOUNDARY_SELECTED ?? "../private/secret.mjs")).default);`;
        const publicSource = makeSource("BOUNDARY_UNRELATED");
        const observed = await observe(source, publicSource, "PUBLIC", { env });
        const { exceptions } = await reviewLoader(source, observed);
        await write(source, makeSource("BOUNDARY_SELECTED"));
        assert.equal(await native(source, { env }), "PRIVATE");
        const changed = await check({ exceptions });
        assert.ok(changed.violations.some((item) => item.rule === "stale-exception"));
        assert.ok(changed.violations.some((item) => item.rule === dynamic));
      }),
    );
  });

  test("fails closed when import.meta.url can be changed", async (t) => {
    const source = "apps/app/src/public/meta-load.mjs";
    const { observe, decoys, closed } = await workspace(t, { boundaries: [noPrivate(source)] });
    await decoys("secret.mjs");
    const load =
      'console.log((await import(new URL("./secret.mjs", import.meta.url).href)).default);';
    assert.equal((await observe(source, load, "PUBLIC")).ok, true);
    for (const setup of [
      'import.meta.url = new URL("../private/", import.meta.url).href;',
      'import.meta["url"] = new URL("../private/", import.meta.url).href;',
      'const meta = import.meta; meta.url = new URL("../private/", meta.url).href;',
      'Object.defineProperty(import.meta, "url", {value: new URL("../private/", import.meta.url).href});',
    ]) {
      assert.equal((await closed(source, `${setup}\n${load}`)).ok, false);
    }
  });

  test("tracks the shared Node module loader and ignores binding property names", async (t) => {
    const source = "apps/app/src/public/prototype.cjs";
    const esm = "apps/app/src/public/property.mjs";
    const avoid = "apps/app/src/public/secret.cjs";
    const { write, check, native, decoys, closed, open } = await workspace(t, {
      boundaries: [noPrivate("apps/app/src/public/**", { kinds: ["require"] })],
    });
    await decoys("secret.cjs");
    await write("apps/app/src/public/secret.mjs", 'export default "PUBLIC";');
    for (const call of ['module.require("./secret.cjs")', 'require("./secret.cjs")']) {
      for (const assignment of [
        'const original = Module.prototype.require; Module.prototype.require = function() { return original.call(this, __dirname + "/../private/secret.cjs"); };',
        'const original = Module._load; Module._load = function() { return original(__dirname + "/../private/secret.cjs", module); };',
      ]) {
        await closed(
          source,
          `const Module = require("node:module"); ${assignment} console.log(${call});`,
          {
            avoid,
          },
        );
      }
      await write(
        source,
        `const Module = require("node:module"); void Module; console.log(${call});`,
      );
      assert.equal(await native(source), "PUBLIC");
      // Exposing Module can mutate its loader, so use a non-exposing positive control below.
    }
    await open(source, 'console.log(require("./secret.cjs"), module.require("./secret.cjs"));', {
      to: avoid,
      output: "PUBLIC PUBLIC",
    });
    const load =
      'console.log((await import(new URL("./secret.mjs", import.meta.url).href)).default);';
    for (const name of ["URL", "global", "globalThis"]) {
      await open(
        esm,
        `const {${name}: value} = JSON.parse('{"${name}":false}'); void value; ${load}`,
        { to: "apps/app/src/public/secret.mjs" },
      );
    }
    await write("apps/app/src/private/secret.mjs", 'export default "PRIVATE";');
    await closed(
      esm,
      `const box = {URL}; Object.defineProperty(box.URL.prototype, "href", {get() { return import.meta.url.replace("property.mjs", "../private/secret.mjs"); }}); ${load}`,
    );
    await write(esm, `const object = {[URL]: true}; void object; ${load}`);
    assert.ok(violates(await check(), esm));
  });

  test("observes the CommonJS module type without exposing its loader", async (t) => {
    const source = "apps/app/src/public/typeof-module.cjs";
    const { write, check, native, observe } = await workspace(t);
    await write("apps/app/src/public/secret.cjs", 'module.exports = "PUBLIC";');
    const quiet = (report) => !report.violations.some((item) => item.from === source);
    for (const observation of ["typeof module", "typeof (module)", "typeof (((module)))"]) {
      await write(
        source,
        `console.log(${observation}, require.resolve("./secret.cjs"), module.require("./secret.cjs"));`,
      );
      assert.match(await native(source), /^object .*secret\.cjs PUBLIC$/);
      const report = await check();
      assert.ok(quiet(report), observation);
      assert.ok(reaches(report, source, "apps/app/src/public/secret.cjs"));
    }
    await write(
      source,
      'function shadow(module) { return typeof (module); } console.log(shadow({}), require.resolve("./secret.cjs"));',
    );
    assert.match(await native(source), /^object .*secret\.cjs$/);
    assert.ok(quiet(await check()));
    for (const exposure of [
      "const box = {module}; void box;",
      "function expose(value) { return value; } expose(module);",
    ]) {
      const report = await observe(
        source,
        `${exposure} console.log(require("./secret.cjs"));`,
        "PUBLIC",
      );
      assert.ok(violates(report, source), exposure);
    }
  });
});
