import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript-compiler-api";
import { selectPackageExport } from "./package-exports.mjs";
import { slash, sourceExtension } from "./workspace.mjs";

const declaration = /\.d\.[cm]?ts$/;
const emittedExtension = /\.[cm]?js$/;

// Node selects the nearest package scope for self references before looking in
// node_modules. Check that the package visible to the importer is the one the
// policy registered; an absent installation still permits source-only scans.
function visiblePackage(anchor, name, mode) {
  let directory = anchor.endsWith("/") ? resolve(anchor) : dirname(anchor);
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (manifest.name === name && manifest.exports != null) {
        return realpathSync(directory);
      }
      break;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) {
        throw error;
      }
    }
    if (basename(directory) === "node_modules") {
      break;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      break;
    }
    directory = parent;
  }
  const searchPaths = [];
  if (mode === "require") {
    searchPaths.push(...(createRequire(anchor).resolve.paths(name) ?? []));
  } else {
    // ESM walks ancestor node_modules directories and ignores NODE_PATH and
    // CommonJS global folders.
    directory = anchor.endsWith("/") ? resolve(anchor) : dirname(anchor);
    for (;;) {
      if (basename(directory) !== "node_modules") {
        searchPaths.push(join(directory, "node_modules"));
      }
      const parent = dirname(directory);
      if (parent === directory) {
        break;
      }
      directory = parent;
    }
  }
  for (const search of searchPaths) {
    const candidate = join(search, name);
    if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
      return realpathSync(candidate);
    }
  }
  return null;
}

