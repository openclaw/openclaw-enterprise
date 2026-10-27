import { constants } from "node:fs";
import { chmod, cp, lstat, mkdir, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/babel";

// `--client-only` stages just the Agent runtime's credential client. The runtime
// image builds it from the client's own sources so unrelated controller changes
// keep that build stage cached (deploy/runtime/Dockerfile).
const options = process.argv.slice(2);
if (options.length > 1 || (options.length === 1 && options[0] !== "--client-only")) {
  throw new Error("Usage: build-repository-credentials.mjs [--client-only]");
}
const clientOnly = options[0] === "--client-only";
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const emittedRoot = await realpath(join(repositoryRoot, "apps/controller/dist"));
const artifactRoot = join(repositoryRoot, ".build/repository-credentials");
const clientRoot = join(emittedRoot, "drivers/repo/github/credentials/client");
const clientContracts = join(emittedRoot, "drivers/repo/credentials/client-contracts.js");
// The sender needs hashing, random identifiers and certificate inspection, but
// signing belongs to the worker. Keep this independent of module filenames.
const serviceCryptoImports = new Set([
  "createHash",
  "randomBytes",
  "randomUUID",
  "X509Certificate",
]);

function contained(root, path) {
  const suffix = relative(root, path);
  return suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

function dependencies(source, path, runtime) {
  const specifiers = new Set();
  const unsupported = () => {
    throw new Error(`Unsupported runtime import in ${path}`);
  };
  function add(node, declaration) {
    if (node?.type !== "StringLiteral") {
      unsupported();
    }
    // Alternate module loaders could hide dependencies from this ESM closure.
    if (node.value === "module" || node.value === "node:module") {
      unsupported();
    }
    if (
      runtime === "service" &&
      (node.value === "crypto" || node.value === "node:crypto") &&
      (declaration.type !== "ImportDeclaration" ||
        declaration.specifiers.length === 0 ||
        declaration.specifiers.some(
          (specifier) =>
            specifier.type !== "ImportSpecifier" ||
            !serviceCryptoImports.has(specifier.imported.name),
        ))
    ) {
      throw new Error(`Unsupported service cryptographic capability in ${path}`);
    }
    specifiers.add(node.value);
  }
  function visit(node) {
    if (!node || typeof node !== "object") {
      return;
    }
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      if (node.source) {
        add(node.source, node);
      }
    } else if (node.type === "ImportExpression") {
      if (node.options || node.phase) {
        unsupported();
      }
      add(node.source, node);
    } else if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      if (node.callee.type === "Import") {
        if (node.arguments.length !== 1) {
          unsupported();
        }
        add(node.arguments[0], node);
      } else if (node.callee.type === "Identifier" && node.callee.name === "require") {
        unsupported();
      }
    }
    for (const key of Object.keys(node)) {
      // Babel locations contain coordinates, never runtime dependencies.
      if (key === "loc") {
        continue;
      }
      const value = node[key];
      if (Array.isArray(value)) {
        value.forEach(visit);
      } else if (value && typeof value === "object") {
        visit(value);
      }
    }
  }
  visit(parsers.babel.parse(source));
  return specifiers;
}

async function readModule(path, name) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = constants;
  const file = await open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    // Bind the canonical, singly linked compiler output to the descriptor we read.
    // The build still owns the emitted tree; this does not lock a compiler or its inputs.
    const opened = await file.stat({ bigint: true });
    if (opened.isFile() && opened.nlink === 1n && (await realpath(path)) === path) {
      const named = await lstat(path, { bigint: true });
      if (named.dev === opened.dev && named.ino === opened.ino) {
        return await file.readFile("utf8");
      }
    }
    throw new Error(`Invalid ${name} runtime module: ${path}`);
  } finally {
    await file.close();
  }
}

async function closure(name, entrypoints) {
  const files = new Map();
  const pending = entrypoints.map((path) => resolve(emittedRoot, path));
  while (pending.length) {
    const path = pending.pop();
    if (files.has(path)) {
      continue;
    }
    if (
      !contained(emittedRoot, path) ||
      (name === "client" && !contained(clientRoot, path) && path !== clientContracts) ||
      !path.endsWith(".js")
    ) {
      throw new Error(`Invalid ${name} runtime module: ${path}`);
    }
    const source = await readModule(path, name);
    files.set(path, source);
    for (const specifier of dependencies(source, relative(emittedRoot, path), name)) {
      if (isBuiltin(specifier)) {
        continue;
      }
      if (
        !/^\.{1,2}\//.test(specifier) ||
        !specifier.endsWith(".js") ||
        /[\\%?#]/.test(specifier)
      ) {
        throw new Error(`Unsupported ${name} runtime dependency: ${specifier}`);
      }
      pending.push(resolve(dirname(path), specifier));
    }
  }
  return files;
}

// Validate every staged closure before replacing any artifact; `--client-only`
// validates and stages only the client. Source-only types and unrelated
// controller modules stay outside these separate runtimes.
const service = clientOnly
  ? undefined
  : await closure("service", [
      "repository-credentials.js",
      "composition/repository-credentials/check-config.js",
      "composition/repository-credentials/projected-inputs.js",
      "composition/repository-credentials/probe.js",
    ]);
const client = await closure(
  "client",
  ["launch", "operator", "git-helper", "native-git", "draft-pr", "router", "hook-dispatch"].map(
    (name) => `drivers/repo/github/credentials/client/${name}.js`,
  ),
);

async function stage(name, files) {
  const destination = join(artifactRoot, name);
  await rm(destination, { recursive: true, force: true });
  for (const [path, source] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    const target = join(destination, "dist", relative(emittedRoot, path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
  }
  await writeFile(
    join(destination, "package.json"),
    `${JSON.stringify({ name: `repository-credentials-${name}`, type: "module" }, null, 2)}\n`,
  );
  await cp(
    join(repositoryRoot, "deploy/runtime/repository-credentials/.dockerignore"),
    join(destination, ".dockerignore"),
  );
  if (name === "client") {
    const hooks = JSON.parse(
      await readFile(
        join(repositoryRoot, "deploy/runtime/repository-credentials/hooks.json"),
        "utf8",
      ),
    );
    if (
      !Array.isArray(hooks) ||
      hooks.some((hook) => typeof hook !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(hook))
    ) {
      throw new Error("Invalid native Git hook inventory");
    }
    const directory = join(destination, "dist/drivers/repo/github/credentials/client/hooks");
    await mkdir(directory, { recursive: true });
    for (const hook of hooks) {
      await writeFile(
        join(directory, hook),
        '#!/bin/sh\nexec node "$(dirname "$0")/../hook-dispatch.js" ' + hook + ' "$@"\n',
        { mode: 0o755 },
      );
      await chmod(join(directory, hook), 0o755);
    }
  }
}

if (service) {
  await stage("service", service);
}
await stage("client", client);
