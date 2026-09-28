import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import ts from "typescript-compiler-api";
import { verifyModuleBoundaries } from "../../scripts/verify-module-boundaries.mjs";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const fixture = new URL("../fixtures/module-boundaries/", import.meta.url);
const run = promisify(execFile);
const cli = join(repository, "scripts/verify-module-boundaries.mjs");
const policy = JSON.parse(await readFile(new URL("policy.json", fixture), "utf8"));

async function workspace(t, overrides = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "module-boundaries-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, { recursive: true });
  const config = { ...policy, ...overrides };
  const write = async (path, content) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await write("policy.json", JSON.stringify(config));
  return {
    root,
    write,
    check: (extra = {}) => verifyModuleBoundaries({ root, policy: config, ...extra }),
    args: ["--root", root, "--policy", join(root, "policy.json")],
  };
}

const rules = (report) => report.violations.map((item) => item.rule).sort();
const from = (report, path) => report.edges.filter((edge) => edge.from === path);

test("keeps native package error diagnostics independent of the workspace path", async (t) => {
  const { root, write, args } = await workspace(t);
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/library"), join(root, "node_modules/@fixture/library"), "dir");
  await write("apps/app/src/blocked.cjs", 'require("@fixture/library/blocked");');
  await assert.rejects(run(process.execPath, [cli, ...args, "--json"]), (error) => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    const violation = report.violations.find((item) => item.from === "apps/app/src/blocked.cjs");
    assert.equal(violation.rule, "unsupported-package-export");
    assert.equal(error.stdout.includes(root), false);
    assert.match(violation.message, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
    return true;
  });
  await assert.rejects(run(process.execPath, [cli, ...args]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/);
    assert.equal((error.stdout + error.stderr).includes(root), false);
    return true;
  });
  await assert.rejects(
    run(process.execPath, [cli, "--root", root, "--policy", "missing.json"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /ENOENT/);
      assert.equal(error.stderr.includes(root), false);
      return true;
    },
  );
});

test("keeps malformed JSON content and paths out of text and JSON CLI diagnostics", async (t) => {
  const { root, write, args } = await workspace(t);
  const marker = "/x_path/5";
  for (const [path, extra] of [
    ["bad-policy.json", ["--root", root, "--policy", join(root, "bad-policy.json")]],
    ["bad-exceptions.json", [...args, "--exceptions", join(root, "bad-exceptions.json")]],
    ["packages/library/package.json", args],
    ["apps/app/src/package.json", args],
  ]) {
    const original = await readFile(join(root, path), "utf8").catch(() => null);
    await write(path, marker);
    for (const json of [false, true]) {
      await assert.rejects(
        run(process.execPath, [cli, ...extra, ...(json ? ["--json"] : [])]),
        (error) => {
          assert.equal(error.code, 2);
          const output = error.stdout + error.stderr;
          assert.match(output, /Invalid JSON/);
          assert.equal(output.includes(marker), false);
          assert.equal(output.includes(root), false);
          return true;
        },
      );
    }
    if (original === null) {
      await rm(join(root, path));
    } else {
      await write(path, original);
    }
  }
});

