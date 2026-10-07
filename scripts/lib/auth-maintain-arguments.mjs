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
  constructor(message) {
    super(`${message}\n${AUTH_MAINTAIN_USAGE}`);
    this.name = "AuthMaintainUsageError";
  }
}

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
};

function nonEmpty(value, name) {
  if (typeof value !== "string" || value.trim().length === 0 || value.startsWith("--")) {
    throw new AuthMaintainUsageError(`${name} requires a value.`);
  }
  return value;
}

/** Parse argv after the script path. Mutating commands must name --writers-stopped. */
export function parseAuthMaintainArguments(args) {
  const [command, ...rest] = args[0] === "--" ? args.slice(1) : args;
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (spec === undefined) {
    throw new AuthMaintainUsageError(`Unknown command: ${command ?? "(none)"}.`);
  }
  const values = {};
  const flags = new Set();
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
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
  return Object.freeze({
    command,
    mutating: spec.mutating,
    ...(values["--recovery-user"] === undefined
      ? {}
      : { recoveryUserId: values["--recovery-user"] }),
    ...(positional[0] === undefined ? {} : { userId: positional[0] }),
    ...(values["--user"] === undefined ? {} : { userId: values["--user"] }),
    ...(values["--password-file"] === undefined ? {} : { passwordFile: values["--password-file"] }),
    ...(flags.has("--purge-disabled") ? { purgeDisabled: true } : {}),
  });
}
