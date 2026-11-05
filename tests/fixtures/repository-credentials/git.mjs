import { spawn } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanEnvironment,
  createTlsMaterial,
  listen,
  run,
  temporaryDirectory,
} from "./process.mjs";

// Seeding a repository takes nine Git processes. The first fixture for a repository name in a
// process seeds a template; every fixture copies it into its own directory without Git, so a
// fixture that receives pushes or adds commits changes only its copy. Templates are removed when
// the process exits; like any temporary directory, a process killed by a signal leaves them.
const repositoryTemplates = new Map();
const templateDirectories = new Set();
process.once("exit", () => {
  for (const directory of templateDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repositoryTemplate(repository) {
  let template = repositoryTemplates.get(repository);
  if (template === undefined) {
    template = seedRepositoryTemplate(repository);
    repositoryTemplates.set(repository, template);
    template.catch(() => repositoryTemplates.delete(repository));
  }
  return template;
}

async function seedRepositoryTemplate(repository) {
  const directory = await mkdtemp(join(tmpdir(), "repository-credentials-git-template-"));
  templateDirectories.add(directory);
  const bare = join(directory, `${repository}.git`);
  const seed = join(directory, "seed");
  await mkdir(join(bare, ".."), { recursive: true });
  await run("git", ["init", "--bare", "--initial-branch=main", bare]);
  // Git starts the receiving side of a local push without GIT_CONFIG_COUNT, so
  // cleanEnvironment()'s maintenance.auto=false never reaches this repository's
  // receive-pack; only its own configuration stops the detached maintenance.
  await run("git", ["config", "maintenance.auto", "false"], { cwd: bare });
  await run("git", ["init", "--initial-branch=main", seed]);
  await run("git", ["config", "user.name", "Fixture"], { cwd: seed });
  await run("git", ["config", "user.email", "fixture@example.test"], { cwd: seed });
  await writeFile(join(seed, "README.md"), "Controlled repository\n");
  await run("git", ["add", "README.md"], { cwd: seed });
  await run("git", ["commit", "-m", "Initial fixture"], { cwd: seed });
  await run("git", ["push", bare, "HEAD:refs/heads/main", "HEAD:refs/heads/existing-branch"], {
    cwd: seed,
  });
  await run("git", ["config", "http.receivepack", "true"], { cwd: bare });
  return { bare, seed };
}

async function copyRepositoryTemplate(repository, bare, seed) {
  const pending = repositoryTemplate(repository);
  const template = await pending;
  try {
    // About a millisecond each; fs.promises.cp takes several times as long for the same copy.
    cpSync(template.bare, bare, { recursive: true });
    cpSync(template.seed, seed, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    // The template lives as long as the process; if something swept it from the temporary
    // directory, seed it again once rather than failing every later fixture.
    if (repositoryTemplates.get(repository) === pending) {
      repositoryTemplates.delete(repository);
    }
    rmSync(bare, { recursive: true, force: true });
    rmSync(seed, { recursive: true, force: true });
    const reseeded = await repositoryTemplate(repository);
    cpSync(reseeded.bare, bare, { recursive: true });
    cpSync(reseeded.seed, seed, { recursive: true });
  }
}

// git-http-backend owns the protocol and repository mutation; the fixture only
// supplies CGI framing and a controlled provider authentication check.
/**
 * @param {import("node:test").TestContext} t
 * @param {{authorize?: (authorization: string | undefined, boundary: "git") => boolean,
 *   repository?: string, tls?: Awaited<ReturnType<typeof createTlsMaterial>>,
 *   observeRequest?: (method: string, url: string) => void}} options
 */
export async function startGitSmartHttpFixture(
  t,
  {
    authorize = /** @type {(authorization: string | undefined, boundary: "git") => boolean} */ (
      () => true
    ),
    repository = "fixture/repository",
    tls,
    observeRequest,
  } = {},
) {
  tls ??= await createTlsMaterial(t);
  const directory = await temporaryDirectory(t, "repository-credentials-git-");
  const bare = join(directory, `${repository}.git`);
  const seed = join(directory, "seed");
  await copyRepositoryTemplate(repository, bare, seed);
  const trace = [];
  const children = new Set();
  let disconnectPush = false;
  let heldFetch;
  let requests = 0;
  const server = createServer(tls, (request, response) => {
    requests++;
    observeRequest?.(request.method, request.url);
    if (!authorize(request.headers.authorization, "git")) {
      response.writeHead(401).end();
      return;
    }
    const url = new URL(request.url, "https://fixture.invalid");
    trace.push({
      method: request.method,
      path: url.pathname,
      gitProtocol: request.headers["git-protocol"],
      contentEncoding: request.headers["content-encoding"],
      contentLength: request.headers["content-length"],
    });
    const drop = disconnectPush && url.pathname.endsWith("/git-receive-pack");
    if (drop) {
      disconnectPush = false;
    }
    const child = spawn("git", ["http-backend"], {
      env: cleanEnvironment({
        GIT_PROJECT_ROOT: directory,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        CONTENT_LENGTH: request.headers["content-length"] ?? "",
        HTTP_GIT_PROTOCOL: request.headers["git-protocol"] ?? "",
        REMOTE_USER: "fixture",
        REMOTE_ADDR: "127.0.0.1",
      }),
      stdio: ["pipe", "pipe", "ignore"],
    });
    children.add(child);
    // A single reader owns headers, body, and end, including while a gate is held.
    void (async () => {
      let pending = Buffer.alloc(0);
      let headersSent = false;
      for await (let chunk of child.stdout) {
        if (!headersSent) {
          pending = Buffer.concat([pending, chunk]);
          const end = pending.indexOf("\r\n\r\n");
          if (end < 0) {
            continue;
          }
          const headers = {};
          let status = 200;
          for (const line of pending.subarray(0, end).toString().split("\r\n")) {
            const colon = line.indexOf(":");
            const key = line.slice(0, colon).toLowerCase();
            const value = line.slice(colon + 1).trim();
            if (key === "status") {
              status = Number(value.split(" ")[0]);
            } else {
              headers[key] = value;
            }
          }
          headersSent = true;
          const hold = url.pathname.endsWith("/git-upload-pack") ? heldFetch : undefined;
          if (hold) {
            heldFetch = undefined;
          }
          if (!hold?.beforeHeaders) {
            response.writeHead(status, headers);
          }
          if (hold) {
            if (!hold.beforeHeaders) {
              response.flushHeaders();
            }
            hold.started();
            await hold.released;
            if (hold.beforeHeaders && !response.destroyed) {
              response.writeHead(status, headers);
            }
          }
          if (response.destroyed) {
            return;
          }
          if (drop) {
            response.flushHeaders();
          }
          chunk = pending.subarray(end + 4);
        }
        if (!drop && !response.write(chunk)) {
          await new Promise((resolve) => {
            const done = () => {
              response.off("drain", done);
              response.off("close", done);
              resolve();
            };
            response.once("drain", done);
            response.once("close", done);
          });
          if (response.destroyed) {
            return;
          }
        }
      }
      if (drop) {
        response.destroy();
      } else if (!response.destroyed) {
        response.end();
      }
    })().catch(() => response.destroy());
    request.pipe(child.stdin);
    child.stdin.on("error", () => {});
    child.on("error", () => response.destroy());
    child.once("close", () => children.delete(child));
    response.once("close", () => {
      if (!drop && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    });
  });
  // Count new transport attempts as well as complete HTTP requests, including rejected ones.
  let connections = 0;
  server.on("connection", () => {
    connections++;
  });
  const origin = await listen(t, server);
  t.after(() => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
  });
  return {
    origin,
    tls,
    repository,
    bare,
    trace,
    traffic: () => ({ connections, requests }),
    holdNextFetch({ beforeHeaders = false } = {}) {
      let started;
      let release;
      const observed = new Promise((resolve) => {
        started = resolve;
      });
      const released = new Promise((resolve) => {
        release = resolve;
      });
      heldFetch = { started, released, beforeHeaders };
      return { observed, release };
    },
    disconnectAfterNextAcceptedPush() {
      disconnectPush = true;
    },
    async addCommit() {
      await run("git", ["commit", "--allow-empty", "-m", "New object for successor fetch"], {
        cwd: seed,
      });
      await run("git", ["push", bare, "HEAD:refs/heads/main"], { cwd: seed });
      return (await run("git", ["rev-parse", "HEAD"], { cwd: seed })).stdout.trim();
    },
    async ref(name) {
      return (await run("git", ["rev-parse", name], { cwd: bare })).stdout.trim();
    },
  };
}