/** Resolve graph references without importing or executing application modules. */
export function resolveImports(snapshot, references, policy = {}) {
  const { root, packages } = snapshot;
  const files = new Map(snapshot.files.map((file) => [resolve(file.absolutePath), file]));
  const manifests = new Map(
    packages.map((pkg) => [resolve(root, pkg.path, "package.json"), JSON.stringify(pkg.manifest)]),
  );
  const host = {
    ...ts.sys,
    fileExists: (path) =>
      files.has(resolve(path)) || manifests.has(resolve(path)) || ts.sys.fileExists(path),
    readFile: (path) =>
      files.get(resolve(path))?.text ?? manifests.get(resolve(path)) ?? ts.sys.readFile(path),
  };
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowJs: true,
    resolveJsonModule: true,
  };
  function compilerTarget(specifier, anchor, mode, runtime = false) {
    // The public compiler API owns extension substitution. Hide declarations only
    // for the runtime-source lookup so a declaration cannot impersonate code.
    const resolutionHost = runtime
      ? {
          ...host,
          fileExists: (path) => !declaration.test(path) && host.fileExists(path),
        }
      : host;
    return ts.resolveModuleName(
      specifier,
      anchor.endsWith("/") ? `${anchor}package.json` : anchor,
      options,
      resolutionHost,
      undefined,
      undefined,
      mode === "require" ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
    ).resolvedModule?.resolvedFileName;
  }
  const graphPath = (path) => {
    if (!path) {
      return null;
    }
    try {
      return files.get(realpathSync(path))?.path ?? null;
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error.code)) {
        throw error;
      }
      return null;
    }
  };
  return Object.freeze(
    references.map((reference) => {
      let named = false;
      const result = (status, extra = {}) =>
        Object.freeze({ reference, status, to: "", named, ...extra });
      const unresolved = (code, reason, extra = {}) =>
        result("unresolved", { code, reason, ...extra });
      if (reference.value?.status !== "known" || typeof reference.value.value !== "string") {
        return unresolved(
          "unresolved-dynamic-import",
          reference.value?.reason ?? "Module path is not statically known.",
        );
      }
      const specifier = reference.value.value;
      // Node built-ins win over same-named packages for both loader modes.
      // Keep the reference external so caller specifier rules still apply.
      if (isBuiltin(specifier)) {
        return result("external");
      }
      const mode = reference.mode ?? (reference.kind === "require" ? "require" : "import");
      const importer = resolve(root, reference.from);
      const anchor = reference.anchor ?? importer;
      if (
        reference.anchor === null &&
        !isBuiltin(specifier) &&
        !isAbsolute(specifier) &&
        !specifier.startsWith("file:")
      ) {
        return unresolved(
          "unresolved-dynamic-import",
          "Module path has no statically known loader anchor.",
        );
      }
      const pkg = packages.find(
        (item) => specifier === item.name || specifier.startsWith(`${item.name}/`),
      );
      named = Boolean(pkg);
      let target;
      let typeCandidate;
      let nativeTarget;
      try {
        if (pkg) {
          const packageAnchor = resolve(root, pkg.path, "package.json");
          const registered = realpathSync(resolve(root, pkg.path));
          const visible = visiblePackage(anchor, pkg.name, mode);
          if (visible && visible !== registered) {
            return unresolved(
              "workspace-package-mismatch",
              `The package visible from this loader is not the registered ${pkg.name}.`,
            );
          }
          if (mode === "require" && !reference.typeOnly) {
            try {
              const actual = realpathSync(createRequire(anchor).resolve(specifier));
              const within = relative(registered, actual);
              if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
                return unresolved(
                  "workspace-package-mismatch",
                  `The package visible from this loader is not the registered ${pkg.name}.`,
                );
              }
            } catch (error) {
              if (error.code !== "MODULE_NOT_FOUND") {
                throw error;
              }
            }
          }
          typeCandidate = compilerTarget(specifier, packageAnchor, mode);
          const subpath = specifier === pkg.name ? "." : `.${specifier.slice(pkg.name.length)}`;
          if (pkg.manifest.exports === undefined) {
            if (mode !== "require") {
              return unresolved(
                "unsupported-package-export",
                `Package ${pkg.name} requires explicit exports for ESM analysis.`,
              );
            }
            target = resolve(root, pkg.path, subpath);
            typeCandidate = compilerTarget(target, packageAnchor, mode);
            nativeTarget = createRequire(packageAnchor).resolve(target);
          } else {
            const selected = selectPackageExport(
              pkg.manifest.exports,
              subpath,
              new Set(["node", "node-addons", "module-sync", mode]),
            );
            if (typeof selected === "string") {
              target = fileURLToPath(
                new URL(selected, pathToFileURL(`${resolve(root, pkg.path)}/`)),
              );
            }
            if (!target && !reference.typeOnly) {
              return unresolved(
                "unsupported-package-export",
                `Package ${pkg.name} does not expose ${subpath} for this import.`,
              );
            }
            if (reference.typeOnly && !typeCandidate) {
              const types = selectPackageExport(
                pkg.manifest.exports,
                subpath,
                new Set(["types", "node", mode]),
              );
              if (typeof types === "string") {
                typeCandidate = compilerTarget(
                  fileURLToPath(new URL(types, pathToFileURL(`${resolve(root, pkg.path)}/`))),
                  packageAnchor,
                  mode,
                );
              }
            }
            if (mode === "require" && target) {
              try {
                nativeTarget = createRequire(packageAnchor).resolve(specifier);
              } catch (error) {
                if (error.code !== "MODULE_NOT_FOUND") {
                  throw new Error(
                    `Node could not resolve package export (${error.code ?? error.name}).`,
                    { cause: error },
                  );
                }
              }
            }
          }
        } else if (specifier.startsWith("file:")) {
          target = fileURLToPath(specifier);
        } else if (mode === "import" && specifier.startsWith(".")) {
          target = fileURLToPath(new URL(specifier, pathToFileURL(importer)));
        } else if (specifier.startsWith(".") || isAbsolute(specifier)) {
          target = resolve(anchor.endsWith("/") ? anchor : dirname(anchor), specifier);
        } else if (specifier.startsWith("#")) {
          return unresolved(
            "unresolved-local-import",
            "Package import aliases are not supported; use an explicit export or local path.",
          );
        } else if (
          (policy.workspaceNamespaces ?? []).some((prefix) => specifier.startsWith(prefix))
        ) {
          return unresolved(
            "unknown-workspace-package",
            "Workspace package is not registered in the boundary policy.",
          );
        } else {
          return result("external");
        }
      } catch (error) {
        if (!reference.typeOnly || !graphPath(typeCandidate)) {
          const nativeCode = error.code ?? error.cause?.code;
          const detail =
            typeof nativeCode === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(nativeCode)
              ? ` (${nativeCode})`
              : "";
          return unresolved(
            pkg ? "unsupported-package-export" : "unresolved-local-import",
            `${pkg ? "Package" : "Local module"} resolution failed${detail}.`,
          );
        }
        // Erased references can select a valid types branch even when the runtime
        // branch is unavailable. Keep that failure out of the runtime graph.
        target = undefined;
        nativeTarget = undefined;
      }

      if (target && reference.kind === "dependency-anchor") {
        const directory =
          specifier.endsWith("/") && statSync(target, { throwIfNoEntry: false })?.isDirectory();
        if (directory || manifests.has(target)) {
          return result("local", {
            to: slash(relative(root, target)),
            runtimeTarget: null,
            typeTarget: null,
          });
        }
      }
      if (target && reference.kind === "path" && !sourceExtension.test(target)) {
        return result("external", { reason: "Non-source asset URL." });
      }

      if (target && !pkg && mode === "require" && reference.kind !== "dependency-anchor") {
        try {
          nativeTarget = createRequire(anchor).resolve(
            specifier.startsWith("file:") ? target : specifier,
          );
        } catch (error) {
          if (error.code !== "MODULE_NOT_FOUND") {
            return unresolved(
              "unresolved-local-import",
              `Node could not resolve the local module (${error.code ?? error.name}).`,
            );
          }
        }
      }
      if (target && !typeCandidate) {
        typeCandidate = compilerTarget(target, anchor, mode);
      }
      let runtime = nativeTarget ?? target;
      // An existing JavaScript file is authoritative even if a .d.ts or .ts sibling
      // is visible to the compiler. Only absent emitted files map back to source.
      if (runtime && !host.fileExists(runtime) && emittedExtension.test(runtime)) {
        runtime = compilerTarget(runtime, anchor, mode, true);
      }
      const runtimeTarget = runtime && !declaration.test(runtime) ? graphPath(runtime) : null;
      const typeTarget = graphPath(typeCandidate);
      const to = reference.typeOnly ? typeTarget : runtimeTarget;
      if (!to) {
        return unresolved(
          "unresolved-local-import",
          "Local module is missing or outside the active source graph.",
          {
            to: reference.typeOnly
              ? typeCandidate
                ? slash(relative(root, typeCandidate))
                : ""
              : target
                ? slash(relative(root, target))
                : "",
            runtimeTarget,
            typeTarget,
          },
        );
      }
      return result("local", { to, runtimeTarget, typeTarget });
    }),
  );
}
