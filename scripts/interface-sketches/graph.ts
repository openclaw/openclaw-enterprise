import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeCoupling } from "./coupling.ts";
import { sourceFiles, verifyEvidence } from "./evidence.ts";

const usage = `Usage: node graph.ts [--root PATH] [--check]
       node graph.ts [--root PATH] --file REPO_RELATIVE_FILE [--file REPO_RELATIVE_FILE ...]

Default: print a bounded static coupling graph and diagram claim results as JSON.
--check: check the selected diagram claims; fail if claims are missing or fail.
--file: inspect explicit source files without verifying curated diagram claims.
Inputs are read from the working tree, not from a pinned Git commit.`;

function options(args: readonly string[]) {
  let root = fileURLToPath(new URL("../../", import.meta.url));
  let check = false;
  const files: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--root" || arg === "--file") {
      const value = args[++index];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value.\n${usage}`);
      }
      if (arg === "--root") {
        root = resolve(value);
      } else {
        files.push(value);
      }
    } else {
      throw new Error(`Unknown argument: ${arg}.\n${usage}`);
    }
  }
  if (check && files.length > 0) {
    throw new Error(
      "--file cannot be combined with --check; use the default diagram selection to check claims.",
    );
  }
  return { root, check, files };
}

function selectedFiles(root: string, files: readonly string[]): string[] {
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Source root does not exist or is not a directory; supply --root PATH.");
  }
  const realRoot = realpathSync(root);
  return [
    ...new Set(
      files.map((file) => {
        if (isAbsolute(file) || file.includes("\\") || file.split("/").includes("..")) {
          throw new Error(`Expected a POSIX repo-relative source path: ${file}`);
        }
        const absolute = resolve(realRoot, file);
        const normalized = relative(realRoot, absolute).split(sep).join("/");
        if (
          !/\.(?:[cm]?[jt]s|[jt]sx)$/.test(normalized) ||
          normalized.split("/").includes("node_modules")
        ) {
          throw new Error(`Expected a repository TypeScript or JavaScript source file: ${file}`);
        }
        if (!statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(
            `Source file is missing or is not a regular file: ${normalized}. Check --root and --file.`,
          );
        }
        const realRelative = relative(realRoot, realpathSync(absolute));
        if (
          isAbsolute(realRelative) ||
          realRelative === ".." ||
          realRelative.startsWith(`..${sep}`)
        ) {
          throw new Error(`Source file resolves outside the repository: ${normalized}`);
        }
        return normalized;
      }),
    ),
  ].sort();
}

function main(args: readonly string[]): void {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return;
  }
  const config = options(args);
  const custom = config.files.length > 0;
  const files = selectedFiles(config.root, custom ? config.files : sourceFiles);
  if (files.length === 0) {
    throw new Error(
      "No source files selected; restore the diagram source selection or supply --file.",
    );
  }
  const graph = analyzeCoupling(config.root, files);
  const evidence = custom
    ? {
        claims: [],
        problems: [],
        status: "not-checked",
        reason: "Explicit --file selection does not verify curated diagram claims.",
      }
    : verifyEvidence(graph.edges);
  const problems = [...evidence.problems];
  if (!custom && evidence.claims.length === 0) {
    problems.push("No diagram claims were supplied; restore the evidence claim inventory.");
  }
  if (config.check) {
    console.log(
      `Static diagram claims: ${problems.length === 0 ? "PASS" : "FAIL"}; ${evidence.claims.length} claims, ${files.length} files, ${graph.edges.length} observed edges, ${graph.unresolved.length} unresolved sites.`,
    );
    for (const problem of problems) {
      console.error(problem);
    }
    if (problems.length > 0) {
      process.exitCode = 1;
    }
    return;
  }
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        source: { state: "working-tree", commit: null, paths: "POSIX repo-relative" },
        scope: {
          mode: custom ? "explicit-files" : "diagram-selection",
          analysis:
            "Bounded compiler-resolved static coupling in the selected source files; external declarations are out of scope.",
          attribution:
            "Nested inline handlers are attributed lexically to their nearest named top-level owner or class member.",
          limits: [
            "Not runtime execution or runtime control flow",
            "Not replacement Driver identity",
            "Not complete reachability",
            "Not provider contact",
            "Not formal security verification",
          ],
        },
        files,
        edges: graph.edges,
        unresolved: graph.unresolved,
        evidence: { ...evidence, problems },
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(`Coupling graph: ${error instanceof Error ? error.message : "analysis failed"}`);
    process.exitCode = 1;
  }
}
