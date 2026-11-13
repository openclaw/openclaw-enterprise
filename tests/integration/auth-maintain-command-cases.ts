import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { authMaintain } from "../../scripts/auth-maintain.mjs";
import {
  AUTH_MAINTAIN_COMMANDS,
  AUTH_MAINTAIN_USAGE,
  parseAuthMaintainArguments,
  type AuthMaintainArguments,
} from "../../scripts/lib/auth-maintain-arguments.ts";
import { outputSink } from "../helpers/bootstrap-installation.mjs";
import { jsonLines } from "../helpers/json-lines.mjs";
import { waitUntil } from "../helpers/wait-for.mjs";

const repository = fileURLToPath(new URL("../..", import.meta.url));

interface CommandCapture {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export function record(value: unknown, message: string): Record<string, unknown> {
  assert.ok(isRecord(value), message);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function authMaintainLogs(stderr: string): Record<string, unknown>[] {
  const lines: unknown[] = jsonLines(stderr);
  return lines.map((line) => record(line, "Expected a structured auth:maintain log record"));
}

function commandEnvironment(url: string | undefined, environment: NodeJS.ProcessEnv) {
  return {
    ...process.env,
    NODE_ENV: "development",
    OCC_MIGRATION_DATABASE_URL: url,
    ...environment,
  };
}

function commandResult({ code, stdout, stderr }: CommandCapture) {
  const line = stdout.split("\n").find((entry) => entry.startsWith("{"));
  const output: unknown = line === undefined ? undefined : JSON.parse(line);
  return {
    code,
    output:
      output === undefined ? undefined : record(output, "Expected an auth:maintain result object"),
    stderr,
  };
}

export function requiredOutput({ output }: ReturnType<typeof commandResult>) {
  assert.ok(output, "Expected an auth:maintain result on stdout");
  return output;
}

// The database's client backends other than the caller's own.
async function backendPids(migrationUrl: string): Promise<number[]> {
  const client = new pg.Client({ connectionString: migrationUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ pid: unknown }>(
      `SELECT pid FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid() AND usename IS NOT NULL`,
    );
    return rows.map(({ pid }) => {
      assert.ok(
        typeof pid === "number" && Number.isInteger(pid),
        "Expected a PostgreSQL backend PID",
      );
      return pid;
    });
  } finally {
    // Client.end() resolves once the server closed the connection, so this backend is gone.
    await client.end();
  }
}

export type AuthMaintainRunner = ReturnType<typeof createAuthMaintainRunner>;

export function createAuthMaintainRunner(migrationUrl: string | undefined) {
  // pg's Pool.end() resolves before its connections close, and every mutating command refuses
  // while another backend is listed. Wait for the backends a step opened to leave so the next
  // step sees only the clients a case connects on purpose.
  async function waitForNewBackendsToClose<T>(work: () => Promise<T>): Promise<T> {
    if (!migrationUrl) {
      return work();
    }
    const before = new Set(await backendPids(migrationUrl));
    const result = await work();
    let left: number[] = [];
    await waitUntil(
      () => `backends ${left.join(", ")} to leave after the step`,
      async () => {
        left = (await backendPids(migrationUrl)).filter((pid) => !before.has(pid));
        return left.length === 0;
      },
      { timeoutMs: 5_000, intervalMs: 10 },
    );
    return result;
  }

  // Most runs call authMaintain directly to avoid a Node start per invocation. The real script
  // covers the process exit codes 0, 1, 2, 3 and 64 across the command and lifecycle cases.
  function maintain(
    args: readonly string[],
    url = migrationUrl,
    environment: NodeJS.ProcessEnv = {},
  ) {
    return waitForNewBackendsToClose(async () => {
      const stdout = outputSink();
      const stderr = outputSink();
      const code = await authMaintain({
        environment: commandEnvironment(url, environment),
        args,
        stdout,
        stderr,
        logDestination: stderr,
      });
      return commandResult({ code, stdout: stdout.text(), stderr: stderr.text() });
    });
  }

  function maintainScript(
    args: readonly string[],
    url = migrationUrl,
    environment: NodeJS.ProcessEnv = {},
  ) {
    return waitForNewBackendsToClose(async () => {
      const capture = await new Promise<CommandCapture>((resolve, reject) => {
        execFile(
          process.execPath,
          ["scripts/auth-maintain.mjs", ...args],
          {
            cwd: repository,
            env: commandEnvironment(url, environment),
            encoding: "utf8",
            timeout: 30_000,
          },
          (error, stdout, stderr) => {
            if (error === null) {
              resolve({ code: 0, stdout, stderr });
            } else if (typeof error.code === "number" && !error.killed && !error.signal) {
              resolve({ code: error.code, stdout, stderr });
            } else {
              reject(
                new Error("auth:maintain did not exit with a command status", { cause: error }),
              );
            }
          },
        );
      });
      return commandResult(capture);
    });
  }

  return { maintain, maintainScript, waitForNewBackendsToClose };
}

export function requiresWritersStopped() {
  // The claim is also verified against the database; parsing only refuses to start without it.
  for (const args of [
    ["activate", "--recovery-user", "u1"],
    ["enrol", "u1"],
    ["reset-recovery-password", "--password-file", "/secret"],
    ["purge-sessions"],
    ["deactivate", "--purge-disabled"],
  ]) {
    assert.throws(
      () => parseAuthMaintainArguments(args),
      /^AuthMaintainUsageError: [a-z-]+ changes authentication state; stop the API and worker and pass --writers-stopped\.\n/,
    );
  }
  assert.throws(() => parseAuthMaintainArguments(["status", "--writers-stopped"]), /Unsupported/);
  assert.throws(() => parseAuthMaintainArguments(["enrol", "--writers-stopped"]), /one user id/);
  assert.throws(
    () => parseAuthMaintainArguments(["activate", "--writers-stopped", "--recovery-user"]),
    /requires a value/,
  );
  for (const command of ["drop-everything", "constructor", "toString", "__proto__"]) {
    assert.throws(() => parseAuthMaintainArguments([command]), /Unknown command/);
  }
  for (const args of [[], ["--"]]) {
    assert.throws(
      () => parseAuthMaintainArguments(args),
      /^AuthMaintainUsageError: Unknown command: \(none\)\.\n/,
    );
  }
  assert.deepEqual(
    parseAuthMaintainArguments(["--", "purge-sessions", "--user", "u2", "--writers-stopped"]),
    {
      command: "purge-sessions",
      mutating: true,
      userId: "u2",
    } satisfies AuthMaintainArguments,
  );
  assert.deepEqual(
    parseAuthMaintainArguments(["deactivate", "--writers-stopped", "--purge-disabled"]),
    {
      command: "deactivate",
      mutating: true,
      purgeDisabled: true,
    } satisfies AuthMaintainArguments,
  );
}

export async function rejectsUndeclaredCommands({ maintain, maintainScript }: AuthMaintainRunner) {
  // A relative startup path fails the configuration load, so a declared command stops there.
  const unreadableConfiguration = { OCC_CONFIG_PATH: "relative-startup.yaml" };
  const declared = await maintainScript(["status"], "", unreadableConfiguration);
  assert.equal(declared.code, 1, declared.stderr);
  assert.match(declared.stderr, /^OCC_CONFIG_PATH must identify an absolute/);
  for (const command of ["drop-everything", "constructor", "toString", "__proto__"]) {
    for (const args of [[command], ["--", command, "--writers-stopped"]]) {
      // Invalid commands must report usage even when configuration and credentials are missing.
      // The first invocation exercises the public CLI entrypoint.
      const run = command === "drop-everything" && args.length === 1 ? maintainScript : maintain;
      const result = await run(args, "", unreadableConfiguration);
      assert.equal(result.code, 64, `${args.join(" ")}: ${result.stderr}`);
      assert.equal(result.stderr, `Unknown command: ${command}.\n${AUTH_MAINTAIN_USAGE}\n`);
      assert.equal(result.output, undefined);
    }
  }
}

export async function logsFailedCommands({ maintain }: AuthMaintainRunner) {
  // Valid arguments for every command; the startup file then fails the run before the database.
  const valid: Record<AuthMaintainArguments["command"], readonly string[]> = {
    status: ["status"],
    activate: ["activate", "--recovery-user", "user-argument", "--writers-stopped"],
    enrol: ["enrol", "user-argument", "--writers-stopped"],
    "reset-recovery-password": [
      "reset-recovery-password",
      "--password-file",
      "/run/secrets/path-argument",
      "--writers-stopped",
    ],
    "purge-sessions": ["purge-sessions", "--writers-stopped"],
    deactivate: ["deactivate", "--purge-disabled", "--writers-stopped"],
  };
  assert.deepEqual(Object.keys(valid), AUTH_MAINTAIN_COMMANDS);
  for (const [command, args] of Object.entries(valid)) {
    const result = await maintain(args, "", { OCC_CONFIG_PATH: "relative-startup.yaml" });
    assert.equal(result.code, 1, `${command}: ${result.stderr}`);
    const logged = authMaintainLogs(result.stderr).filter(
      ({ event }) => event === "auth-maintain.failed",
    );
    // The command is a fixed code; its arguments (a user ID, a file path) never reach the log.
    assert.deepEqual(
      logged.map(({ code, command: loggedCommand }) => ({ code, command: loggedCommand })),
      [{ code: "AUTH_MAINTENANCE_FAILED", command }],
      result.stderr,
    );
    assert.doesNotMatch(result.stderr, /user-argument|path-argument/);
  }
}
