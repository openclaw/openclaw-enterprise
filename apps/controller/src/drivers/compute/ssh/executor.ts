import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { currentComputeAbortSignal } from "../operation-context.ts";

export interface SshCommand {
  readonly address: string;
  readonly port: number;
  readonly user: string;
  readonly nodePath: string;
  readonly identityFile: string;
  readonly knownHostsFile: string;
  readonly connectTimeoutSeconds: number;
  readonly helper: string;
  readonly operation: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

export interface SshCommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SshNamespaceTarget {
  readonly hostname: string;
  readonly port: string;
  readonly user: string;
  readonly hostKeyAlias: string;
  readonly publicTrust: readonly string[];
}

export class SshNamespaceTargetRefused extends Error {}

export interface SshCommandExecutor {
  resolveNamespaceTarget?(command: SshCommand): Promise<SshNamespaceTarget>;
  execute(command: SshCommand): Promise<SshCommandResult>;
}

// How long the executor keeps reading ssh's stdio after the ssh process exits. A
// descendant that inherited the pipes (an operator ProxyCommand inherits stderr) can hold
// them open indefinitely, and the child's "close" event waits for every pipe to close.
const STDIO_DRAIN_AFTER_EXIT_MS = 1_000;

const executeFile = promisify(execFile);

function sshArguments(command: SshCommand): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${command.knownHostsFile}`,
    "-o",
    "IdentitiesOnly=yes",
    "-i",
    command.identityFile,
    "-o",
    `ConnectTimeout=${command.connectTimeoutSeconds}`,
    "-o",
    "LogLevel=ERROR",
    "-p",
    String(command.port),
    "-l",
    command.user,
    command.address,
  ];
}

// OpenSSH expands ~ in trust-file settings. Parse its quoted output without a shell.
function trustFiles(value: string): string[] {
  return (value.match(/"[^"]*"|'[^']*'|[^\s]+/gu) ?? [])
    .map((entry) => {
      const path = entry.replace(/^["']|["']$/gu, "");
      return path.startsWith("~/") ? homedir() + path.slice(1) : path;
    })
    .filter((entry) => entry !== "none");
}

export class SystemSshCommandExecutor implements SshCommandExecutor {
  async resolveNamespaceTarget(command: SshCommand): Promise<SshNamespaceTarget> {
    const owner = command.signal ?? currentComputeAbortSignal();
    const timeout = AbortSignal.timeout(command.timeoutMs);
    const signal = owner === undefined ? timeout : AbortSignal.any([owner, timeout]);
    signal.throwIfAborted();
    // The selected trusted SSH profile can run Match exec, just as a connection can.
    // This is configuration evaluation, never a passive inspection of arbitrary profiles.
    const result = await this.run(command, ["-G", ...sshArguments(command)]);
    if (result.code !== 0) {
      throw new Error("SSH target configuration could not be resolved.");
    }
    const stdout = result.stdout;
    const settings = new Map(
      stdout
        .trim()
        .split("\n")
        .map((line) => {
          const split = line.indexOf(" ");
          return [line.slice(0, split), line.slice(split + 1)];
        }),
    );
    const dynamicTrust = settings.get("knownhostscommand");
    if (
      (dynamicTrust !== undefined && dynamicTrust !== "none") ||
      ["true", "yes"].includes(settings.get("verifyhostkeydns") ?? "")
    ) {
      throw new SshNamespaceTargetRefused(
        "SSH Namespace lifecycle requires file-backed public host trust.",
      );
    }
    const hostname = settings.get("hostname");
    const port = settings.get("port");
    const user = settings.get("user");
    const explicitAlias = settings.get("hostkeyalias");
    const hostKeyAlias = explicitAlias ?? hostname;
    if (!hostname || !port || !user || !hostKeyAlias) {
      throw new Error("SSH target configuration could not be resolved.");
    }
    let lookup = hostKeyAlias;
    if (explicitAlias === undefined && port !== "22") {
      lookup = `[${hostname}]:${port}`;
    }
    const files = [
      ...trustFiles(settings.get("userknownhostsfile") ?? command.knownHostsFile),
      ...trustFiles(settings.get("globalknownhostsfile") ?? ""),
    ];
    const keys = new Set<string>();
    for (const file of files) {
      const info = await stat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      });
      if (info === undefined) {
        continue;
      }
      if (!info.isFile()) {
        throw new Error("SSH public trust must be a regular file.");
      }
      let matched: string;
      try {
        matched = (
          await executeFile("ssh-keygen", ["-F", lookup, "-f", file], {
            signal,
            timeout: command.timeoutMs,
            maxBuffer: 256 * 1024,
          })
        ).stdout;
      } catch (error) {
        // ssh-keygen exits 1 when the selected file has no matches. Other failures withhold effects.
        if ((error as { code?: unknown }).code === 1) {
          continue;
        }
        throw new Error("SSH public trust could not be resolved.", { cause: error });
      }
      for (const line of matched.split("\n")) {
        if (line.startsWith("#") || line.trim() === "") {
          continue;
        }
        const tokens = line.trim().split(/\s+/u);
        const marker = tokens[0]?.startsWith("@") ? tokens.shift()! : "";
        const [, algorithm, key] = tokens;
        if (!algorithm || !key || !/^[A-Za-z0-9+/]+={0,2}$/u.test(key)) {
          throw new Error("SSH public trust contains an unsupported key.");
        }
        keys.add(
          `${marker}:${algorithm}:${createHash("sha256").update(Buffer.from(key, "base64")).digest("hex")}`,
        );
      }
    }
    if (keys.size === 0) {
      throw new SshNamespaceTargetRefused("SSH target has no selected public host trust.");
    }
    return { hostname, port, user, hostKeyAlias, publicTrust: [...keys].sort() };
  }

  async execute(command: SshCommand): Promise<SshCommandResult> {
    return this.run(
      command,
      [...sshArguments(command), "--", command.nodePath, "-"],
      `const SSH_OPERATION = ${JSON.stringify(command.operation)};\n${command.helper}`,
    );
  }

  private async run(
    command: SshCommand,
    args: string[],
    input?: string,
  ): Promise<SshCommandResult> {
    const owner = command.signal ?? currentComputeAbortSignal();
    const timeout = AbortSignal.timeout(command.timeoutMs);
    const signal = owner === undefined ? timeout : AbortSignal.any([owner, timeout]);
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn("ssh", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let termination: ReturnType<typeof setTimeout> | undefined;
      let drain: ReturnType<typeof setTimeout> | undefined;
      let failed: Error | undefined;
      const terminate = () => {
        child.kill("SIGTERM");
        termination ??= setTimeout(() => child.kill("SIGKILL"), 1_000);
        termination.unref();
      };
      const abort = () => {
        failed = new Error("SSH compute operation cancelled or timed out.");
        terminate();
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        // A child that ignores SIGTERM keeps writing until SIGKILL: drop that output.
        if (stdout.length > 64 * 1024) {
          return;
        }
        stdout += chunk;
        if (stdout.length > 64 * 1024) {
          failed = new Error("SSH helper output exceeded its limit.");
          terminate();
        }
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        // Diagnostics never include SSH's untrusted raw stderr in a thrown error.
        stderr = (stderr + chunk).slice(0, 4_096);
      });
      child.once("error", () => {
        failed = new Error("SSH client could not be started.");
      });
      child.stdin.on("error", () => {
        failed ??= new Error("SSH helper input could not be delivered.");
      });
      child.once("exit", () => {
        // Output ssh wrote before exiting is already in the pipes. After a short drain, stop
        // waiting for descendants so "close" fires: a timed-out operation then settles within
        // timeoutMs plus the SIGKILL grace and this drain.
        drain = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
        }, STDIO_DRAIN_AFTER_EXIT_MS);
        drain.unref();
      });
      child.once("close", (code) => {
        signal.removeEventListener("abort", abort);
        clearTimeout(termination);
        clearTimeout(drain);
        if (failed !== undefined) {
          reject(failed);
        } else {
          resolve({ code: code ?? 1, stdout, stderr });
        }
      });
      // Operation data can contain private setup documents. Send it on the encrypted
      // stdin channel rather than exposing it in either local or remote process argv.
      child.stdin.end(input);
    });
  }
}
