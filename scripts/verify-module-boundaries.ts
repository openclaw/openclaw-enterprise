import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readWorkspace, parseJSON } from "./module-boundaries/workspace.ts";
import { freezeRecord } from "./module-boundaries/freeze-record.ts";
import { collectSourceImports } from "./module-boundaries/source-imports.ts";
import { resolveImports } from "./module-boundaries/resolve-import.ts";
import { evaluatePolicy, validatePolicy } from "./module-boundaries/evaluate-policy.ts";
import { applyExceptions, validateExceptions } from "./module-boundaries/exceptions.ts";

const defaultRoot = fileURLToPath(new URL("../", import.meta.url));

/** Analyze source with an explicit caller policy, without executing imported code. */
export async function verifyModuleBoundaries({
  root = defaultRoot,
  policy,
  exceptions = { version: 1, exceptions: [] },
}: { root?: string; policy?: unknown; exceptions?: unknown } = {}) {
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
type Writer = { write(text: string): unknown };
async function main(args: readonly string[], stdout: Writer, stderr: Writer) {
  const options: { root?: string; policy?: string; exceptions?: string; json?: boolean } = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--help" && args.length === 1) {
      stdout.write(`${usage}\n`);
      return 0;
    }
    if (argument === "--json" && !options.json) {
      options.json = true;
    } else if (
      (argument === "--root" || argument === "--policy" || argument === "--exceptions") &&
      args[index + 1] &&
      !args[index + 1]?.startsWith("--") &&
      !options[
        argument.slice(2) === "root"
          ? "root"
          : argument.slice(2) === "policy"
            ? "policy"
            : "exceptions"
      ]
    ) {
      const value = args[++index];
      if (value === undefined) {
        throw new Error(usage);
      }
      if (argument === "--root") {
        options.root = value;
      } else if (argument === "--policy") {
        options.policy = value;
      } else {
        options.exceptions = value;
      }
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
  validatePolicy(policy);
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
  args: readonly string[],
  { stdout = process.stdout, stderr = process.stderr }: { stdout?: Writer; stderr?: Writer } = {},
) {
  try {
    return await main(args, stdout, stderr);
  } catch (error) {
    const details = error == null ? undefined : Object(error);
    const rawCode: unknown = details === undefined ? undefined : Reflect.get(details, "code");
    const message: unknown = details === undefined ? undefined : Reflect.get(details, "message");
    const code =
      typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(rawCode) ? rawCode : null;
    stderr.write(
      code
        ? `Module boundary configuration failed (${code}).\n`
        : `Module boundary configuration failed: ${message}\n`,
    );
    return 2;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runModuleBoundaryCli(process.argv.slice(2));
}
