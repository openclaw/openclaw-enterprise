import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/typescript";

const sourceRoot = fileURLToPath(new URL("../apps/controller/src/", import.meta.url));
const credentialDirectories = [
  "composition/repository-credentials",
  "drivers/repo/credentials",
  "drivers/repo/github",
  "backends/repository-credentials",
];
const processEntrypoints = ["repository-credentials.ts", "repository-credentials.mjs"];
const requiredEntrypoints = [
  ...processEntrypoints,
  "composition/repository-credentials/check-config.ts",
  "composition/repository-credentials/projected-inputs.ts",
  "composition/repository-credentials/probe.ts",
  "drivers/repo/github/credentials/client/launch.ts",
  "drivers/repo/github/credentials/client/operator.ts",
  "drivers/repo/github/credentials/client/git-helper.ts",
  "drivers/repo/github/credentials/client/native-git.ts",
  "drivers/repo/github/credentials/client/hook-dispatch.ts",
  "drivers/repo/github/credentials/client/router.ts",
];
const clientDirectory = "drivers/repo/github/credentials/client/";
const clientContracts = "drivers/repo/credentials/client-contracts.ts";
const sourceExtensions = new Set([".ts", ".mts", ".cts", ".js", ".mjs", ".cjs", ".tsx", ".jsx"]);

