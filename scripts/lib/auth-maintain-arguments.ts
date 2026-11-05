export const AUTH_MAINTAIN_USAGE = `Usage: pnpm auth:maintain <command> [options]
Commands:
  status
  activate --recovery-user <userId> --writers-stopped
  enrol <userId> --writers-stopped
  reset-recovery-password --password-file <path> --writers-stopped
  purge-sessions [--user <userId>] --writers-stopped
  deactivate [--purge-disabled] --writers-stopped
Connects with OCC_MIGRATION_DATABASE_URL. Stop the API and worker first;
--writers-stopped is verified against the database, not trusted.`;

export class AuthMaintainUsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${AUTH_MAINTAIN_USAGE}`);
    this.name = "AuthMaintainUsageError";
  }
}

interface CommandSpecification {
  readonly values: readonly string[];
  readonly flags: readonly string[];
  readonly positional: boolean;
  readonly mutating: boolean;
}

export type AuthMaintainArguments = Readonly<
  | { command: "status"; mutating: false }
  | { command: "activate"; mutating: true; recoveryUserId: string }
  | { command: "enrol"; mutating: true; userId: string }
  | { command: "reset-recovery-password"; mutating: true; passwordFile: string }
  | { command: "purge-sessions"; mutating: true; userId?: string }
  | { command: "deactivate"; mutating: true; purgeDisabled?: true }
>;

const COMMANDS = {
  status: { values: [], flags: [], positional: false, mutating: false },
  activate: { values: ["--recovery-user"], flags: [], positional: false, mutating: true },
  enrol: { values: [], flags: [], positional: true, mutating: true },
  "reset-recovery-password": {
    values: ["--password-file"],
    flags: [],
    positional: false,
    mutating: true,
  },
  "purge-sessions": { values: ["--user"], flags: [], positional: false, mutating: true },
  deactivate: { values: [], flags: ["--purge-disabled"], positional: false, mutating: true },
} satisfies Record<string, CommandSpecification>;

/** Every command, a fixed list: a failed run logs its command as a code. */
export const AUTH_MAINTAIN_COMMANDS = Object.freeze(Object.keys(COMMANDS));

function nonEmpty(value: string | undefined, name: string) {
  if (typeof value !== "string" || value.trim().length === 0 || value.startsWith("--")) {
    throw new AuthMaintainUsageError(`${name} requires a value.`);
  }
  return value;
}

/** Parse argv after the script path. Mutating commands must name --writers-stopped. */
function isCommand(command: string | undefined): command is keyof typeof COMMANDS {
  return command !== undefined && Object.hasOwn(COMMANDS, command);
}

export function parseAuthMaintainArguments(args: readonly string[]): AuthMaintainArguments {
  const [command, ...rest] = args[0] === "--" ? args.slice(1) : args;
  if (!isCommand(command)) {
    throw new AuthMaintainUsageError(`Unknown command: ${command ?? "(none)"}.`);
  }
  const spec: CommandSpecification = COMMANDS[command];
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === undefined) {
      continue;
    }
    if (spec.values.includes(argument)) {
      if (Object.hasOwn(values, argument)) {
        throw new AuthMaintainUsageError(`${argument} may be given once.`);
      }
      values[argument] = nonEmpty(rest[index + 1], argument);
      index += 1;
    } else if (
      spec.flags.includes(argument) ||
      (spec.mutating && argument === "--writers-stopped")
    ) {
      if (flags.has(argument)) {
        throw new AuthMaintainUsageError(`${argument} may be given once.`);
      }
      flags.add(argument);
    } else if (spec.positional && !argument.startsWith("--") && positional.length === 0) {
      positional.push(nonEmpty(argument, command));
    } else {
      throw new AuthMaintainUsageError(`Unsupported argument for ${command}: ${argument}.`);
    }
  }
  if (spec.mutating && !flags.has("--writers-stopped")) {
    throw new AuthMaintainUsageError(
      `${command} changes authentication state; stop the API and worker and pass --writers-stopped.`,
    );
  }
  if (spec.positional && positional.length !== 1) {
    throw new AuthMaintainUsageError(`${command} requires one user id.`);
  }
  if (command === "activate" && values["--recovery-user"] === undefined) {
    throw new AuthMaintainUsageError("activate requires --recovery-user.");
  }
  if (command === "reset-recovery-password" && values["--password-file"] === undefined) {
    throw new AuthMaintainUsageError("reset-recovery-password requires --password-file.");
  }
  switch (command) {
    case "status":
      return Object.freeze({ command, mutating: false });
    case "activate":
      return Object.freeze({
        command,
        mutating: true,
        recoveryUserId: nonEmpty(values["--recovery-user"], "--recovery-user"),
      });
    case "enrol":
      return Object.freeze({ command, mutating: true, userId: nonEmpty(positional[0], command) });
    case "reset-recovery-password":
      return Object.freeze({
        command,
        mutating: true,
        passwordFile: nonEmpty(values["--password-file"], "--password-file"),
      });
    case "purge-sessions":
      return Object.freeze({
        command,
        mutating: true,
        ...(values["--user"] === undefined ? {} : { userId: values["--user"] }),
      });
    case "deactivate":
      return Object.freeze({
        command,
        mutating: true,
        ...(flags.has("--purge-disabled") ? { purgeDisabled: true as const } : {}),
      });
  }
}
