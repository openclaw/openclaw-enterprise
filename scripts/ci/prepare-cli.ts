import { chmod, writeFile } from "node:fs/promises";
import {
  nativeIAMBarrierFile,
  normalizeFile,
  repositoryCredentialsFileNeedsBinary,
  type PrepareFileOptions,
  type PrepareLaneOptions,
} from "./prepare-inputs.ts";

type PreparationResult = { env: Record<string, string>; defaults?: Record<string, string> };
type PreparationCommands = {
  prepareFile: (options: PrepareFileOptions) => Promise<PreparationResult>;
  prepareLane: (options: PrepareLaneOptions) => Promise<PreparationResult>;
};

function parseArgs(argv: readonly string[]) {
  const args: Record<string, string> = {};
  const tokens = argv.values();
  let arg = tokens.next().value;
  while (arg !== undefined) {
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (
      /^(?:warm-image-cache|require-cache-export|node-base-image|validate-node-base-image)(?:=|$)/u.test(
        name,
      )
    ) {
      throw new Error("Image cache warming uses scripts/ci/warm-image-cache.ts.");
    }
    const value = tokens.next().value;
    if (value === undefined || value.startsWith("--")) {
      args[name] = "1";
      arg = value;
    } else {
      args[name] = value;
      arg = tokens.next().value;
    }
  }
  return args;
}

// The Actions runner refuses NODE_OPTIONS in $GITHUB_ENV, compared without case, and logs an
// ##[error] for it. A lane's own env, such as the checks lanes' heap limit, needs no export:
// run-tests.ts sets it on each test process.
async function appendGithubEnv(path: string | undefined, env: Record<string, string>) {
  if (!path) {
    return;
  }
  const lines = Object.entries(env)
    .filter(([name]) => name.toUpperCase() !== "NODE_OPTIONS")
    .map(([name, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
        throw new Error("Invalid GitHub environment name.");
      }
      if (/[\r\n]/u.test(value)) {
        throw new Error(`Invalid GitHub environment value for ${name}.`);
      }
      return `${name}=${value}`;
    });
  if (lines.length === 0) {
    return;
  }
  await writeFile(path, `${lines.join("\n")}\n`, { flag: "a", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function runPreparationCli(
  argv: readonly string[],
  { prepareFile, prepareLane }: PreparationCommands,
) {
  const args = parseArgs(argv);
  if (!args.lane) {
    throw new Error("--lane is required.");
  }
  if (
    args.file &&
    normalizeFile(args.file) === nativeIAMBarrierFile &&
    (args["github-env"] || process.env.GITHUB_ENV)
  ) {
    throw new Error(
      "The selected private PostgreSQL fixture must be prepared within the test runner.",
    );
  }
  if (
    args.file &&
    args.lane === "repository-credentials-container" &&
    repositoryCredentialsFileNeedsBinary(normalizeFile(args.file))
  ) {
    throw new Error(
      "Repository credential binary consumers must be prepared within the test runner.",
    );
  }
  const result = args.file
    ? await prepareFile({ lane: args.lane, file: args.file, statePath: args.state })
    : await prepareLane({
        lane: args.lane,
        statePath: args.state,
        file: args["selected-file"],
        cleanupOwner: args["cleanup-owner"],
      });
  const env = { ...result.defaults, ...result.env };
  await appendGithubEnv(args["github-env"] ?? process.env.GITHUB_ENV, env);
  process.stdout.write(`${JSON.stringify({ envNames: Object.keys(env).sort() }, null, 2)}\n`);
}