// Adding an I/O owner or member requires security review; see the owning test guide.
const reviewedImports = {
  "drivers/repo/github/credentials/material.ts": {
    "node:crypto": ["KeyObject", "constants", "sign"],
  },
  "drivers/repo/github/credentials/provider-transport/request.ts": {
    "node:https": ["request"],
  },
  "drivers/repo/github/credentials/client/commands.ts": { "node:child_process": ["spawnSync"] },
  "drivers/repo/github/credentials/client/config.ts": {
    "node:fs/promises": ["lstat", "mkdir", "mkdtemp", "open", "rename", "rm"],
  },
  "drivers/repo/github/credentials/client/launch.ts": {
    "node:child_process": ["spawn"],
  },
  // The image dispatcher inspects native Git configuration and executes the
  // repository's existing executable hook. It never opens credential material.
  "drivers/repo/github/credentials/client/hook-dispatch.ts": {
    "node:child_process": ["spawnSync"],
    "node:fs": ["constants"],
    "node:fs/promises": ["access"],
  },
  "drivers/repo/github/credentials/client/manifest.ts": {
    "node:crypto": ["createHash"],
    "node:fs/promises": ["lstat"],
  },
  "drivers/repo/github/credentials/client/native-git.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["open"],
  },
  "drivers/repo/github/credentials/client/targets.ts": {
    "node:child_process": ["spawnSync"],
  },
  "drivers/repo/github/credentials/client/operator.ts": {
    "node:crypto": ["randomUUID"],
    "node:fs/promises": ["readFile"],
    "node:http": ["request"],
  },
  "drivers/repo/github/credentials/client/private-files.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["lstat", "open"],
  },
  "composition/repository-credentials/config.ts": {
    "node:crypto": ["createPrivateKey"],
    "node:tls": ["createSecureContext"],
  },
  "composition/repository-credentials/protected-file.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["lstat", "open"],
  },
  "composition/repository-credentials/platform.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["open", "stat"],
    "node:tls": ["createSecureContext"],
  },
  "composition/repository-credentials/projected-inputs.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["lstat", "mkdir", "open", "readdir", "readlink", "realpath", "unlink"],
  },
  "composition/repository-credentials/probe.ts": { "node:http": ["request"] },
  "backends/repository-credentials/control-client.ts": { "node:http": ["request"] },
  "composition/repository-credentials/registry.ts": {
    "node:fs": ["constants"],
    "node:fs/promises": ["open", "stat"],
  },
  "drivers/repo/github/credentials/registry.ts": { "node:crypto": ["createHash"] },
  // Standalone grants hash only nonsecret configuration/profile policy, never key material.
  "drivers/repo/github/credentials/grants.ts": { "node:crypto": ["createHash"] },
  "drivers/repo/github/driver.ts": {
    "@openclaw-enterprise/occ": ["DependencyUnavailableError", "ScopeViolationError"],
  },
  "drivers/repo/credentials/lifecycle.ts": { "node:crypto": ["randomUUID"] },
  "drivers/repo/credentials/server.ts": {
    "node:fs/promises": ["chmod", "lstat", "realpath", "unlink"],
    "node:http": ["createServer"],
    "node:https": ["createServer"],
    "node:net": ["connect"],
  },
  "drivers/repo/credentials/sessions.ts": {
    "node:crypto": ["createHash", "randomBytes", "randomUUID"],
  },
  "drivers/repo/credentials/transport/request-headers.ts": {
    "node:http": ["validateHeaderName", "validateHeaderValue"],
  },
  "drivers/repo/credentials/transport/upstream.ts": { "node:https": ["request"] },
};
const ordinaryBuiltins = new Set([
  "node:os",
  "node:path",
  "node:perf_hooks",
  "node:stream",
  "node:stream/promises",
  "node:url",
  "node:zlib",
]);
const senderConsumers = {
  "drivers/repo/github/credentials/provider-transport/request.ts": {
    "drivers/repo/github/credentials/provider-transport.ts": ["sendProviderRequest"],
  },
  "drivers/repo/credentials/transport/upstream.ts": {
    "drivers/repo/credentials/transport/agent.ts": ["createUpstreamSender"],
  },
  "backends/repository-credentials/control-client.ts": {
    "composition/repository-credentials/platform.ts": ["UnixRepositoryCredentialControlClient"],
    "drivers/repo/github/driver.ts": ["RepositoryCredentialControlError"],
  },
};
const rawGlobals = new Set([
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "require",
  "eval",
  "Function",
  "global",
  "globalThis",
  "console",
  "module",
]);
const reviewedProcessMembers = {
  "composition/repository-credentials/check-config.ts": ["argv", "exitCode", "stderr", "stdout"],
  "drivers/repo/github/credentials/client/environment.ts": ["env"],
  "drivers/repo/github/credentials/client/git-helper.ts": [
    "argv",
    "env",
    "exit",
    "exitCode",
    "stderr",
    "stdin",
    "stdout",
  ],
  "drivers/repo/github/credentials/client/launch.ts": [
    "argv",
    "env",
    "exitCode",
    "off",
    "on",
    "stderr",
  ],
  "drivers/repo/github/credentials/client/manifest.ts": ["getuid"],
  "drivers/repo/github/credentials/client/hook-dispatch.ts": [
    "argv",
    "env",
    "exitCode",
    "stderr",
    "stdin",
  ],
  "drivers/repo/github/credentials/client/native-git.ts": [
    "argv",
    "execPath",
    "exitCode",
    "stderr",
  ],
  "drivers/repo/github/credentials/client/router.ts": ["argv", "env", "exitCode", "stderr"],
  "drivers/repo/github/credentials/client/operator.ts": ["argv", "exitCode", "stderr", "stdout"],
  "drivers/repo/github/credentials/client/private-files.ts": ["getuid"],
  "composition/repository-credentials/protected-file.ts": ["getuid"],
  "composition/repository-credentials/service.ts": ["exit", "once", "stderr", "stdout"],
  "composition/repository-credentials/projected-inputs.ts": [
    "argv",
    "exitCode",
    "getuid",
    "stderr",
    "stdout",
  ],
  "composition/repository-credentials/probe.ts": ["exitCode"],
  "repository-credentials.ts": ["argv", "exitCode", "stderr", "stdout"],
  "repository-credentials.mjs": ["exitCode", "stderr"],
  "drivers/repo/credentials/server.ts": ["getuid"],
};
const runtimeTypeScript = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "TSInstantiationExpression",
  "TSParameterProperty",
  "TSExportAssignment",
  "TSModuleDeclaration",
  "TSModuleBlock",
  "TSEnumDeclaration",
  "TSEnumBody",
  "TSEnumMember",
]);

function slash(path) {
  return path.split(sep).join("/");
}

async function sourceFiles(root) {
  if (!(await lstat(root)).isDirectory()) {
    throw new Error(`Credential source must be a directory: ${root}`);
  }
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Credential source must not be a symlink: ${path}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (sourceExtensions.has(extname(entry.name))) {
      if (!entry.isFile()) {
        throw new Error(`Credential source must be a regular file: ${path}`);
      }
      files.push(path);
    }
  }
  return files.sort();
}

function name(node) {
  return node?.type === "Identifier" ? node.name : node?.value;
}