test("uses Node ESM lookup without CommonJS global search paths", async (t) => {
  const { root, write, args } = await workspace(t);
  const global = join(root, "global-modules");
  await write(
    "global-modules/@fixture/library/package.json",
    JSON.stringify({
      name: "@fixture/library",
      exports: { "./leaf": "./leaf.cjs" },
    }),
  );
  await write("global-modules/@fixture/library/leaf.cjs", "module.exports = 1;");
  await write("apps/app/src/global-esm.mjs", 'import "@fixture/library/leaf";');
  await write("apps/app/src/global-require.cjs", 'require("@fixture/library/leaf");');
  const env = { ...process.env, NODE_PATH: global };
  const oracle = await run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createRequire } from "node:module";
    let esm; try { esm = import.meta.resolve("@fixture/library/leaf"); } catch (error) { esm = error.code; }
    console.log(JSON.stringify({ esm, cjs: createRequire(import.meta.url).resolve("@fixture/library/leaf") }));
  `,
    ],
    { cwd: join(root, "apps/app/src"), env },
  );
  const native = JSON.parse(oracle.stdout);
  assert.equal(native.esm, "ERR_MODULE_NOT_FOUND");
  assert.ok(native.cjs.startsWith(global));
  const normal = JSON.parse(
    (
      await run(process.execPath, [cli, ...args, "--json"], {
        env: { ...process.env, NODE_PATH: "" },
      })
    ).stdout,
  );
  assert.equal(normal.ok, true);
  await assert.rejects(run(process.execPath, [cli, ...args, "--json"], { env }), (error) => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.equal(
      report.violations.some((item) => item.from === "apps/app/src/global-esm.mjs"),
      false,
    );
    assert.ok(
      report.violations.some(
        (item) =>
          item.from === "apps/app/src/global-require.cjs" &&
          item.rule === "workspace-package-mismatch",
      ),
    );
    return true;
  });
});

test("fails closed when the selected declaration is outside the source graph", async (t) => {
  const source = "apps/app/src/private-type.ts";
  const boundary = {
    rule: "forbid-hidden-type",
    from: [source],
    to: ["packages/library/types/**"],
    message: "Use the public type.",
  };
  const { root, write, check } = await workspace(t, { boundaries: [boundary] });
  await write("packages/library/types/hidden.d.ts", "export interface Private { value: string }");
  await write("packages/library/src/safe.mjs", "export const safe = true;");
  const manifestPath = join(root, "packages/library/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.exports["./private-type"] = { types: "./types/hidden.d.ts", import: "./src/safe.mjs" };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/library"), join(root, "node_modules/@fixture/library"), "dir");
  await write(
    source,
    'import type { Private } from "@fixture/library/private-type"; export type Result = Private;',
  );
  const native = ts.resolveModuleName(
    "@fixture/library/private-type",
    join(root, source),
    {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
    },
    ts.sys,
    undefined,
    undefined,
    ts.ModuleKind.ESNext,
  ).resolvedModule?.resolvedFileName;
  assert.equal(relative(root, native), "packages/library/types/hidden.d.ts");
  const excluded = await check();
  assert.equal(excluded.ok, false);
  assert.ok(
    excluded.violations.some(
      (item) => item.from === source && item.rule === "unresolved-local-import",
    ),
  );
  assert.equal(
    excluded.resolutions.find((item) => item.reference.from === source).to,
    "packages/library/types/hidden.d.ts",
  );
  assert.equal(
    from(excluded, source).some((item) => item.to === "packages/library/src/safe.mjs"),
    false,
  );
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
  const { root, write, check } = await workspace(t, { boundaries: [boundary] });
  await write(
    "packages/library/types/hidden.d.ts",
    'export declare const safe: boolean; export interface Private {} import type { Marker } from "../../../apps/app/src/mixed-import.ts";',
  );
  await write("packages/library/src/safe.mjs", "export const safe = true;");
  const manifestPath = join(root, "packages/library/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.exports["./mixed"] = { types: "./types/hidden.d.ts", import: "./src/safe.mjs" };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/library"), join(root, "node_modules/@fixture/library"), "dir");
  await write(
    sources[0],
    'import { safe, type Private } from "@fixture/library/mixed"; export interface Marker { value: Private }; export { safe };',
  );
  await write(sources[1], 'export { safe, type Private } from "@fixture/library/mixed";');
  const excluded = await check();
  for (const source of sources) {
    assert.ok(
      excluded.violations.some(
        (item) => item.from === source && item.typeOnly && item.rule === "unresolved-local-import",
      ),
    );
    assert.ok(
      from(excluded, source).some(
        (item) => !item.typeOnly && item.to === "packages/library/src/safe.mjs",
      ),
    );
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
    assert.ok(
      included.violations.some(
        (item) => item.from === source && item.typeOnly && item.rule === "forbid-hidden-type",
      ),
    );
    assert.ok(
      from(included, source).some(
        (item) => !item.typeOnly && item.to === "packages/library/src/safe.mjs",
      ),
    );
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
      (group) => group.includes(sources[0]) && group.includes("packages/library/types/hidden.d.ts"),
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
  const oracle = await run(
    process.execPath,
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
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "no-private",
        from: ["apps/app/src/public/**"],
        to: ["apps/app/src/private/**"],
        message: "No private imports.",
      },
    ],
  });
  await write("apps/app/src/public/chosen.cjs", 'module.exports = "PUBLIC";');
  await write("apps/app/src/private/chosen.cjs", 'module.exports = "PRIVATE";');
  await write("apps/app/src/public/chosen.mjs", 'export default "PUBLIC";');
  await write("apps/app/src/private/chosen.mjs", 'export default "PRIVATE";');
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
    await write(
      source,
      `const path = require("node:path"); ${setup}
       console.log(require(path.join(__dirname, "chosen.cjs")));`,
    );
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
    const report = await check();
    assert.ok(
      report.violations.some(
        (item) => item.from === source && item.rule === "unresolved-dynamic-import",
      ),
      setup,
    );
    assert.equal(
      from(report, source).some((item) => item.to.endsWith("/public/chosen.cjs")),
      false,
    );
  }
  for (const assignment of [
    'require.resolve = () => __dirname + "/../private/chosen.cjs";',
    'require["resolve"] = () => __dirname + "/../private/chosen.cjs";',
    'const alias = require; alias.resolve = () => __dirname + "/../private/chosen.cjs";',
    'Object.assign(require, {resolve: () => __dirname + "/../private/chosen.cjs"});',
  ]) {
    await write(source, `${assignment} console.log(require(require.resolve("./chosen.cjs")));`);
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
    const report = await check();
    assert.ok(
      report.violations.some(
        (item) => item.from === source && item.rule === "unresolved-dynamic-import",
      ),
      assignment,
    );
  }
  await write(
    source,
    `const mod = require("node:module");
     const factory = mod.createRequire;
     mod.createRequire = () => factory(__dirname + "/../private/anchor.cjs");
     const load = mod.createRequire(__filename);
     console.log(load("./chosen.cjs"));`,
  );
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
  assert.ok(
    (await check()).violations.some(
      (item) => item.from === source && item.rule === "unresolved-dynamic-import",
    ),
  );
  await write(
    source,
    `const mod = require("node:module");
     const alias = mod.Module;
     alias.createRequire = () => (name) => process.mainModule.require(name.replace("chosen.cjs", "../private/chosen.cjs"));
     const load = mod.createRequire(__filename);
     console.log(load("./chosen.cjs"));`,
  );
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
  assert.ok(
    (await check()).violations.some(
      (item) => item.from === source && item.rule === "unresolved-dynamic-import",
    ),
  );
  await rm(join(root, source));
  for (const assignment of [
    'URL = class { constructor(x, y) { return {href: new NativeURL("../private/chosen.mjs", y).href}; } };',
    'globalThis.URL = class { constructor(x, y) { return {href: new NativeURL("../private/chosen.mjs", y).href}; } };',
    'global.URL = class { constructor(x, y) { return {href: new NativeURL("../private/chosen.mjs", y).href}; } };',
    'global["URL"] = class { constructor(x, y) { return {href: new NativeURL("../private/chosen.mjs", y).href}; } };',
    'Object.assign(globalThis, {URL: class { constructor(x, y) { return {href: new NativeURL("../private/chosen.mjs", y).href}; } }});',
  ]) {
    await write(
      esm,
      `const NativeURL = URL; ${assignment}
       console.log((await import(new URL("./chosen.mjs", import.meta.url).href)).default);`,
    );
    assert.equal((await run(process.execPath, [join(root, esm)])).stdout.trim(), "PRIVATE");
    const report = await check();
    assert.ok(
      report.violations.some(
        (item) => item.from === esm && item.rule === "unresolved-dynamic-import",
      ),
      assignment,
    );
  }
  for (const declaration of [
    'import url from "node:url"; const U = url["URL"];',
    'import url from "node:url"; url.fileURLToPath = () => ""; const U = url["URL"];',
    'import url from "node:url"; const { URL: U } = url;',
    'import { URL as U } from "node:url";',
  ]) {
    await write(
      esm,
      `${declaration}
       Object.defineProperty(U.prototype, "href", {get() { return import.meta.url.replace("public/mutable-url.mjs", "private/chosen.mjs"); }});
       console.log((await import(new URL("./chosen.mjs", import.meta.url).href)).default);`,
    );
    assert.equal((await run(process.execPath, [join(root, esm)])).stdout.trim(), "PRIVATE");
    assert.ok(
      (await check()).violations.some(
        (item) => item.from === esm && item.rule === "unresolved-dynamic-import",
      ),
      declaration,
    );
  }
  await write(
    esm,
    'console.log((await import(new URL("./chosen.mjs", import.meta.url).href)).default);',
  );
  assert.equal((await run(process.execPath, [join(root, esm)])).stdout.trim(), "PUBLIC");
  assert.ok(from(await check(), esm).some((item) => item.to.endsWith("/public/chosen.mjs")));
  for (const declaration of [
    'import {URL as U} from "node:url";',
    'import url from "node:url"; const {URL: U} = url;',
    'import url from "node:url"; const U = url["URL"];',
  ]) {
    await write(
      esm,
      `${declaration} console.log((await import(new U("./chosen.mjs", import.meta.url).href)).default);`,
    );
    assert.equal((await run(process.execPath, [join(root, esm)])).stdout.trim(), "PUBLIC");
    assert.ok(
      from(await check(), esm).some((item) => item.to.endsWith("/public/chosen.mjs")),
      declaration,
    );
  }
  for (const [declaration, constructor] of [
    ['import {URL as U} from "node:url";', "(U)"],
    ['import * as url from "node:url";', "(url.URL)"],
    ["", "(URL)"],
  ]) {
    await write(
      esm,
      `${declaration} console.log((await import(new ${constructor}("./chosen.mjs", import.meta.url).href)).default);`,
    );
    assert.equal((await run(process.execPath, [join(root, esm)])).stdout.trim(), "PUBLIC");
    assert.ok(
      from(await check(), esm).some((item) => item.to.endsWith("/public/chosen.mjs")),
      constructor,
    );
  }
  await write(
    esm,
    `import {URL as U} from "node:url";
     Object.defineProperty((U).prototype, "href", {get() { return import.meta.url.replace("public/mutable-url.mjs", "private/chosen.mjs"); }});
     console.log((await import(new (U)("./chosen.mjs", import.meta.url).href)).default);`,
  );
  assert.equal((await run(process.execPath, [join(root, esm)])).stdout.trim(), "PRIVATE");
  assert.ok(
    (await check()).violations.some(
      (item) => item.from === esm && item.rule === "unresolved-dynamic-import",
    ),
  );
  await write(
    esm,
    'const global = {}; global.URL = class {}; console.log((await import(new URL("./chosen.mjs", import.meta.url).href)).default);',
  );
  assert.equal((await run(process.execPath, [join(root, esm)])).stdout.trim(), "PUBLIC");
  assert.ok(from(await check(), esm).some((item) => item.to.endsWith("/public/chosen.mjs")));
  for (const property of ["global", "globalThis", "URL"]) {
    await write(
      esm,
      `const settings = JSON.parse('{"${property}":false}'); void settings.${property};
       console.log((await import(new URL("./chosen.mjs", import.meta.url).href)).default);`,
    );
    assert.equal((await run(process.execPath, [join(root, esm)])).stdout.trim(), "PUBLIC");
    assert.ok(
      from(await check(), esm).some((item) => item.to.endsWith("/public/chosen.mjs")),
      property,
    );
  }
  await rm(join(root, esm));
  await write(
    source,
    'const path = require("node:path"); const alias = path.posix; console.log(require(alias.join(__dirname, "chosen.cjs")));',
  );
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
  assert.ok(from(await check(), source).some((item) => item.to.endsWith("/public/chosen.cjs")));
  for (const setup of [
    'const path = require("node:path"); const load = (path.join);',
    'const {join} = require("node:path"); const load = (join);',
  ]) {
    await write(source, `${setup} console.log(require(load(__dirname, "chosen.cjs")));`);
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
    assert.ok(from(await check(), source).some((item) => item.to.endsWith("/public/chosen.cjs")));
  }
  for (const [setup, callee] of [
    ['const path = require("node:path");', "(path.join)"],
    ['const {join} = require("node:path");', "(join)"],
  ]) {
    await write(source, `${setup} console.log(require(${callee}(__dirname, "chosen.cjs")));`);
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
    assert.ok(from(await check(), source).some((item) => item.to.endsWith("/public/chosen.cjs")));
  }
  await write(
    source,
    `const path = require("node:path");
     path.join = () => __dirname + "/../private/chosen.cjs";
     console.log(require((path.join)(__dirname, "chosen.cjs")));`,
  );
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
  assert.ok(
    (await check()).violations.some(
      (item) => item.from === source && item.rule === "unresolved-dynamic-import",
    ),
  );
});

test("fails closed for a non-native Node path flavor", async (t) => {
  const source = "apps/app/src/public/path-flavor.cjs";
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "no-private",
        from: ["apps/app/src/public/**"],
        to: ["apps/app/src/private/**"],
        message: "No private imports.",
      },
    ],
  });
  await write("apps/app/src/public/chosen.cjs", 'module.exports = "PUBLIC";');
  await write("apps/app/src/private/chosen.cjs", 'module.exports = "PRIVATE";');
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
    await write(
      source,
      `const path = require("node:path"); ${setup}
       console.log(require(alias.join(__dirname, "chosen.cjs")));`,
    );
    assert.equal(
      (await run(process.execPath, [join(root, source)])).stdout.trim(),
      process.platform === "win32" ? "PUBLIC" : "PRIVATE",
    );
    const report = await check();
    assert.ok(
      report.violations.some(
        (item) => item.from === source && item.rule === "unresolved-dynamic-import",
      ),
      setup,
    );
    assert.equal(
      from(report, source).some((item) => item.to.endsWith("/public/chosen.cjs")),
      false,
    );
  }
});

test("fails closed when CommonJS wrapper paths are reassigned", async (t) => {
  const source = "apps/app/src/public/wrapper.cjs";
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "no-private",
        from: ["apps/app/src/public/**"],
        to: ["apps/app/src/private/**"],
        kinds: ["require"],
        message: "No private imports.",
      },
    ],
  });
  await write("apps/app/src/public/chosen.cjs", 'module.exports = "PUBLIC";');
  await write("apps/app/src/private/chosen.cjs", 'module.exports = "PRIVATE";');
  const setup = 'const path = require("node:path");';
  const cases = [
    ['__dirname = path.join(__dirname, "../private");', '__dirname + "/chosen.cjs"'],
    ['__dirname += "/../private";', '__dirname + "/chosen.cjs"'],
    ['[__dirname] = [path.join(__dirname, "../private")];', '__dirname + "/chosen.cjs"'],
    [
      '({ dir: __dirname } = { dir: path.join(__dirname, "../private") });',
      '__dirname + "/chosen.cjs"',
    ],
    [
      '({ __dirname } = { __dirname: path.join(__dirname, "../private") });',
      '__dirname + "/chosen.cjs"',
    ],
    [
      '({ nested: { dir: __dirname = "" } } = { nested: { dir: path.join(__dirname, "../private") } });',
      '__dirname + "/chosen.cjs"',
    ],
    ['for (__dirname of [path.join(__dirname, "../private")]) {}', '__dirname + "/chosen.cjs"'],
    [
      '__filename = path.join(__dirname, "../private/anchor.cjs");',
      'path.join(path.dirname(__filename), "chosen.cjs")',
    ],
    [
      '[__filename] = [path.join(__dirname, "../private/anchor.cjs")];',
      'path.join(path.dirname(__filename), "chosen.cjs")',
    ],
  ];
  for (const [assignment, target] of cases) {
    await write(source, `${setup} ${assignment} console.log(require(${target}));`);
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
    const report = await check();
    assert.ok(
      report.violations.some(
        (item) => item.from === source && item.rule === "unresolved-dynamic-import",
      ),
      assignment,
    );
    assert.equal(
      from(report, source).some((item) => item.to === "apps/app/src/public/chosen.cjs"),
      false,
      assignment,
    );
  }
  await write(
    source,
    `${setup}
     const { createRequire } = require("node:module");
     __filename = path.join(__dirname, "../private/anchor.cjs");
     console.log(createRequire(__filename)("./chosen.cjs"));`,
  );
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
  const redirected = await check();
  assert.ok(
    redirected.violations.some(
      (item) => item.from === source && item.rule === "unresolved-dynamic-import",
    ),
  );
  assert.equal(
    from(redirected, source).some((item) => item.to === "apps/app/src/public/chosen.cjs"),
    false,
  );
  for (const assignment of [
    "__dirname++;",
    "++__filename;",
    "for (__dirname in {}) {}",
    "for (__filename of []) {}",
  ]) {
    await write(source, `${setup} ${assignment} require(__dirname + __filename);`);
    const report = await check();
    assert.ok(
      report.violations.some(
        (item) => item.from === source && item.rule === "unresolved-dynamic-import",
      ),
      assignment,
    );
  }
  for (const target of [
    'path.join(path.dirname(__filename), "chosen.cjs")',
    '__dirname + "/chosen.cjs"',
  ]) {
    await write(
      source,
      `${setup}
       function local(__dirname, __filename) { __dirname = "x"; __filename = "y"; }
       console.log(require(${target}));`,
    );
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
    const report = await check();
    assert.ok(from(report, source).some((item) => item.to === "apps/app/src/public/chosen.cjs"));
    assert.equal(report.violations.filter((item) => item.from === source).length, 0);
  }
});

test("fails closed when implicit CommonJS require is reassigned", async (t) => {
  const publicSource = "apps/app/src/public/main.cjs";
  const privateTarget = "apps/app/src/private/secret.cjs";
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "no-private",
        from: ["apps/app/src/public/**"],
        to: ["apps/app/src/private/**"],
        kinds: ["require"],
        message: "No private imports.",
      },
    ],
  });
  await write("apps/app/src/public/secret.cjs", 'module.exports = "PUBLIC";');
  await write(privateTarget, 'module.exports = "PRIVATE";');
  await write("apps/app/src/private/anchor.cjs", "");
  const setup =
    'const {createRequire} = require("node:module"); const path = require("node:path"); function anchor() { return path.join(__dirname, "../private/anchor.cjs"); }';
  for (const assignment of [
    "require = createRequire(anchor());",
    'require = createRequire(path.join(__dirname, "../private/anchor.cjs"));',
    "[require] = [createRequire(anchor())];",
    "({ require } = { require: createRequire(anchor()) });",
    "for (require of [createRequire(anchor())]) {}",
  ]) {
    await write(publicSource, `${setup} ${assignment} console.log(require("./secret.cjs"));`);
    assert.equal(
      (await run(process.execPath, [join(root, publicSource)])).stdout.trim(),
      "PRIVATE",
    );
    const report = await check();
    assert.ok(
      report.violations.some(
        (item) => item.from === publicSource && item.rule === "unresolved-dynamic-import",
      ),
      assignment +
        " " +
        JSON.stringify(report.resolutions.filter((item) => item.reference.from === publicSource)),
    );
    assert.equal(
      from(report, publicSource).some((item) => item.to === "apps/app/src/public/secret.cjs"),
      false,
    );
  }
  for (const assignment of ["require++;", "++require;", "for (require in {}) {}"]) {
    await write(publicSource, `${assignment} require("./secret.cjs");`);
    const report = await check();
    assert.ok(
      report.violations.some(
        (item) => item.from === publicSource && item.rule === "unresolved-dynamic-import",
      ),
      assignment,
    );
  }
  await write(
    publicSource,
    'function local(require) { require = () => 1; } console.log(require("./secret.cjs"));',
  );
  assert.equal((await run(process.execPath, [join(root, publicSource)])).stdout.trim(), "PUBLIC");
  const unassigned = await check();
  assert.ok(
    from(unassigned, publicSource).some((item) => item.to === "apps/app/src/public/secret.cjs"),
  );
});

test("fails closed when the implicit CommonJS module loader is reassigned", async (t) => {
  const source = "apps/app/src/public/module.cjs";
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "no-private",
        from: ["apps/app/src/public/**"],
        to: ["apps/app/src/private/**"],
        kinds: ["require"],
        message: "No private imports.",
      },
    ],
  });
  await write("apps/app/src/public/secret.cjs", 'module.exports = "PUBLIC";');
  await write("apps/app/src/private/secret.cjs", 'module.exports = "PRIVATE";');
  await write("apps/app/src/private/anchor.cjs", "");
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
    await write(source, `${setup} ${assignment} console.log(module.require("./secret.cjs"));`);
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
    const report = await check();
    assert.ok(
      report.violations.some(
        (item) => item.from === source && item.rule === "unresolved-dynamic-import",
      ),
      assignment,
    );
    assert.equal(
      from(report, source).some((item) => item.to === "apps/app/src/public/secret.cjs"),
      false,
    );
  }
  await write(
    source,
    'function local(module) { module = {}; } module.exports = 1; console.log(module.require("./secret.cjs"));',
  );
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
  assert.ok(
    from(await check(), source).some((item) => item.to === "apps/app/src/public/secret.cjs"),
  );
  await write(source, 'const alias = module; console.log(alias.require("./secret.cjs"));');
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
  assert.ok(
    from(await check(), source).some((item) => item.to === "apps/app/src/public/secret.cjs"),
  );
});

test("hides unknown expression contents while keeping exception identities distinct", async (t) => {
  const { write, check, args } = await workspace(t);
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
  for (const json of [false, true]) {
    await assert.rejects(
      run(process.execPath, [cli, ...args, ...(json ? ["--json"] : [])]),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal((error.stdout + error.stderr).includes("PRIVATE_"), false);
        return true;
      },
    );
  }
  const first = violations.find((item) => item.from === esm);
  const exceptions = {
    version: 1,
    exceptions: [{ ...first, owner: "fixture", reason: "fixture", removeWhen: "fixed" }],
  };
  assert.equal((await check({ exceptions })).baseline.length, 1);
  await write(esm, 'export const load = (name) => import("PRIVATE_CHANGED" + name);');
  const changed = await check({ exceptions });
  assert.ok(changed.violations.some((item) => item.rule === "stale-exception"));
  assert.ok(
    changed.violations.some(
      (item) => item.from === esm && item.rule === "unresolved-dynamic-import",
    ),
  );
});

test("rejects symbolic links in configured source roots and their ancestors", async (t) => {
  const { root, write, check, args } = await workspace(t);
  const outside = await mkdtemp(join(tmpdir(), "module-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "outside.mjs"), "export const outside = true;");
  await mkdir(join(outside, "nested"));
  await writeFile(join(outside, "nested", "outside.mjs"), "export const outside = true;");
  await symlink(outside, join(root, "linked"), "dir");
  await symlink(root, join(root, "self"), "dir");
  await mkdir(join(root, "outer"));
  await symlink(outside, join(root, "outer", "linked"), "dir");
  for (const sourceRoot of ["linked", "self/apps/app/src", "outer/linked/nested"]) {
    const invalid = { ...policy, sourceRoots: [sourceRoot], packages: [] };
    await assert.rejects(check({ policy: invalid }), /Source roots cannot traverse symbolic links/);
    await write("policy.json", JSON.stringify(invalid));
    await assert.rejects(run(process.execPath, [cli, ...args, "--json"]), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Source roots cannot traverse symbolic links/);
      return true;
    });
  }
  assert.equal((await check()).ok, true);
});

// These fixtures express caller-selected rules, without adopting architecture
// policy for the repository running this reusable analyzer.
test("discovers new sources and resolves public leaves and source extension mapping deterministically", async (t) => {
  const { root, write, check } = await workspace(t);
  let report = await check();
  assert.equal(report.ok, true, JSON.stringify(report.violations));
  assert.ok(
    report.edges.some(
      (edge) => edge.specifier === "./leaf.js" && edge.to === "packages/library/src/leaf.ts",
    ),
  );
  assert.ok(
    report.edges.some(
      (edge) =>
        edge.specifier === "@fixture/library/leaf" && edge.to === "packages/library/src/leaf.ts",
    ),
  );
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
  await write("apps/app/src/private/store.ts", "export const store = 1; export interface Store {}");
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
  const report = await check();
  assert.deepEqual(rules(report), [
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
  const { root, write, check } = await workspace(t);
  // A real package link makes Node an independent resolution oracle. Targets
  // throw if executed: both the oracle and analyzer must only resolve paths.
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/library"), join(root, "node_modules/@fixture/library"), "dir");
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
  const { stdout } = await run(
    process.execPath,
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
  const runtimeResolution = report.resolutions.find(
    (item) =>
      item.reference.from === path &&
      item.reference.kind === "import" &&
      item.reference.specifier === "@fixture/library/conditional",
  );
  assert.equal(runtimeResolution.runtimeTarget, importTarget);
  assert.equal(runtimeResolution.typeTarget, "packages/library/src/conditional.d.ts");
  const typeResolution = report.resolutions.find(
    (item) => item.reference.from === "apps/app/src/types.ts",
  );
  assert.equal(typeResolution.runtimeTarget, importTarget);
  assert.equal(typeResolution.typeTarget, "packages/library/src/conditional.d.ts");
});

test("honors Node's default node-addons export condition for import and require", async (t) => {
  const consumer = "apps/app/src/addons.mjs";
  const secret = "packages/library/src/secret.mjs";
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "forbidden-native-leaf",
        from: [consumer],
        to: [secret],
        message: "Use the public leaf.",
      },
    ],
  });
  const manifest = JSON.parse(await readFile(join(root, "packages/library/package.json"), "utf8"));
  manifest.exports["."] = { "node-addons": "./src/secret.mjs", default: "./src/safe.mjs" };
  await write("packages/library/package.json", JSON.stringify(manifest));
  for (const name of ["secret", "safe"]) {
    await write(
      `packages/library/src/${name}.mjs`,
      'throw new Error("Analyzer must not execute targets.");',
    );
  }
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/library"), join(root, "node_modules/@fixture/library"), "dir");
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
  const { stdout } = await run(
    process.execPath,
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
    {
      targets: from(report, consumer).map((edge) => edge.to),
      violations: rules(report),
    },
    {
      targets: [importTarget, requireTarget],
      violations: ["forbidden-native-leaf", "forbidden-native-leaf"],
    },
  );
});

test("matches native export-array fallback and keeps valid types separate from invalid runtime exports", async (t) => {
  const { root, write, check } = await workspace(t);
  const manifest = JSON.parse(await readFile(join(root, "packages/library/package.json"), "utf8"));
  manifest.exports["./array-null"] = [null, "./src/conditional.mjs"];
  manifest.exports["./array-invalid"] = ["../invalid.mjs", "./src/conditional.mjs"];
  manifest.exports["./invalid-runtime"] = {
    types: "./src/conditional.d.ts",
    default: "../invalid.mjs",
  };
  await write("packages/library/package.json", JSON.stringify(manifest));
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/library"), join(root, "node_modules/@fixture/library"), "dir");
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
  const { root, write, check } = await workspace(t);
  const manifestPath = join(root, "packages/library/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.exports["./types-only"] = { types: "./src/conditional.d.ts" };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/library"), join(root, "node_modules/@fixture/library"), "dir");
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
    report.violations.some((violation) => violation.from === source),
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
  const nativeLoader = createRequire(join(root, base, "load.mjs"));
  const directoryLoader = createRequire(join(root, base) + "/");
  const report = await check();
  assert.equal(report.ok, true, JSON.stringify(report.violations));
  assert.deepEqual(
    from(report, `${base}/load.mjs`)
      .filter((edge) => ["require", "dynamic-import"].includes(edge.kind))
      .map((edge) => edge.to)
      .sort(),
    ["./helper", "./indexed", "./selected"]
      .map((specifier) => relative(root, nativeLoader.resolve(specifier)))
      .sort(),
  );
  assert.deepEqual(
    from(report, `${base}/directory.mjs`)
      .filter((edge) => edge.kind === "require")
      .map((edge) => edge.to)
      .sort(),
    ["./helper", "./indexed"]
      .map((specifier) => relative(root, directoryLoader.resolve(specifier)))
      .sort(),
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
  const { root, write, args } = await workspace(t, {
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
  await mkdir(join(root, "node_modules/@fixture"), { recursive: true });
  await symlink(join(root, "packages/legacy"), join(root, "node_modules/@fixture/legacy"), "dir");
  const nativeTarget = relative(
    root,
    createRequire(join(root, consumer)).resolve("@fixture/legacy"),
  );
  assert.equal(nativeTarget, target);
  await rm(join(root, "node_modules/@fixture/legacy"));
  await assert.rejects(run(process.execPath, [cli, ...args, "--json"]), (error) => {
    assert.equal(error.code, 1);
    const report = JSON.parse(error.stdout);
    assert.deepEqual(rules(report), ["forbidden-main", "unresolved-local-import"]);
    const resolved = report.resolutions.find(
      (item) => item.reference.specifier === "@fixture/legacy",
    );
    assert.equal(resolved.status, "local");
    assert.equal(resolved.named, true);
    assert.equal(resolved.runtimeTarget, nativeTarget);
    assert.equal(resolved.typeTarget, "packages/legacy/src/entry.d.cts");
    assert.equal(report.violations.find((item) => item.rule === "forbidden-main").to, target);
    assert.equal(
      report.resolutions.find((item) => item.reference.specifier === "@fixture/outside").status,
      "unresolved",
    );
    return true;
  });
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
  const reports = [];
  for (const selectedRoot of [root, alias]) {
    await assert.rejects(
      run(process.execPath, [cli, "--root", selectedRoot, "--policy", "policy.json", "--json"]),
      (error) => {
        assert.equal(error.code, 1);
        const report = JSON.parse(error.stdout);
        assert.deepEqual(rules(report), [
          "forbidden-canonical",
          "forbidden-canonical",
          "unresolved-local-import",
        ]);
        assert.equal(
          report.violations.find((item) => item.rule === "forbidden-canonical").to,
          target,
        );
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
        reports.push(report);
        return true;
      },
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
  assert.ok(
    report.violations.some(
      (item) => item.from === source && item.rule === "unresolved-dynamic-import",
    ),
  );
});

test("rejects a registered package shadowed at the actual import and require anchors", async (t) => {
  const { root, write, check, args } = await workspace(t);
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
  await mkdir(join(root, "apps/app/src/node_modules/@fixture"), { recursive: true });
  await symlink(
    join(root, shadow),
    join(root, "apps/app/src/node_modules/@fixture/library"),
    "dir",
  );
  await write(
    "apps/app/src/shadow-import.mjs",
    'import { marker } from "@fixture/library"; console.log(marker);',
  );
  await write("apps/app/src/shadow-require.cjs", 'console.log(require("@fixture/library"));');
  await write(
    "apps/app/src/shadow-loader.mjs",
    'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); console.log(load("@fixture/library"));',
  );
  await write(
    `${shadow}/self.mjs`,
    'import { marker } from "@fixture/library"; console.log(marker);',
  );
  // Native Node must choose the nearer installed package, not the registered decoy.
  const sources = [
    "apps/app/src/shadow-import.mjs",
    "apps/app/src/shadow-require.cjs",
    "apps/app/src/shadow-loader.mjs",
    `${shadow}/self.mjs`,
  ];
  for (const source of sources) {
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "shadow");
  }
  const report = await check();
  for (const source of sources) {
    assert.ok(
      report.violations.some(
        (item) => item.from === source && item.rule === "workspace-package-mismatch",
      ),
    );
  }
  await assert.rejects(run(process.execPath, [cli, ...args, "--json"]), (error) => {
    assert.equal(error.code, 1);
    assert.ok(
      JSON.parse(error.stdout).violations.some(
        (item) => item.rule === "workspace-package-mismatch",
      ),
    );
    return true;
  });
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
  const observed = [];
  const expected = [];
  for (const [extension, type] of variants) {
    const base = "apps/app/src/scoped";
    const consumer = `${base}/b.${extension}`;
    const secret = `${base}/secret.${extension}`;
    const { write, check } = await workspace(t, {
      packages: ["apps/app"],
      sourceRoots: [base],
      boundaries: [
        { rule: "forbidden-secret", from: [consumer], to: [secret], message: "Use the safe leaf." },
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
    observed.push({
      extension,
      type,
      targets: from(report, consumer).map((edge) => edge.to),
      violations: rules(report),
      ok: report.ok,
    });
    expected.push({
      extension,
      type,
      targets: [secret],
      violations: ["forbidden-secret"],
      ok: false,
    });
  }
  assert.deepEqual(observed, expected);
});

test("uses the nearest unnamed package scope for CLI CommonJS loaders and extension overrides", async (t) => {
  for (const [extension, parentType, nestedType, commonjs] of [
    ["js", "module", "commonjs", true],
    ["js", "commonjs", "module", false],
    ["js", "module", undefined, true],
    ["cjs", "module", "module", true],
    ["cts", "module", "module", true],
    ["mjs", "commonjs", "commonjs", false],
    ["mts", "commonjs", "commonjs", false],
  ]) {
    const base = "apps/app/src/nested";
    const consumer = `${base}/load.${extension}`;
    const target = `${base}/secret.cjs`;
    const { root, write, args } = await workspace(t, {
      packages: ["apps/app"],
      sourceRoots: [base],
      boundaries: [
        { rule: "forbidden-scope", from: [consumer], to: [target], message: "Use the safe leaf." },
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
    const native = JSON.parse((await run(process.execPath, [join(root, probe)])).stdout);
    assert.equal(native.loader, commonjs);
    assert.equal(native.target && relative(root, native.target), commonjs ? target : null);
    const result = await run(process.execPath, [cli, ...args, "--json"]).catch((error) => {
      assert.equal(error.code, 1);
      return error;
    });
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
  }
});

test("does not preserve falsely known targets through reassigned paths or loaders", async (t) => {
  const { write, check } = await workspace(t);
  await write(
    "apps/app/src/reassigned.mjs",
    `
    import { createRequire } from "node:module";
    let target = "./index.ts";
    target = process.env.TARGET;
    await import(target);
    let load = createRequire(import.meta.url);
    load = (name) => name;
    load("./index.ts");
  `,
  );
  const report = await check();
  assert.equal(
    from(report, "apps/app/src/reassigned.mjs").some((edge) => edge.to === "apps/app/src/index.ts"),
    false,
  );
  assert.ok(
    report.violations.some(
      (edge) => edge.rule === "unresolved-dynamic-import" && edge.from.endsWith("reassigned.mjs"),
    ),
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
  const report = await check();
  assert.equal(report.ok, false);
  assert.ok(
    report.violations.some(
      (item) =>
        item.rule === "unresolved-dynamic-import" && item.from === "apps/app/src/cyclic-loader.mjs",
    ),
  );
  assert.equal(from(report, "apps/app/src/cyclic-loader.mjs").length, 0);
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
  assert.ok(
    report.violations.some(
      (item) =>
        item.rule === "unresolved-dynamic-import" &&
        item.from === "apps/app/src/cyclic-factory.mjs",
    ),
  );
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
  const { stdout } = await run(
    process.execPath,
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
  assert.equal(
    report.violations.filter((edge) => edge.rule === "unresolved-dynamic-import").length,
    3,
  );
  assert.equal(
    from(report, "apps/app/src/unknown.mjs").some((edge) => edge.to === "apps/app/src/index.ts"),
    false,
  );
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
  const report = await check();
  assert.ok(
    report.violations.some(
      (item) => item.rule === "source-syntax" && item.from === "apps/app/src/broken.ts",
    ),
  );
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
  await write("apps/app/src/cycles/runtime-b.ts", 'export { type A as B } from "./runtime-a.ts";');
  await write(
    "apps/app/src/cycles/mixed-a.ts",
    'import type { B } from "./mixed-b.ts"; export const a = 1;',
  );
  await write("apps/app/src/cycles/mixed-b.ts", 'import "./mixed-a.ts"; export interface B {}');
  await write("apps/app/src/query.ts", 'export type Query = import("./cycles/type-a.ts").A;');
  // Node keeps empty inline-type import/export declarations, evaluating targets.
  assert.match(stripTypeScriptTypes('import { type A } from "./a.ts";'), /import\s*\{\s*\}\s*from/);
  assert.match(stripTypeScriptTypes('export { type A } from "./a.ts";'), /export\s*\{\s*\}\s*from/);
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
    (await check({ policy: { ...policy, cycles: { runtime: "report", typeOnly: "report" } } })).ok,
    true,
  );
});

test("matches exact reviewed exceptions and reports binding changes and stale entries", async (t) => {
  const { root, write, check, args } = await workspace(t);
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
  const { stdout } = await run(process.execPath, [
    cli,
    ...args,
    "--exceptions",
    join(root, "exceptions.json"),
    "--json",
  ]);
  assert.equal(JSON.parse(stdout).baseline.length, 1);
  await write(path, 'import type { Value, value } from "./index.ts";');
  assert.deepEqual(rules(await check({ exceptions })), ["internal-root-barrel", "stale-exception"]);
  await write(path, 'import { Value } from "./index.ts";');
  assert.deepEqual(rules(await check({ exceptions })), ["internal-root-barrel", "stale-exception"]);
  await write(path, 'import type { Value } from "./leaf.ts";');
  assert.deepEqual(rules(await check({ exceptions })), ["stale-exception"]);
  await assert.rejects(check({ exceptions: { version: 1, exceptions: [exception, exception] } }));
  await assert.rejects(
    check({ exceptions: { version: 1, exceptions: [{ ...exception, owner: "" }] } }),
  );
});

test("binds cycle exceptions to the complete cycle edge set", async (t) => {
  const { write, check } = await workspace(t);
  await write("apps/app/src/cycle-a.mjs", 'import "./cycle-b.mjs"; export const a = 1;');
  await write("apps/app/src/cycle-b.mjs", 'import "./cycle-a.mjs"; export const b = 2;');
  const violation = (await check()).violations.find((item) => item.rule === "runtime-cycle");
  assert.ok(violation);
  const exceptions = {
    version: 1,
    exceptions: [
      {
        ...violation,
        owner: "Fixture maintainers",
        reason: "Existing cycle.",
        removeWhen: "Extract a shared leaf.",
      },
    ],
  };
  assert.equal((await check({ exceptions })).ok, true);
  await write(
    "apps/app/src/cycle-a.mjs",
    'import "./cycle-b.mjs"; export { b } from "./cycle-b.mjs"; export const a = 1;',
  );
  assert.deepEqual(rules(await check({ exceptions })), ["runtime-cycle", "stale-exception"]);
});

test("rejects empty source selections instead of reporting a passing boundary check", async (t) => {
  // An empty policy or directory must not make CI report a successful scan.
  for (const sourceRoots of [[], ["empty"]]) {
    const { root, args, check } = await workspace(t, { sourceRoots, packages: [] });
    await mkdir(join(root, "empty"));
    await assert.rejects(check(), /No source files selected/);
    await assert.rejects(run(process.execPath, [cli, ...args, "--json"]), (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /No source files selected/);
      assert.equal(error.stdout, "");
      return true;
    });
  }
});

test("rejects unknown policy and boundary fields instead of silently ignoring typos", async (t) => {
  const { write, check, args } = await workspace(t);
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
  for (const json of [false, true]) {
    await assert.rejects(
      run(process.execPath, [cli, ...args, ...(json ? ["--json"] : [])]),
      (error) => {
        assert.equal(error.code, 2);
        assert.match(error.stderr, /Unknown policy field/);
        return true;
      },
    );
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
  const { root, write, check, args } = await workspace(t, { diagnosticLimit: 1 });
  const passed = await run(process.execPath, [cli, ...args, "--json"]);
  assert.equal(passed.stderr, "");
  assert.deepEqual(JSON.parse(passed.stdout), await check());
  await write("apps/app/src/invalid.mjs", 'import "./missing-a.mjs"; import "./missing-b.mjs";');
  await assert.rejects(run(process.execPath, [cli, ...args]), (error) => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /1 additional violations/);
    assert.equal(
      error.stderr.split("\n").filter((line) => line.includes("[unresolved-local-import]")).length,
      1,
    );
    return true;
  });
  await assert.rejects(run(process.execPath, [cli, ...args, "--json"]), (error) => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).violations.length, 2);
    return true;
  });
  await write("malformed.json", "{");
  await write("invalid.json", JSON.stringify({ ...policy, diagnosticLimit: 0 }));
  for (const options of [
    ["--root", root],
    ["--root", root, "--policy", join(root, "malformed.json")],
    ["--root", root, "--policy", join(root, "invalid.json")],
    [...args, "--unknown"],
  ]) {
    await assert.rejects(run(process.execPath, [cli, ...options]), (error) => {
      assert.equal(error.code, 2);
      assert.notEqual(error.stderr.trim(), "");
      return true;
    });
  }
  await assert.rejects(verifyModuleBoundaries({ root }));
  for (const invalid of [
    { ...policy, version: 2 },
    { ...policy, sourceRoots: ["../outside"] },
    { ...policy, boundaries: [{ rule: "invalid", from: ["apps/**"] }] },
  ]) {
    await assert.rejects(check({ policy: invalid }));
  }
});

test("keeps known specifier policy when the loader has been reassigned", async (t) => {
  const source = "apps/app/src/specifier-loader.mjs";
  const { root, write, check, args } = await workspace(t, {
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
  await write(
    source,
    `import { createRequire } from "node:module";
     let load = createRequire(import.meta.url);
     load = createRequire(import.meta.url);
     const name = "fs";
     console.log(typeof load(name).readFile);`,
  );
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "function");
  const report = await check();
  const unresolved = report.violations.find(
    (item) => item.from === source && item.rule === "unresolved-dynamic-import",
  );
  assert.equal(unresolved.specifier, "fs");
  assert.ok(report.violations.some((item) => item.from === source && item.rule === "no-fs"));
  const exceptions = {
    version: 1,
    exceptions: [{ ...unresolved, owner: "fixture", reason: "reviewed", removeWhen: "fixed" }],
  };
  const accepted = await check({ exceptions });
  assert.equal(accepted.ok, false);
  assert.equal(accepted.baseline.length, 1);
  assert.ok(accepted.violations.some((item) => item.rule === "no-fs"));
  const boundary = report.violations.find((item) => item.from === source && item.rule === "no-fs");
  const boundaryOnly = await check({
    exceptions: {
      version: 1,
      exceptions: [{ ...boundary, owner: "fixture", reason: "reviewed", removeWhen: "fixed" }],
    },
  });
  assert.equal(boundaryOnly.ok, false);
  assert.ok(boundaryOnly.violations.some((item) => item.rule === "unresolved-dynamic-import"));
  await write(
    source,
    `import { createRequire } from "node:module";
     let load = createRequire(import.meta.url);
     load = createRequire(import.meta.url);
     load(process.env.PRIVATE_EXPRESSION_MARKER ?? "fs");`,
  );
  const unknown = await check();
  const diagnostic = unknown.violations.find(
    (item) => item.from === source && item.rule === "unresolved-dynamic-import",
  );
  assert.match(diagnostic.specifier, /^unknown:sha256:/);
  assert.equal(JSON.stringify(unknown).includes("PRIVATE_EXPRESSION_MARKER"), false);
  for (const json of [false, true]) {
    await assert.rejects(
      run(process.execPath, [cli, ...args, ...(json ? ["--json"] : [])]),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal((error.stdout + error.stderr).includes("PRIVATE_EXPRESSION_MARKER"), false);
        return true;
      },
    );
  }
});

test("does not reuse one unknown-loader exception for a distinct loader", async (t) => {
  const source = "apps/app/src/public/load.mjs";
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "no-private",
        from: [source],
        to: ["apps/app/src/private/**"],
        kinds: ["require"],
        message: "Use the public module.",
      },
    ],
  });
  await write("apps/app/src/public/secret.cjs", 'module.exports = "PUBLIC";');
  await write("apps/app/src/private/secret.cjs", 'module.exports = "PRIVATE";');
  await write("apps/app/src/public/anchor.cjs", "");
  await write("apps/app/src/private/anchor.cjs", "");
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
  const report = await check();
  const unresolved = report.violations.find(
    (item) => item.from === source && item.rule === "unresolved-dynamic-import",
  );
  const exceptions = {
    version: 1,
    exceptions: [{ ...unresolved, owner: "fixture", reason: "one load", removeWhen: "fixed" }],
  };
  assert.equal((await check({ exceptions })).ok, true);
  await write(source, "\n\n" + first);
  assert.equal((await check({ exceptions })).ok, true, "line changes retain the identity");
  await write(source, first + 'console.log(a("./secret.cjs"));');
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC\nPUBLIC");
  const repeated = await check({ exceptions });
  assert.equal(repeated.baseline.length, 1);
  assert.equal(
    repeated.violations.filter(
      (item) => item.from === source && item.rule === "unresolved-dynamic-import",
    ).length,
    1,
  );
  await write(source, first + second);
  assert.equal(
    (await run(process.execPath, [join(root, source)])).stdout.trim(),
    "PUBLIC\nPRIVATE",
  );
  const changed = await check({ exceptions });
  assert.equal(changed.baseline.length, 1);
  assert.equal(changed.ok, false);
  assert.equal(
    changed.violations.filter(
      (item) => item.from === source && item.rule === "unresolved-dynamic-import",
    ).length,
    1,
  );
  assert.notEqual(changed.violations[0].loaderIdentity, unresolved.loaderIdentity);
  await write(source, first.replace("./anchor.cjs", "../private/anchor.cjs"));
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
  const reassigned = await check({ exceptions });
  assert.ok(reassigned.violations.some((item) => item.rule === "stale-exception"));
  assert.ok(reassigned.violations.some((item) => item.rule === "unresolved-dynamic-import"));
  await write(source, first);
  const oldStyle = {
    version: 1,
    exceptions: [{ ...exceptions.exceptions[0], loaderIdentity: undefined }],
  };
  const migration = await check({ exceptions: oldStyle });
  assert.ok(migration.violations.some((item) => item.rule === "stale-exception"));
  assert.ok(migration.violations.some((item) => item.rule === "unresolved-dynamic-import"));
});

test("does not reuse unknown-anchor exceptions across distinct loaders", async (t) => {
  const source = "apps/app/src/public/unknown-loads.mjs";
  const { root, write, check } = await workspace(t, { boundaries: [] });
  await write("apps/app/src/public/secret.cjs", 'module.exports = "PUBLIC";');
  await write("apps/app/src/private/secret.cjs", 'module.exports = "PRIVATE";');
  await write("apps/app/src/public/anchor.cjs", "");
  await write("apps/app/src/private/anchor.cjs", "");
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
  const exceptionFor = async () => {
    const item = (await check()).violations.find(
      (value) => value.from === source && value.rule === "unresolved-dynamic-import",
    );
    assert.ok(item);
    return {
      version: 1,
      exceptions: [{ ...item, owner: "fixture", reason: "one load", removeWhen: "fixed" }],
    };
  };
  await write(source, requireFirst);
  const first = await exceptionFor();
  assert.equal((await check({ exceptions: first })).ok, true);
  await write(source, "\n\n" + requireFirst);
  assert.equal((await check({ exceptions: first })).ok, true);
  await write(source, requireFirst + requireSecond);
  assert.equal(
    (await run(process.execPath, [join(root, source)], { env })).stdout.trim(),
    "PUBLIC\nPRIVATE",
  );
  const anchors = await check({ exceptions: first });
  assert.equal(anchors.baseline.length, 1);
  assert.ok(
    anchors.violations.some(
      (item) => item.from === source && item.rule === "unresolved-dynamic-import",
    ),
  );
});

test("does not reuse an unknown-path exception for a different lexical binding", async (t) => {
  const source = "apps/app/src/public/dynamic-loads.mjs";
  const { root, write, check } = await workspace(t, { boundaries: [] });
  await write("apps/app/src/public/secret.mjs", 'export default "PUBLIC";');
  await write("apps/app/src/private/secret.mjs", 'export default "PRIVATE";');
  const env = {
    ...process.env,
    PUBLIC_PATH: "./secret.mjs",
    PRIVATE_PATH: "../private/secret.mjs",
  };
  const first = `async function publicLoad() {
  const target = process.env.PUBLIC_PATH;
  console.log((await import(target)).default);
}
await publicLoad();
`;
  const second = `async function privateLoad() {
  const target = process.env.PRIVATE_PATH;
  console.log((await import(target)).default);
}
await privateLoad();
`;
  await write(source, first);
  const before = await check();
  const item = before.violations.find(
    (value) => value.from === source && value.rule === "unresolved-dynamic-import",
  );
  const exceptions = {
    version: 1,
    exceptions: [{ ...item, owner: "fixture", reason: "one load", removeWhen: "fixed" }],
  };
  assert.equal((await check({ exceptions })).ok, true);
  await write(source, "\n\n" + first);
  assert.equal((await check({ exceptions })).ok, true);
  await write(source, first.replace("PUBLIC_PATH", "PRIVATE_PATH"));
  assert.equal(
    (await run(process.execPath, [join(root, source)], { env })).stdout.trim(),
    "PRIVATE",
  );
  const changedBinding = await check({ exceptions });
  assert.ok(changedBinding.violations.some((value) => value.rule === "stale-exception"));
  assert.ok(changedBinding.violations.some((value) => value.rule === "unresolved-dynamic-import"));
  await write(source, first + second);
  assert.equal(
    (await run(process.execPath, [join(root, source)], { env })).stdout.trim(),
    "PUBLIC\nPRIVATE",
  );
  const changed = await check({ exceptions });
  assert.equal(changed.baseline.length, 1);
  assert.ok(
    changed.violations.some(
      (value) => value.from === source && value.rule === "unresolved-dynamic-import",
    ),
  );
});

test("invalidates an unknown-path exception when its imported provider changes", async (t) => {
  const source = "apps/app/src/public/provider-load.mjs";
  const { root, write, check } = await workspace(t, { boundaries: [] });
  await write("apps/app/src/public/secret.mjs", 'export default "PUBLIC";');
  await write("apps/app/src/private/secret.mjs", 'export default "PRIVATE";');
  await write("apps/app/src/public/provider.mjs", 'export const select = () => "./secret.mjs";');
  await write(
    "apps/app/src/public/other.mjs",
    'export const select = () => "../private/secret.mjs";',
  );
  const first = `import { select } from "./provider.mjs";
console.log((await import(select())).default);
`;
  await write(source, first);
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
  const before = await check();
  const item = before.violations.find(
    (value) => value.from === source && value.rule === "unresolved-dynamic-import",
  );
  const exceptions = {
    version: 1,
    exceptions: [{ ...item, owner: "fixture", reason: "one provider", removeWhen: "fixed" }],
  };
  assert.equal((await check({ exceptions })).ok, true);
  await write(source, first.replace("./provider.mjs", "./other.mjs"));
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
  const changed = await check({ exceptions });
  assert.ok(changed.violations.some((value) => value.rule === "stale-exception"));
  assert.ok(changed.violations.some((value) => value.rule === "unresolved-dynamic-import"));
});

test("invalidates unknown-load exceptions when destructured sources change", async (t) => {
  const source = "apps/app/src/public/destructured.mjs";
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "no-private",
        from: [source],
        to: ["apps/app/src/private/**"],
        message: "Use the public module.",
      },
    ],
  });
  await write("apps/app/src/public/secret.mjs", 'export default "PUBLIC";');
  await write("apps/app/src/private/secret.mjs", 'export default "PRIVATE";');
  const forms = {
    object: (path) =>
      `const { target } = { target: "${path}" };\nconsole.log((await import(target)).default);`,
    array: (path) => `const [target] = ["${path}"];\nconsole.log((await import(target)).default);`,
    nestedDefault: (path) =>
      `const { outer: { target = "${path}" } = {} } = { outer: {} };\nconsole.log((await import(target)).default);`,
    transitive: (path) =>
      `const origin = "${path}";\nconst provider = { target: origin };\nconst { target } = provider;\nconsole.log((await import(target)).default);`,
    iteration: (path) =>
      `for (const { target } of [{target: "${path}"}]) console.log((await import(target)).default);`,
    parameter: (path) =>
      `async function load({target} = {target: "${path}"}) { console.log((await import(target)).default); }\nawait load();`,
    parameterCaller: (path) =>
      `async function load({target}) { console.log((await import(target)).default); }\nawait load({target: "${path}"});`,
    catchValue: (path) =>
      `try { throw {target: "${path}"}; } catch ({target}) { console.log((await import(target)).default); }`,
    propertyWrite: (path) =>
      `const provider = { target: "./secret.mjs" };\nprovider.target = "${path}";\nconst {target} = provider;\nconsole.log((await import(target)).default);`,
    plainParameter: (path) =>
      `async function load(target) { console.log((await import(target)).default); }\nawait load("${path}");`,
    plainProperty: (path) =>
      `const config = {target: "./secret.mjs"};\nconfig.target = "${path}";\nconsole.log((await import(config.target)).default);`,
    computedProperty: (path) =>
      `const config = {target: "./secret.mjs"};\nconfig["target"] = "${path}";\nconst chosen = config["target"];\nconsole.log((await import(chosen)).default);`,
    classField: (path) =>
      `class Loader { target = "./secret.mjs"; async load() { console.log((await import(this.target)).default); } }\nconst loader = new Loader(); loader.target = "${path}"; await loader.load();`,
    inheritedGetter: (path) =>
      `class Base { get target() { return this.path; } }\nclass Loader extends Base { async load() { console.log((await import(super.target)).default); } }\nconst loader = new Loader(); loader.path = "${path}"; await loader.load();`,
    callReceiver: (path) =>
      `const config = {target: "./secret.mjs"}; const get = () => config;\nconfig.target = "${path}"; console.log((await import(get().target)).default);`,
    parenthesizedReceiver: (path) =>
      `const config = {target: "./secret.mjs"}; const get = () => config;\nconfig.target = "${path}"; console.log((await import((get()).target)).default);`,
    conditionalReceiver: (path) =>
      `const config = {target: "./secret.mjs"}; const other = {target: "./secret.mjs"};\nconfig.target = "${path}"; console.log((await import((true ? config : other).target)).default);`,
    importMetaProperty: (path) =>
      `import.meta.target = "${path}"; console.log((await import(import.meta.target)).default);`,
    importMetaNested: (path) =>
      `import.meta.config = {target: "${path}"}; console.log((await import(import.meta.config.target)).default);`,
    globalAssign: (path) =>
      `Object.assign(globalThis, {target: "${path}"}); console.log((await import(globalThis.target)).default);`,
    globalBare: (path) =>
      `Object.assign(globalThis, {target: "${path}"}); console.log((await import(target)).default);`,
    shadowedGlobal: (path) =>
      `const globalThis = {target: "${path}"}; console.log((await import(globalThis.target)).default);`,
    globalObject: (path) =>
      `globalThis.config = {target: "${path}"}; console.log((await import(config.target)).default);`,
    environmentWrite: (path) =>
      `process.env.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    environmentObjectAlias: (path) =>
      `const box = { env: process.env }; box.env.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    environmentArrayAlias: (path) =>
      `const box = [(process.env)]; box[0].MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    environmentNestedAlias: (path) =>
      `const box = { nested: [{env: process["env"]}] }; box.nested[0].env.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    environmentSpreadAlias: (path) =>
      `const box = {...{env: process.env}}; box.env.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    environmentComputedAlias: (path) =>
      `const key = "env"; const box = { env: process[key] }; box.env.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    environmentMethodAlias: (path) =>
      `const box = process.env.valueOf(); box.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    environmentWrappedMethodAlias: (path) =>
      `const box = (process.env["valueOf"])(); box.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    processShorthandAlias: (path) =>
      `const box = { process }; box.process.env.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    environmentReturnAlias: (path) =>
      `const get = () => process.env; const box = get(); box.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    environmentConditionalAlias: (path) =>
      `const box = true ? process.env : {}; box.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    globalShorthandAlias: (path) =>
      `const box = {global}; box.global.process.env.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    globalThisShorthandAlias: (path) =>
      `const box = {globalThis}; box.globalThis.process.env.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    globalEnvironmentWrite: (path) =>
      `global.process.env.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    globalThisEnvironmentWrite: (path) =>
      `globalThis.process.env.MODULE_TARGET = "${path}"; console.log((await import(process.env.MODULE_TARGET)).default);`,
    boundedChain: (path) =>
      `const origin = "${path}";\n` +
      Array.from(
        { length: 80 },
        (_, index) => `const value${index} = ${index ? `value${index - 1}` : "origin"};`,
      ).join("\n") +
      `\nconst { target } = { target: value79 };\nconsole.log((await import(target)).default);`,
  };
  for (const [name, makeSource] of Object.entries(forms)) {
    await t.test(name, async () => {
      const publicSource = makeSource("./secret.mjs");
      await write(source, publicSource);
      assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
      const item = (await check()).violations.find(
        (value) => value.from === source && value.rule === "unresolved-dynamic-import",
      );
      assert.ok(item);
      const exceptions = {
        version: 1,
        exceptions: [{ ...item, owner: "fixture", reason: "one load", removeWhen: "fixed" }],
      };
      assert.equal((await check({ exceptions })).ok, true);
      await write(source, "\n\n" + publicSource);
      assert.equal((await check({ exceptions })).ok, true, "line shifts retain the identity");
      await write(source, makeSource("../private/secret.mjs"));
      assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
      const changed = await check({ exceptions });
      assert.ok(changed.violations.some((value) => value.rule === "stale-exception"));
      const unresolved = changed.violations.find(
        (value) => value.from === source && value.rule === "unresolved-dynamic-import",
      );
      assert.ok(unresolved);
      assert.notEqual(unresolved.loaderIdentity, item.loaderIdentity);
      assert.equal(JSON.stringify(changed).includes("../private/secret.mjs"), false);
    });
  }
});

test("keeps direct environment reads and lexical shadows independent of unrelated source", async (t) => {
  const source = "apps/app/src/public/env-read.mjs";
  const { root, write, check } = await workspace(t);
  await write("apps/app/src/public/secret.mjs", 'export default "PUBLIC";');
  const env = { ...process.env, MODULE_TARGET: "./secret.mjs" };
  const makeSource = (value) =>
    `function example(process) { return { env: process.env, value: "${value}" }; }
     const holder = { process: "${value}" }; holder.process;
     const {process: ignored} = JSON.parse('{"process":0}'); void ignored;
     console.log((await import(process.env.MODULE_TARGET)).default);`;
  await write(source, makeSource("one"));
  assert.equal(
    (await run(process.execPath, [join(root, source)], { env })).stdout.trim(),
    "PUBLIC",
  );
  const item = (await check()).violations.find(
    (value) => value.from === source && value.rule === "unresolved-dynamic-import",
  );
  assert.ok(item);
  const exceptions = {
    version: 1,
    exceptions: [{ ...item, owner: "fixture", reason: "one load", removeWhen: "fixed" }],
  };
  await write(source, makeSource("two"));
  assert.equal((await check({ exceptions })).ok, true);
});

test("invalidates unknown-load exceptions after deleting an environment property", async (t) => {
  const source = "apps/app/src/public/delete-env.mjs";
  const { root, write, check } = await workspace(t);
  await write("apps/app/src/public/secret.mjs", 'export default "PUBLIC";');
  await write("apps/app/src/private/secret.mjs", 'export default "PRIVATE";');
  const env = { ...process.env, BOUNDARY_SELECTED: "./secret.mjs" };
  for (const computed of [false, true]) {
    const makeSource = (property) =>
      `delete process.env${computed ? `["${property}"]` : `.${property}`};
       console.log((await import(process.env.BOUNDARY_SELECTED ?? "../private/secret.mjs")).default);`;
    const publicSource = makeSource("BOUNDARY_UNRELATED");
    await write(source, publicSource);
    assert.equal(
      (await run(process.execPath, [join(root, source)], { env })).stdout.trim(),
      "PUBLIC",
    );
    const before = (await check()).violations.find(
      (item) => item.from === source && item.rule === "unresolved-dynamic-import",
    );
    assert.ok(before);
    const exceptions = {
      version: 1,
      exceptions: [{ ...before, owner: "fixture", reason: "one load", removeWhen: "fixed" }],
    };
    assert.equal((await check({ exceptions })).ok, true);
    await write(source, "\n\n" + publicSource);
    assert.equal((await check({ exceptions })).ok, true);
    await write(source, makeSource("BOUNDARY_SELECTED"));
    assert.equal(
      (await run(process.execPath, [join(root, source)], { env })).stdout.trim(),
      "PRIVATE",
    );
    const changed = await check({ exceptions });
    assert.ok(changed.violations.some((item) => item.rule === "stale-exception"));
    assert.ok(changed.violations.some((item) => item.rule === "unresolved-dynamic-import"));
  }
});

test("fails closed when import.meta.url can be changed", async (t) => {
  const source = "apps/app/src/public/meta-load.mjs";
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "no-private",
        from: [source],
        to: ["apps/app/src/private/**"],
        message: "Use the public module.",
      },
    ],
  });
  await write("apps/app/src/public/secret.mjs", 'export default "PUBLIC";');
  await write("apps/app/src/private/secret.mjs", 'export default "PRIVATE";');
  const load =
    'console.log((await import(new URL("./secret.mjs", import.meta.url).href)).default);';
  await write(source, load);
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
  assert.equal((await check()).ok, true);
  for (const setup of [
    'import.meta.url = new URL("../private/", import.meta.url).href;',
    'import.meta["url"] = new URL("../private/", import.meta.url).href;',
    'const meta = import.meta; meta.url = new URL("../private/", meta.url).href;',
    'Object.defineProperty(import.meta, "url", {value: new URL("../private/", import.meta.url).href});',
  ]) {
    await write(source, `${setup}\n${load}`);
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
    const result = await check();
    assert.equal(result.ok, false);
    assert.ok(
      result.violations.some(
        (value) => value.from === source && value.rule === "unresolved-dynamic-import",
      ),
    );
  }
});

test("tracks the shared Node module loader and ignores binding property names", async (t) => {
  const source = "apps/app/src/public/prototype.cjs";
  const esm = "apps/app/src/public/property.mjs";
  const { root, write, check } = await workspace(t, {
    boundaries: [
      {
        rule: "no-private",
        from: ["apps/app/src/public/**"],
        to: ["apps/app/src/private/**"],
        kinds: ["require"],
        message: "No private imports.",
      },
    ],
  });
  await write("apps/app/src/public/secret.cjs", 'module.exports = "PUBLIC";');
  await write("apps/app/src/private/secret.cjs", 'module.exports = "PRIVATE";');
  await write("apps/app/src/public/secret.mjs", 'export default "PUBLIC";');
  for (const call of ['module.require("./secret.cjs")', 'require("./secret.cjs")']) {
    for (const assignment of [
      'const original = Module.prototype.require; Module.prototype.require = function() { return original.call(this, __dirname + "/../private/secret.cjs"); };',
      'const original = Module._load; Module._load = function() { return original(__dirname + "/../private/secret.cjs", module); };',
    ]) {
      await write(
        source,
        `const Module = require("node:module"); ${assignment} console.log(${call});`,
      );
      assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PRIVATE");
      const report = await check();
      assert.ok(
        report.violations.some(
          (item) => item.from === source && item.rule === "unresolved-dynamic-import",
        ),
        `${call}: ${assignment}`,
      );
      assert.equal(
        from(report, source).some((item) => item.to === "apps/app/src/public/secret.cjs"),
        false,
      );
    }
    await write(
      source,
      `const Module = require("node:module"); void Module; console.log(${call});`,
    );
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
    // Exposing Module can mutate its loader, so use a non-exposing positive control below.
  }
  await write(source, 'console.log(require("./secret.cjs"), module.require("./secret.cjs"));');
  assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC PUBLIC");
  assert.ok(
    from(await check(), source).some((item) => item.to === "apps/app/src/public/secret.cjs"),
  );
  for (const name of ["URL", "global", "globalThis"]) {
    await write(
      esm,
      `const {${name}: value} = JSON.parse('{"${name}":false}'); void value; console.log((await import(new URL("./secret.mjs", import.meta.url).href)).default);`,
    );
    assert.equal((await run(process.execPath, [join(root, esm)])).stdout.trim(), "PUBLIC");
    assert.ok(
      from(await check(), esm).some((item) => item.to === "apps/app/src/public/secret.mjs"),
      name,
    );
  }
  await write("apps/app/src/private/secret.mjs", 'export default "PRIVATE";');
  await write(
    esm,
    `const box = {URL}; Object.defineProperty(box.URL.prototype, "href", {get() { return import.meta.url.replace("property.mjs", "../private/secret.mjs"); }}); console.log((await import(new URL("./secret.mjs", import.meta.url).href)).default);`,
  );
  assert.equal((await run(process.execPath, [join(root, esm)])).stdout.trim(), "PRIVATE");
  assert.ok(
    (await check()).violations.some(
      (item) => item.from === esm && item.rule === "unresolved-dynamic-import",
    ),
  );
  await write(
    esm,
    'const object = {[URL]: true}; void object; console.log((await import(new URL("./secret.mjs", import.meta.url).href)).default);',
  );
  const computed = await check();
  assert.ok(
    computed.violations.some(
      (item) => item.from === esm && item.rule === "unresolved-dynamic-import",
    ),
  );
});

test("observes the CommonJS module type without exposing its loader", async (t) => {
  const source = "apps/app/src/public/typeof-module.cjs";
  const { root, write, check } = await workspace(t);
  await write("apps/app/src/public/secret.cjs", 'module.exports = "PUBLIC";');
  for (const observation of ["typeof module", "typeof (module)", "typeof (((module)))"]) {
    await write(
      source,
      `console.log(${observation}, require.resolve("./secret.cjs"), module.require("./secret.cjs"));`,
    );
    const native = (await run(process.execPath, [join(root, source)])).stdout.trim();
    assert.match(native, /^object .*secret\.cjs PUBLIC$/);
    const report = await check();
    assert.equal(
      report.violations.some((item) => item.from === source),
      false,
      observation,
    );
    assert.ok(from(report, source).some((item) => item.to === "apps/app/src/public/secret.cjs"));
  }
  await write(
    source,
    'function shadow(module) { return typeof (module); } console.log(shadow({}), require.resolve("./secret.cjs"));',
  );
  assert.match(
    (await run(process.execPath, [join(root, source)])).stdout.trim(),
    /^object .*secret\.cjs$/,
  );
  assert.equal(
    (await check()).violations.some((item) => item.from === source),
    false,
  );
  for (const exposure of [
    "const box = {module}; void box;",
    "function expose(value) { return value; } expose(module);",
  ]) {
    await write(source, `${exposure} console.log(require("./secret.cjs"));`);
    assert.equal((await run(process.execPath, [join(root, source)])).stdout.trim(), "PUBLIC");
    assert.ok(
      (await check()).violations.some(
        (item) => item.from === source && item.rule === "unresolved-dynamic-import",
      ),
      exposure,
    );
  }
});
