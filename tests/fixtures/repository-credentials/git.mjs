import { spawn } from "node:child_process";
import { createServer } from "node:https";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cleanEnvironment,
  createTlsMaterial,
  listen,
  run,
  temporaryDirectory,
} from "./process.mjs";

// git-http-backend owns the protocol and repository mutation; the fixture only
// supplies CGI framing and a controlled provider authentication check.
export async function startGitSmartHttpFixture(
  t,
  { authorize = () => true, repository = "fixture/repository", tls } = {},
) {
  tls ??= await createTlsMaterial(t);
  const directory = await temporaryDirectory(t, "repository-credentials-git-");
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
  const trace = [];
  const children = new Set();
  let disconnectPush = false;
  const server = createServer(tls, (request, response) => {
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
    let pending = Buffer.alloc(0);
    let headersSent = false;
    child.stdout.on("data", (chunk) => {
      if (!headersSent) {
        pending = Buffer.concat([pending, chunk]);
        const end = pending.indexOf("\r\n\r\n");
        if (end < 0) {
          return;
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
        response.writeHead(status, headers);
        if (drop) {
          response.flushHeaders();
        }
        headersSent = true;
        chunk = pending.subarray(end + 4);
      }
      if (drop) {
        return;
      }
      if (!response.write(chunk)) {
        child.stdout.pause();
      }
    });
    response.on("drain", () => child.stdout.resume());
    request.pipe(child.stdin);
    child.stdin.on("error", () => {});
    child.on("error", () => response.destroy());
    child.once("close", () => {
      children.delete(child);
      if (drop) {
        response.destroy();
      } else {
        response.end();
      }
    });
    response.once("close", () => {
      if (!drop && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    });
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
    disconnectAfterNextAcceptedPush() {
      disconnectPush = true;
    },
    async ref(name) {
      return (await run("git", ["rev-parse", name], { cwd: bare })).stdout.trim();
    },
  };
}