function member(node) {
  if (node?.type !== "MemberExpression") {
    return undefined;
  }
  return !node.computed || node.property.type === "Literal" ? name(node.property) : undefined;
}

function isReference(parent, key) {
  if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) {
    return false;
  }
  if (["Property", "MethodDefinition", "PropertyDefinition"].includes(parent?.type)) {
    if (key === "key" && !parent.computed) {
      return false;
    }
  }
  if (key === "id" || key === "label") {
    return false;
  }
  return true;
}

function unwrappedValue(node) {
  while (runtimeTypeScript.has(node?.type) && node.expression) {
    node = node.expression;
  }
  return node;
}

function relativeSource(path, root, specifier, sources) {
  const target = slash(relative(root, resolve(dirname(path), specifier)));
  if (sources.has(target)) {
    return target;
  }
  const extension = extname(target);
  const sourceExtension = { ".js": ".ts", ".mjs": ".mts", ".cjs": ".cts" }[extension];
  const sourceTarget = sourceExtension && target.slice(0, -extension.length) + sourceExtension;
  return sourceTarget && sources.has(sourceTarget) ? sourceTarget : target;
}

function inspectSource(path, root, sources, ast) {
  const file = slash(relative(root, path));
  const failures = [];
  const rawBindings = new Set();
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration" || node.importKind === "type") {
      continue;
    }
    const source = node.source.value;
    if (ordinaryBuiltins.has(source)) {
      continue;
    }
    if (source.startsWith(".")) {
      const target = relativeSource(path, root, source, sources);
      const restricted =
        senderConsumers[target] ||
        (!file.startsWith(clientDirectory) && target.startsWith(clientDirectory)) ||
        (file === "repository-credentials.mjs" && source === "../dist/repository-credentials.js");
      if (!restricted) {
        continue;
      }
    }
    for (const specifier of node.specifiers) {
      if (specifier.importKind !== "type") {
        rawBindings.add(specifier.local.name);
      }
    }
  }
  function deny(node, reason) {
    failures.push(`${file}:${node.loc?.start.line ?? 1}: ${reason}`);
  }
  function edge(node, specifier, names, kind) {
    if (typeof specifier !== "string") {
      deny(node, "nonliteral module loading requires security review");
      return;
    }
    if (specifier.startsWith(".")) {
      const target = relativeSource(path, root, specifier, sources);
      if (
        file === "repository-credentials.mjs" &&
        kind === "import" &&
        specifier === "../dist/repository-credentials.js" &&
        names.join() === "main"
      ) {
        return;
      }
      if (
        target === ".." ||
        target.startsWith("../") ||
        target.includes("?") ||
        target.includes("#")
      ) {
        deny(node, `runtime import escapes credential source: ${specifier}`);
        return;
      }
      if (!sources.has(target)) {
        deny(node, `runtime import has no scanned credential source: ${specifier}`);
        return;
      }
      if (
        file.startsWith(clientDirectory) &&
        !target.startsWith(clientDirectory) &&
        target !== clientContracts
      ) {
        deny(node, `client runtime cannot load service owner ${target}`);
      }
      const consumers = senderConsumers[target];
      if (
        consumers &&
        (kind !== "import" || !names.every((binding) => consumers[file]?.includes(binding)))
      ) {
        deny(node, `raw sender ${target} is not reviewed for ${file}`);
      }
      if (!file.startsWith(clientDirectory) && target.startsWith(clientDirectory)) {
        const rendersSessionFiles =
          file === "drivers/repo/github/driver.ts" &&
          target === `${clientDirectory}config.ts` &&
          kind === "import" &&
          names.length === 1 &&
          names[0] === "encodeRepositoryCredentialSessionFiles";
        if (!rendersSessionFiles) {
          deny(node, `service code cannot load client command owner ${target}`);
        }
      }
      return;
    }
    if (ordinaryBuiltins.has(specifier)) {
      return;
    }
    if (
      kind === "import" &&
      names.every((binding) => reviewedImports[file]?.[specifier]?.includes(binding))
    ) {
      return;
    }
    deny(node, `unreviewed runtime ${kind} from ${specifier} (${names.join(", ")})`);
  }

  function visit(node, parent, key) {
    if (!node || typeof node.type !== "string" || node.declare) {
      return;
    }
    if (node.type === "ImportDeclaration") {
      if (node.importKind === "type") {
        return;
      }
      const values = node.specifiers.filter((specifier) => specifier.importKind !== "type");
      // With verbatimModuleSyntax, inline type-only specifiers retain import {}.
      const names = values.length
        ? values.map((specifier) => name(specifier.imported) ?? "*")
        : ["<side-effect>"];
      edge(node, node.source.value, names, "import");
      return;
    }
    if (node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") {
      if (node.exportKind === "type") {
        return;
      }
      const values = node.specifiers?.filter((specifier) => specifier.exportKind !== "type") ?? [];
      if (node.source) {
        const names = values.map((specifier) => name(specifier.local));
        if (!names.length) {
          names.push(node.type === "ExportAllDeclaration" ? "*" : "<side-effect>");
        }
        edge(node, node.source.value, names, "export");
      } else {
        for (const specifier of values) {
          if (rawBindings.has(name(specifier.local))) {
            deny(specifier, "raw I/O binding cannot be re-exported");
          }
        }
        if (node.declaration?.type === "VariableDeclaration") {
          for (const declaration of node.declaration.declarations) {
            const value = unwrappedValue(declaration.init);
            if (value?.type === "Identifier" && rawBindings.has(value.name)) {
              deny(declaration, "raw I/O binding cannot be re-exported");
            }
          }
        }
        visit(node.declaration, node, "declaration");
      }
      return;
    }
    if (node.type === "ExportDefaultDeclaration") {
      const value = unwrappedValue(node.declaration);
      if (value?.type === "Identifier" && rawBindings.has(value.name)) {
        deny(node, "raw I/O binding cannot be re-exported");
      }
    }
    if (node.type === "TSImportEqualsDeclaration") {
      if (node.importKind !== "type") {
        edge(node, node.moduleReference.expression?.value, ["*"], "import");
      }
      return;
    }
    if (node.type === "ImportExpression") {
      edge(node, node.source.type === "Literal" ? node.source.value : undefined, ["*"], "import");
      return;
    }
    if (node.type.startsWith("TS") && !runtimeTypeScript.has(node.type)) {
      return;
    }
    if (node.type === "Identifier" && isReference(parent, key)) {
      if (rawGlobals.has(node.name)) {
        deny(node, `raw global ${node.name} requires security review`);
      }
      if (node.name === "process") {
        const property =
          parent?.type === "MemberExpression" && key === "object" ? member(parent) : undefined;
        if (!property || !reviewedProcessMembers[file]?.includes(property)) {
          deny(node, `raw process capability ${property ?? "<value>"} requires security review`);
        }
      }
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (["comments", "tokens", "loc", "range"].includes(childKey)) {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) {
          visit(item, node, childKey);
        }
      } else {
        visit(child, node, childKey);
      }
    }
  }
  visit(ast);
  return failures;
}

