/// <reference lib="es2024.promise" />

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CleanupRegistrar } from "../../helpers/console-file-app.ts";
import { sharedRsaPrivateKeyPem } from "./shared-keys.ts";

// Fixture children start from this allowlist rather than the runner's environment,
// and every Git they start inherits it. A commit, merge or receive-pack otherwise
// starts `git maintenance run --auto --detach`, which outlives the awaited command
// and can repack .git/objects under a test or its temporary directory's removal
// (ENOTEMPTY, ENOENT); Git 2.55, for one, repacks once objects/17 holds two loose
// objects. The entry has command-line scope, so no repository or system config turns
// it back on. Callers passing their own GIT_CONFIG_* replace it and must set every
// index. Git drops it for the receiving side of a local push, so a repository that
// receives one sets maintenance.auto=false itself (git.ts, the router test's target).
export function cleanEnvironment(extra?: Record<string, string>): Record<string, string>;
export function cleanEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    LANG: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    ...extra,
  };
}

export class FixtureCommandTimeoutError extends Error {}

export type FixtureCommandOptions = {
  cwd?: string | URL | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  input?: string | NodeJS.ArrayBufferView | undefined;
  timeout?: number | undefined;
  allowFailure?: boolean | undefined;
  signal?: AbortSignal | undefined;
};

export type FixtureCommandResult = { code: number | null; stdout: string; stderr: string };

export async function run(
  command: string,
  args?: readonly string[],
  {
    cwd,
    env = cleanEnvironment(),
    input,
    timeout = 30000,
    allowFailure = false,
    signal,
  }: FixtureCommandOptions = {},
): Promise<FixtureCommandResult> {
  if (process.platform === "win32") {
    throw new Error("fixture requires POSIX process groups");
  }
  if (signal?.aborted) {
    throw new Error("command cancelled");
  }
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let failure: string | undefined;
  let joinTimer: NodeJS.Timeout | undefined;
  const { promise: closed, resolve: finish } = Promise.withResolvers<number | null>();
  // The launcher and its Git/gh children inherit this private process group.
  // Killing only the launcher leaves descendants holding the output pipes.
  const killGroup = () => {
    if (!child.pid) {
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        failure ??= "termination failed";
      }
    }
  };
  const stop = (reason: string) => {
    failure ??= reason;
    killGroup();
    joinTimer ??= setTimeout(() => {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish(null);
    }, 1000);
  };
  const collect = (kind: "stdout" | "stderr", chunk: Buffer) => {
    if (failure) {
      return;
    }
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) {
      stop("output overflow");
    } else if (kind === "stdout") {
      stdout += chunk.toString();
    } else {
      stderr += chunk.toString();
    }
  };
  child.stdout.on("data", (chunk: Buffer) => collect("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => collect("stderr", chunk));
  child.stdin.on("error", () => {});
  child.once("error", () => stop("spawn failed"));
  child.once("close", finish);
  const cancelled = () => stop("cancelled");
  signal?.addEventListener("abort", cancelled, { once: true });
  const timer = setTimeout(() => stop("timeout"), timeout);
  if (signal?.aborted) {
    cancelled();
  }
  child.stdin.end(input);
  try {
    const code = await closed;
    // Do not serialize command arguments, output, or cancellation reasons:
    // any of them can contain credentials supplied by the client.
    if (failure === "timeout") {
      throw new FixtureCommandTimeoutError("command failed (timeout)");
    }
    if (failure || (code !== 0 && !allowFailure)) {
      throw new Error(`command failed (${failure ?? `exit ${code}`})`);
    }
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
    clearTimeout(joinTimer);
    signal?.removeEventListener("abort", cancelled);
    killGroup();
  }
}

export async function temporaryDirectory(t: CleanupRegistrar, prefix = "repository-credentials-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// One self-signed certificate per process on the shared fixture key (shared-keys.ts), minted by
// the first call in a directory of its own. Every certificate minted from that key and subject
// would verify the others anyway, so later calls lose nothing by reusing it; each still gets its
// own key and cert files.
let fixtureCertificate: ReturnType<typeof mintFixtureCertificate> | undefined;

async function mintFixtureCertificate() {
  const directory = await mkdtemp(join(tmpdir(), "repository-credentials-tls-mint-"));
  try {
    const keyFile = join(directory, "key.pem");
    const certFile = join(directory, "cert.pem");
    await writeFile(keyFile, sharedRsaPrivateKeyPem("repository-credentials-tls"), {
      mode: 0o600,
    });
    await run("openssl", [
      "req",
      "-new",
      "-x509",
      "-key",
      keyFile,
      "-out",
      certFile,
      "-days",
      "2",
      "-subj",
      "/CN=credentials.example.test",
      "-addext",
      "subjectAltName=DNS:credentials.example.test,DNS:localhost,IP:127.0.0.1",
    ]);
    return await readFile(certFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function createTlsMaterial(t: CleanupRegistrar) {
  if (fixtureCertificate === undefined) {
    fixtureCertificate = mintFixtureCertificate();
    fixtureCertificate.catch(() => {
      fixtureCertificate = undefined;
    });
  }
  const cert = await fixtureCertificate;
  const directory = await temporaryDirectory(t, "repository-credentials-tls-");
  const keyFile = join(directory, "key.pem");
  const certFile = join(directory, "cert.pem");
  await writeFile(keyFile, sharedRsaPrivateKeyPem("repository-credentials-tls"), { mode: 0o600 });
  await writeFile(certFile, cert, { mode: 0o644 });
  return {
    key: await readFile(keyFile),
    cert: Buffer.from(cert),
    ca: Buffer.from(cert),
    keyFile,
    certFile,
  };
}

// Like tests/helpers/listen.ts (note: positional `port` before `host`, and it returns an
// https URL), but self-contained: the isolation fixture mounts this directory alone into
// its containers, where tests/helpers is absent.
export async function listen(t: CleanupRegistrar, server: Server, port = 0, host = "127.0.0.1") {
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject: (reason: unknown) => void) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fixture requires a TCP listener");
  }
  return `https://127.0.0.1:${address.port}`;
}
