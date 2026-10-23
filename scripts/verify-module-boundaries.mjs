import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readWorkspace, freezeRecord, parseJSON } from "./module-boundaries/workspace.mjs";
import { collectSourceImports } from "./module-boundaries/source-imports.mjs";
import { resolveImports } from "./module-boundaries/resolve-import.mjs";
import { evaluatePolicy, validatePolicy } from "./module-boundaries/evaluate-policy.mjs";
import { applyExceptions, validateExceptions } from "./module-boundaries/exceptions.mjs";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));

/** Analyze source with an explicit caller policy, without executing imported code. */
export async function verifyModuleBoundaries({
  root = defaultRoot,
  policy,
  exceptions = { version: 1, exceptions: [] },
} = {}) {
  if (!policy) {
    throw new Error("An explicit module-boundary policy is required.");
  }
  validatePolicy(policy);
  validateExceptions(exceptions);
  const snapshot = await readWorkspace(root, policy);
  const source = collectSourceImports(snapshot);
  const resolutions = await resolveImports(snapshot, source.references, policy);
  const evaluated = evaluatePolicy(snapshot, resolutions, policy);
  const resolutionDiagnostics = resolutions
    .filter((item) => item.status === "unresolved")
    .map((item) => {
      const { from, specifier, kind, typeOnly, bindings, line, loaderIdentity } = item.reference;
      return {
        category: "resolution",
        rule: item.code,
        from,
        to: item.to ?? "",
        specifier,
        kind,
        typeOnly,
        bindings,
        line,
        message: item.reason,
        ...(loaderIdentity ? { loaderIdentity } : {}),
      };
    });
  const accepted = applyExceptions(
    [...source.diagnostics, ...resolutionDiagnostics, ...evaluated.diagnostics],
    exceptions,
  );
  // Report public identities only: native anchors and source text remain internal.
  const reportedResolutions = resolutions.map(({ reference, ...resolution }) => {
    const { from, specifier, kind, typeOnly, bindings, line, mode, loaderIdentity } = reference;
    return {
      ...resolution,
      reference: {
        from,
        specifier,
        kind,
        typeOnly,
        bindings,
        line,
        mode,
        ...(loaderIdentity ? { loaderIdentity } : {}),
      },
    };
  });
  return freezeRecord({
    ok: accepted.violations.length === 0,
    files: snapshot.files.map((file) => file.path),
    resolutions: reportedResolutions,
    edges: evaluated.edges,
    runtimeCycles: evaluated.runtimeCycles,
    typeOnlyCycles: evaluated.typeOnlyCycles,
    typeInvolvingCycles: evaluated.typeInvolvingCycles,
    ...accepted,
  });
}

const usage =
  "Usage: node scripts/verify-module-boundaries.mjs --policy file [--root directory] [--exceptions file] [--json]";
async function main(args, stdout, stderr) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" && args.length === 1) {
      stdout.write(`${usage}\n`);
      return 0;
    }
    if (argument === "--json" && !options.json) {
      options.json = true;
    } else if (
      ["--root", "--policy", "--exceptions"].includes(argument) &&
      args[index + 1] &&
      !args[index + 1].startsWith("--") &&
      !options[argument.slice(2)]
    ) {
      options[argument.slice(2)] = args[++index];
    } else {
      throw new Error(usage);
    }
  }
  if (!options.policy) {
    throw new Error(`An explicit --policy file is required. ${usage}`);
  }
  const root = resolve(options.root ?? defaultRoot);
  const policy = parseJSON(await readFile(resolve(root, options.policy), "utf8"), "policy");
  const exceptions = options.exceptions
    ? parseJSON(await readFile(resolve(root, options.exceptions), "utf8"), "exceptions")
    : undefined;
  const result = await verifyModuleBoundaries({ root, policy, exceptions });
  if (options.json) {
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    const limit = policy.diagnosticLimit ?? 50;
    for (const item of result.violations.slice(0, limit)) {
      stderr.write(
        `${item.from}:${item.line} [${item.rule}] ${item.message} ${item.to || item.specifier}\n`,
      );
    }
    if (result.violations.length > limit) {
      stderr.write(
        `${result.violations.length - limit} additional violations; use --json for the full report.\n`,
      );
    }
    stdout.write(
      `Module boundaries ${result.ok ? "verified" : "failed"}: ${result.files.length} sources, ${result.edges.length} local edges, ${result.baseline.length} explicit exceptions, ${result.runtimeCycles.length} runtime cycles, ${result.typeOnlyCycles.length} type-only cycle groups (${result.typeInvolvingCycles.length} type-involving groups), ${result.violations.length} violations.\n`,
    );
  }
  return result.ok ? 0 : 1;
}

/**
 * The command line: `args` without the node and script paths. Writes the report to `stdout`
 * and `stderr` (anything with a write(text) method) and resolves to the exit status: 0
 * verified, 1 violations, 2 configuration failure.
 */
export async function runModuleBoundaryCli(
  args,
  { stdout = process.stdout, stderr = process.stderr } = {},
) {
  try {
    return await main(args, stdout, stderr);
  } catch (error) {
    const code =
      typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code)
        ? error.code
        : null;
    stderr.write(
      code
        ? `Module boundary configuration failed (${code}).\n`
        : `Module boundary configuration failed: ${error.message}\n`,
    );
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runModuleBoundaryCli(process.argv.slice(2));
}