export async function verifyRepositoryCredentialBoundary(root = sourceRoot) {
  const files = [];
  for (const directory of credentialDirectories) {
    const path = join(root, directory);
    const stat = await lstat(path).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return undefined;
    });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Missing or invalid credential source root: ${directory}`);
    }
    const owned = await sourceFiles(path);
    if (!owned.length) {
      throw new Error(`Empty credential source root: ${directory}`);
    }
    files.push(...owned);
  }
  for (const entrypoint of processEntrypoints) {
    const path = join(root, entrypoint);
    const stat = await lstat(path).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
      return undefined;
    });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new Error(`Invalid credential entrypoint: ${entrypoint}`);
    }
    if (stat) {
      files.push(path);
    }
  }
  const sources = new Set(files.map((path) => slash(relative(root, path))));
  const failures = [];
  for (const entrypoint of requiredEntrypoints) {
    if (!sources.has(entrypoint)) {
      failures.push(`Missing credential entrypoint: ${entrypoint}`);
    }
  }
  for (const path of files) {
    const ast = await parsers.typescript.parse(await readFile(path, "utf8"));
    failures.push(...inspectSource(path, root, sources, ast));
  }
  if (failures.length) {
    throw new Error(
      `Repository credential boundary requires security review:\n${failures.join("\n")}`,
    );
  }
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = await verifyRepositoryCredentialBoundary();
  process.stdout.write(`Repository credential boundary verified: ${count} source files.\n`);
}
