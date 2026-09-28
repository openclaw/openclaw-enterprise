import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGhInvocation, prepareGhCommand } from "./commands.ts";
import { requireGhMaterial } from "./config.ts";
import { createClientEnvironment } from "./environment.ts";
import { executeClientCommand } from "./launch.ts";
import {
  inheritedRepositoryBinding,
  readRuntimeRepositoryManifest,
  repositorySelection,
  repositorySelectionVariable,
  requireCurrentBinding,
} from "./manifest.ts";
import { selectGhRepository, selectImplicitGhRepository } from "./targets.ts";

/** Only gh needs command routing; ordinary Git executes without a shim. */
export async function routeRepositoryClient(command: string, args: string[]): Promise<number> {
  if (command !== "gh") {
    throw new Error("unsupported-client-command");
  }
  const gh = parseGhInvocation(args);
  const manifest = await readRuntimeRepositoryManifest();
  const pinned = inheritedRepositoryBinding(manifest, process.env);
  const binding = gh.target
    ? selectGhRepository(manifest, gh.target.value, pinned)
    : (pinned ?? selectImplicitGhRepository(manifest, process.env));
  requireCurrentBinding(binding);
  await requireGhMaterial(binding.configuration, binding.directory);
  requireCurrentBinding(binding);
  const normalizedArgs = [...gh.args];
  if (gh.target?.kind === "repository") {
    normalizedArgs[gh.target.index] = `github.com/${binding.client.repository}`;
  } else if (gh.target?.kind === "endpoint") {
    normalizedArgs[gh.target.index] =
      `repos/${binding.client.repository}` +
      normalizedArgs[gh.target.index]!.slice(`repos/${gh.target.value}`.length);
  }
  const env = createClientEnvironment(
    binding.configuration,
    binding.directory,
    process.env.HOME ?? homedir(),
  );
  env[repositorySelectionVariable] = repositorySelection(manifest, binding);
  env.OCE_REPOSITORY_REF = binding.repositoryRef;
  const prepared = prepareGhCommand({ ...gh, args: normalizedArgs }, binding.configuration, env);
  return executeClientCommand(prepared, env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  routeRepositoryClient(command ?? "", args)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : "";
      const publicReasons = new Set([
        "name-one-repository-target",
        "name-one-repository-ref",
        "repository-not-admitted",
        "conflicting-repository-selection",
        "unsupported-repository-target",
        "unsupported-client-command",
        "explicit-head-required",
        "repository-session-expired",
        "invalid-repository-selection",
      ]);
      process.stderr.write(
        publicReasons.has(reason) ? `${reason}\n` : "repository-client-failed\n",
      );
      process.exitCode = 1;
    });
}
