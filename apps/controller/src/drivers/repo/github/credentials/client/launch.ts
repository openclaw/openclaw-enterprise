import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readClientConfiguration, requireGhMaterial } from "./config.ts";
import { parseGhInvocation, prepareGhCommand, type ClientCommand } from "./commands.ts";
import { createClientEnvironment } from "./environment.ts";
import { singleSessionGitConfiguration } from "./native-git.ts";

export async function executeClientCommand(
  prepared: ClientCommand,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(prepared.executable, prepared.arguments, { env, stdio: "inherit" });
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    const interrupt = (): void => forward("SIGINT");
    const terminate = (): void => forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const cleanup = (): void => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    child.once("error", () => {
      cleanup();
      reject(new Error("client-execution-failed"));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolveExit(code ?? (signal ? 128 : 1));
    });
  });
}

export async function launchClient(
  directory: string,
  command: string,
  args: string[],
): Promise<number> {
  if (command !== "git" && command !== "gh") {
    throw new Error("unsupported-client-command");
  }
  const sessionDirectory = resolve(directory);
  const configuration = await readClientConfiguration(sessionDirectory);
  if (command === "git") {
    return executeClientCommand(
      {
        executable: "/usr/bin/git",
        arguments: [
          ...singleSessionGitConfiguration(configuration, sessionDirectory).flatMap((entry) => [
            "-c",
            entry,
          ]),
          ...args,
        ],
      },
      process.env,
    );
  }
  if (configuration.deadlineWallMs <= Date.now()) {
    throw new Error("repository-session-expired");
  }
  await requireGhMaterial(configuration, sessionDirectory);
  if (configuration.deadlineWallMs <= Date.now()) {
    throw new Error("repository-session-expired");
  }
  const env = createClientEnvironment(
    configuration,
    sessionDirectory,
    process.env.HOME ?? homedir(),
  );
  const settings = singleSessionGitConfiguration(configuration, sessionDirectory);
  env.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach((setting, index) => {
    const separator = setting.indexOf("=");
    env[`GIT_CONFIG_KEY_${index}`] = setting.slice(0, separator);
    env[`GIT_CONFIG_VALUE_${index}`] = setting.slice(separator + 1);
  });
  return executeClientCommand(prepareGhCommand(parseGhInvocation(args), configuration, env), env);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, command, ...args] = process.argv.slice(2);
  if (!directory || !command) {
    process.stderr.write("Usage: repository-client SESSION_DIRECTORY git|gh ARGS...\n");
    process.exitCode = 1;
  } else {
    launchClient(directory, command, args)
      .then((code) => {
        process.exitCode = code;
      })
      .catch(() => {
        process.stderr.write("repository-client-failed\n");
        process.exitCode = 1;
      });
  }
}
