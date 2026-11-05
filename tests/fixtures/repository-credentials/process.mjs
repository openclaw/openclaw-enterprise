import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharedRsaPrivateKeyPem } from "./shared-keys.mjs";

// Fixture children start from this allowlist rather than the runner's environment,
// and every Git they start inherits it. A commit, merge or receive-pack otherwise
// starts `git maintenance run --auto --detach`, which outlives the awaited command
// and can repack .git/objects under a test or its temporary directory's removal
// (ENOTEMPTY, ENOENT); Git 2.55, for one, repacks once objects/17 holds two loose
// objects. The entry has command-line scope, so no repository or system config turns
// it back on. Callers passing their own GIT_CONFIG_* replace it and must set every
// index. Git drops it for the receiving side of a local push, so a repository that
// receives one sets maintenance.auto=false itself (git.mjs, the router test's target).
export function cleanEnvironment(extra = {}) {
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

export async function run(
  command,
  args,
  { cwd, env = cleanEnvironment(), input, timeout = 30000, allowFailure = false, signal } = {},
) {
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
  let failure;
  let joinTimer;
  let finish;
  // The launcher and its Git/gh children inherit this private process group.
  // Killing only the launcher leaves descendants holding the output pipes.
  const killGroup = () => {
    if (!child.pid) {
      return;
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        failure ??= "termination failed";
      }
    }
  };
  const stop = (reason) => {
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
  const collect = (kind, chunk) => {
    if (failure) {
      return;
    }
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) {
      stop("output overflow");
    } else if (kind === "stdout") {
      stdout += chunk;
    } else {
      stderr += chunk;
    }
  };
  child.stdout.on("data", (chunk) => collect("stdout", chunk));
  child.stderr.on("data", (chunk) => collect("stderr", chunk));
  child.stdin.on("error", () => {});
  const closed = new Promise((resolve) => {
    finish = resolve;
    child.once("error", () => stop("spawn failed"));
    child.once("close", resolve);
  });
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

export async function temporaryDirectory(t, prefix = "repository-credentials-") {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// One self-signed certificate per process on the shared fixture key (shared-keys.mjs), minted by
// the first call in a directory of its own. Every certificate minted from that key and subject
// would verify the others anyway, so later calls lose nothing by reusing it; each still gets its
// own key and cert files.
let fixtureCertificate;

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

export async function createTlsMaterial(t) {
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
  await writeFile(certFile, cert);
  return {
    key: await readFile(keyFile),
    cert: Buffer.from(cert),
    ca: Buffer.from(cert),
    keyFile,
    certFile,
  };
}

// Like tests/helpers/listen.mjs (note: positional `port` before `host`, and it returns an
// https URL), but self-contained: the isolation fixture mounts this directory alone into
// its containers, where tests/helpers is absent.
export async function listen(t, server, port = 0, host = "127.0.0.1") {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  t.after(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  });
  return `https://127.0.0.1:${server.address().port}`;
}
